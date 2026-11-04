const { Op, literal } = require('sequelize');
const sequelize = require('../config/postgres.config');
const { HazardFlag: Flag, HazardVote: Vote, HazardImage: Image, HazardMessage: Message, User } = require('../models');
const { BaseException, NotFoundException, ForbiddenException, ConflictException } = require('../common/exceptions/BaseException');
const { FLAG_CONSENSUS_THRESHOLD, REPUTATION_REWARD } = require('../common/flag.constants');
const active = () => ({ status: { [Op.ne]: '4' }, expiresAt: { [Op.gt]: new Date() } });
function live(flag) { if (flag.status === '4' || flag.expiresAt <= new Date()) throw new ConflictException('Cảnh báo đã đóng hoặc hết hạn'); }
function dto(flag) {
 const data = flag.toJSON();
 if (data.expiresAt <= new Date() && data.status !== '4') { data.status = '4'; data.removedReason = 'EXPIRED'; }
 delete data.userId; delete data.reputationAwardedAt;
 return data;
}
class FlagService {
 static async create(actor, data, files = []) {
  const images = await require('../middlewares/upload.middleware').compress(files);
  return require('./s3.service').withUploads(keys => sequelize.transaction(async transaction => {
   // Serialize per-account quotas, independently of concurrent HTTP requests.
   await User.findOne({ where: { userId: actor.userId }, transaction, lock: transaction.LOCK.UPDATE });
   if (await Flag.count({ where: { userId: actor.userId, ...active() }, transaction }) >= 20) throw new ConflictException('Tối đa 20 cảnh báo đang hoạt động');
   const flag = await Flag.create({ ...data, userId: actor.userId, expiresAt: new Date(Date.now() + (data.ttlMinutes ?? 120) * 60000) }, { transaction });
   for (const image of images) {
    const upload = await require('./s3.service').upload({ body:image.content, mimeType:image.mimeType, originalName:'hazard.webp', userId:actor.userId, transaction, attachedTo:`hazard:${flag.id}`, keys });
    await Image.create({ flagId:flag.id, mimeType:image.mimeType, size:image.size, s3Key:upload.key, url:upload.url }, { transaction });
   }
   return this.detail(flag.id, transaction);
  }));
 }
 static async detail(id, transaction) {
  const flag = await Flag.findByPk(id, { transaction }); if (!flag) throw new NotFoundException();
  const images = await Image.findAll({ where: { flagId: id }, attributes: ['id','size','mimeType','url'], transaction, order: [['createdAt','ASC']] });
  return { ...dto(flag), images: images.map(image => ({ ...image.toJSON(), url: image.url || `/api/v1/flags/${id}/images/${image.id}` })) };
 }
 static async nearby({ latitude, longitude, limit = 100 }) {
  // SQL applies exact spherical distance before LIMIT, including poles and the antimeridian.
  const distance = require('../utils/geo.util').distanceSql(latitude, longitude).replaceAll('"Provider"', '"HazardFlag"');
  const rows = await Flag.findAll({ where: { ...active(), [Op.and]: literal(`(${distance}) <= 2000`) }, attributes: { include: [[literal(distance), 'distanceMeters']] }, order: [[literal('"distanceMeters"'), 'ASC'], ['id','ASC']], limit });
  return rows.map(dto);
 }
 static async mine(actor, { limit = 50, offset = 0 }) {
  const result = await Flag.findAndCountAll({ where: { userId: actor.userId }, limit, offset, order: [['createdAt','DESC'], ['id','DESC']] });
  return { total: result.count, items: result.rows.map(dto) };
 }
 static async mutate(actor, id, action, voteType) {
  return sequelize.transaction(async transaction => {
   // User before flag follows auth/account locking order and serializes reputation updates.
   if (action === 'vote') {
    const initial = await Flag.findByPk(id, { transaction }); if (!initial) throw new NotFoundException();
    await User.findOne({ where: { userId: initial.userId }, transaction, lock: transaction.LOCK.UPDATE });
   }
   const flag = await Flag.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }); if (!flag) throw new NotFoundException();
   if (action === 'remove' && actor.role !== 'admin') throw new ForbiddenException();
   if (action === 'unflag' && (flag.userId !== actor.userId || flag.status === '3')) throw new ForbiddenException();
   if (['lock','unlock'].includes(action) && actor.role !== 'admin') throw new ForbiddenException();
   if (action === 'remove' || action === 'unflag') {
    if (flag.status !== '4') await flag.update({ status: '4', removedReason: action === 'remove' ? 'ADMIN' : 'AUTHOR' }, { transaction });
   } else {
    live(flag);
    if (action === 'unlock') {
     if (flag.status !== '3') throw new ConflictException('Chỉ mở khóa cảnh báo đang khóa');
     await flag.update({ status: '2' }, { transaction });
    } else if (action === 'lock') {
     if (flag.status !== '2') throw new ConflictException('Chỉ khóa cảnh báo đã được xác nhận');
     await flag.update({ status: '3' }, { transaction });
    } else {
     if (flag.userId === actor.userId) throw new ForbiddenException('Không được tự bình chọn');
     if (flag.status !== '1') throw new ConflictException('Đã đóng bình chọn');
     if (await Vote.findOne({ where: { flagId: id, userId: actor.userId }, transaction })) throw new ConflictException('Bạn đã bình chọn');
     await Vote.create({ flagId: id, userId: actor.userId, voteType }, { transaction });
     flag[voteType === 'CONFIRM' ? 'confirmVotes' : 'denyVotes']++;
     if (flag.confirmVotes >= FLAG_CONSENSUS_THRESHOLD) {
      flag.status = '2';
      if (!flag.reputationAwardedAt) { await User.increment('reputationPoints', { by: REPUTATION_REWARD, where: { userId: flag.userId }, transaction }); flag.reputationAwardedAt = new Date(); }
     } else if (flag.denyVotes >= FLAG_CONSENSUS_THRESHOLD && flag.denyVotes > flag.confirmVotes) { flag.status = '4'; flag.removedReason = 'CONSENSUS_DENIED'; }
     await flag.save({ transaction });
     if (flag.status === '2')
      await require('./admin_alert.service').enqueue('HAZARD_CONFIRMED', flag.id, flag.id,
       `${flag.category === 'FLOOD' ? 'Ngập nước' : flag.category === 'ACCIDENT' ? 'Tai nạn' : 'Vật cản'} · ${flag.address || flag.description || 'Báo cáo cộng đồng'}`, transaction);
    }
   }
   return dto(flag);
  });
 }
 static async expire() {
  const [count] = await Flag.update({ status: '4', removedReason: 'EXPIRED' }, { where: { status: { [Op.ne]: '4' }, expiresAt: { [Op.lte]: new Date() } } });
  return count;
 }
 static async messages(id, options = {}, actor) {
  const data = await require('./chat.service').list(actor, 'HAZARD', id, options);
  return data.items.map(message => ({ ...message, flagId: id, text: message.content }));
 }
 static async message(actor, id, text) {
  const message = await require('./chat.service').send(actor, 'HAZARD', id, { content: text });
  return { ...message, flagId: id, text: message.content };
 }
 static async image(id, imageId) {
  const image = await Image.unscoped().findOne({ where: { id: imageId, flagId: id } }); if (!image) throw new NotFoundException(); return image;
 }
}
module.exports = FlagService;
