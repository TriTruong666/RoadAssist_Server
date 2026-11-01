const path = require('node:path');
const { createHash } = require('node:crypto');
const { Op } = require('sequelize');
const sequelize = require('../config/postgres.config');
const ProviderService = require('./provider.service');
const Audit = require('./provider_audit.service');
const { DOCUMENT_TYPES } = require('../common/provider.constants');
const { BadRequestException, ForbiddenException, NotFoundException, ConflictException } = require('../common/exceptions/BaseException');
const errors = require('../common/exceptions/error_codes');
const META = ['id', 'providerId', 'documentType', 'mimeType', 'originalName', 'size', 'sha256', 'subjectFingerprint', 'withdrawnAt', 'createdAt'];
function detectMime(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
class ProviderDocumentService {
  static async authorize(actor, id) {
    const profile = await sequelize.models.Provider.findByPk(id);
    if (!profile || (profile.userId !== actor.userId && actor.role !== 'admin')) throw new NotFoundException(errors.PROVIDER_NOT_FOUND);
    if (actor.role === 'admin') await ProviderService.admin(actor);
    return profile;
  }
  static required(kind) { return kind === 'SHOP' ? ['BUSINESS_DOCUMENT'] : ['LICENSE_PHOTO', 'VEHICLE_PHOTO']; }
  static async fingerprint(profile, type, transaction) {
    const vehicle = profile.vehicleProfileId ? await sequelize.models.VehicleProfile.findByPk(profile.vehicleProfileId, { transaction }) : null;
    const data = type === 'LICENSE_PHOTO' ? [profile.licenseNumber] : type === 'BUSINESS_DOCUMENT' ? [profile.name, profile.address] :
      [profile.vehicleProfileId, profile.plateNumber, vehicle?.type, vehicle?.baseWidth, vehicle?.baseHeight, vehicle?.brand, vehicle?.modelName];
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }
  static async assertComplete(profile, transaction) {
    const documents = await sequelize.models.ProviderDocument.findAll({ where: { providerId: profile.id, withdrawnAt: null }, attributes: ['documentType', 'subjectFingerprint'], transaction });
    const missing = [];
    for (const type of this.required(profile.kind)) {
      const fingerprint = await this.fingerprint(profile, type, transaction);
      if (!documents.some(document => document.documentType === type && document.subjectFingerprint === fingerprint)) missing.push(type);
    }
    if (missing.length) throw new ConflictException(errors.PROVIDER_EVIDENCE_REQUIRED, { missing });
  }
  static async list(actor, id) {
    const profile = await this.authorize(actor, id);
    const documents = await sequelize.models.ProviderDocument.findAll({ where: { providerId: id }, attributes: META, order: [['createdAt', 'DESC']] });
    return Promise.all(documents.map(async document => ({ ...document.toJSON(), currentForProfile: !document.withdrawnAt && document.subjectFingerprint === await this.fingerprint(profile, document.documentType) })));
  }
  static async content(actor, id, documentId) {
    await this.authorize(actor, id);
    const document = await sequelize.models.ProviderDocument.unscoped().findOne({ where: { id: documentId, providerId: id } });
    if (!document) throw new NotFoundException();
    return document;
  }
  static async upload(actor, id, documentType, file, context) {
    if (!file || !DOCUMENT_TYPES.includes(documentType)) throw new BadRequestException('Cần ảnh và loại giấy tờ hợp lệ');
    const mimeType = detectMime(file.buffer);
    if (!mimeType || mimeType !== file.mimetype || file.size > 5 * 1024 * 1024) throw new BadRequestException('Chỉ nhận ảnh JPEG, PNG hoặc WebP tối đa 5MB');
    return ProviderService.mutate(actor, id, async ({ profile, vehicle, transaction }) => {
      if (profile.userId !== actor.userId) throw new ForbiddenException();
      if (profile.status === 'REVOKED') throw new ConflictException(errors.PROVIDER_INVALID_TRANSITION);
      await ProviderService.assertIdle(profile, vehicle, transaction);
      const Document = sequelize.models.ProviderDocument;
      const subjectFingerprint = await this.fingerprint(profile, documentType, transaction);
      const sha256 = createHash('sha256').update(file.buffer).digest('hex');
      const duplicate = await Document.findOne({ where: { providerId: id, documentType, subjectFingerprint, sha256, withdrawnAt: null }, transaction, attributes: META });
      if (duplicate) return { document: duplicate.toJSON(), duplicate: true, provider: profile.toJSON() };
      const reused = await Document.findOne({ where: { providerId: id, documentType, sha256, subjectFingerprint: { [Op.ne]: subjectFingerprint } }, transaction, attributes: ['id'] });
      if (reused) throw new ConflictException(errors.PROVIDER_EVIDENCE_STALE_UPLOAD);
      const ownerProfiles = await sequelize.models.Provider.findAll({ where: { userId: profile.userId }, attributes: ['id'], transaction });
      const ownerScope = { providerId: { [Op.in]: ownerProfiles.map(row => row.id) } };
      if (await Document.count({ where: ownerScope, transaction }) >= 200 || Number(await Document.sum('size', { where: ownerScope, transaction }) || 0) + file.size > 200 * 1024 * 1024) throw new ConflictException(errors.PROVIDER_DOCUMENT_QUOTA_EXCEEDED);
      const total = await Document.count({ where: { providerId: id }, transaction });
      const active = await Document.count({ where: { providerId: id, withdrawnAt: null }, transaction });
      const size = Number(await Document.sum('size', { where: { providerId: id }, transaction }) || 0);
      if (total >= 50 || active >= 10 || size + file.size > 100 * 1024 * 1024) throw new ConflictException(errors.PROVIDER_DOCUMENT_QUOTA_EXCEEDED);
      const before = await Audit.snapshot(profile.get(), transaction);
      const document = await Document.create({ providerId: id, documentType, mimeType, originalName: path.basename(file.originalname).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) || 'document',
        subjectFingerprint, size: file.size, sha256, content: file.buffer }, { transaction });
      await profile.update({ profileRevision: profile.profileRevision + 1, ...(profile.status === 'ACTIVE' ? { status: 'PENDING', requiresApproval: true, accepting: false } : {}) },
        { transaction, auditAction: 'DOCUMENT_UPLOADED', auditBefore: before });
      return { document: Object.fromEntries(META.map(field => [field, document.get(field)])), provider: profile.toJSON() };
    }, context);
  }
  static async withdraw(actor, id, documentId, context) {
    return ProviderService.mutate(actor, id, async ({ profile, vehicle, transaction }) => {
      if (profile.userId !== actor.userId) throw new ForbiddenException();
      if (profile.status === 'REVOKED') throw new ConflictException(errors.PROVIDER_INVALID_TRANSITION);
      await ProviderService.assertIdle(profile, vehicle, transaction);
      const document = await sequelize.models.ProviderDocument.findOne({ where: { id: documentId, providerId: id, withdrawnAt: null }, transaction, lock: transaction.LOCK.UPDATE });
      if (!document) throw new NotFoundException();
      const before = await Audit.snapshot(profile.get(), transaction);
      await document.update({ withdrawnAt: new Date() }, { transaction });
      await profile.update({ profileRevision: profile.profileRevision + 1, ...(profile.status === 'ACTIVE' ? { status: 'PENDING', requiresApproval: true, accepting: false } : {}) }, { transaction, auditAction: 'DOCUMENT_WITHDRAWN', auditBefore: before });
      return { withdrawn: true, provider: profile.toJSON() };
    }, context);
  }
  static async history(actor, id, { page = 1, limit = 50 } = {}) {
    await this.authorize(actor, id);
    const result = await sequelize.models.ProviderAuditLog.findAndCountAll({ where: { providerId: id }, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit, offset: (page - 1) * limit });
    return { items: result.rows, total: result.count, page, limit };
  }
}
module.exports = ProviderDocumentService;
module.exports.detectMime = detectMime;
