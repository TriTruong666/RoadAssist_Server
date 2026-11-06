// Manual development scenarios. Never imported by server startup or database reset.
const { createHash } = require('node:crypto');
const { Op } = require('sequelize');
const config = require('../config/app.config');
const db = require('../config/postgres.config');
const redis = require('../config/redis.config');
const { User, Provider, VehicleProfile, DispatchTicket, Bill, SavedPlace, HazardFlag } = require('../models');
const Vehicles = require('../services/vehicle.service');
const Providers = require('../services/provider.service');
const Dispatch = require('../services/dispatch.service');
const Payments = require('../services/payment.service');
const Ratings = require('../services/rating.service');
const Flags = require('../services/flag.service');
const Chat = require('../services/chat.service');

const password = 'RoadAssistTest@123';
const context = { ipAddress: '127.0.0.1', userAgent: 'RoadAssist scenario seed' };
const center = { latitude: 10.7769, longitude: 106.7009 };
function key(name) {
  const hex = createHash('sha256').update(`roadassist-scenarios-v1:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function account(handle, name, phone, options = {}) {
  const email = `${handle}@scenario.roadassist.test`;
  const [user] = await User.findOrCreate({ where: { email }, defaults: {
    userId: key(`user:${handle}`), name, email, password, phone,
    role: options.role || 'guest', emailVerifiedAt: new Date(),
    onboarded: options.onboarded !== false, approved: options.approved !== false,
    status: 'ACTIVE',
  } });
  if (user.userId !== key(`user:${handle}`)) throw new Error(`Tài khoản trùng email: ${email}`);
  return user;
}
async function vehicle(user, plate, type, modelName) {
  return (await VehicleProfile.findOne({ where: { userId: user.userId, plateNumber: plate } })) ||
    Vehicles.create(user.userId, { plateNumber: plate, type, brand: type === 'CAR' ? 'Isuzu' : 'Honda', modelName, color: 'Trắng', length: type === 'CAR' ? 6 : 1.85, weightKg: type === 'CAR' ? 3500 : 110 });
}
async function provider(user, kind, name, position, linkedVehicle) {
  let row = await Provider.findOne({ where: { userId: user.userId, kind } });
  const created = !row;
  if (!row) {
    const result = await Providers.registerProvider(user, {
      kind, name, phone: user.phone, ...position,
      address: kind === 'SHOP' ? 'Nguyễn Huệ, Quận 1, TP.HCM' : 'Trung tâm Quận 1, TP.HCM',
      supportedVehicleTypes: ['BIKE', 'CAR'], serviceSegments: ['SOLO_BIKE', 'CAR'],
      capabilities: kind === 'TOW' ? ['TOWING'] : ['TYRE_REPAIR', 'BATTERY_JUMPSTART', 'ENGINE_REPAIR'],
      maxConcurrentJobs: kind === 'SHOP' ? 12 : 1, confirmNearby: true,
      ...(linkedVehicle && { vehicleProfileId: linkedVehicle.id, licenseNumber: 'GPLX-TINH-HUONG-2026' }),
      ...(kind === 'TOW' && { towMaxWeightKg: 5000, towMaxWidth: 2.5, towMaxHeight: 3, towMaxLength: 7, towMethods: ['FLATBED'] }),
    }, context);
    row = await Provider.findByPk(result.provider.id);
  }
  if (created && row.status === 'ACTIVE' && !row.accepting) {
    await Providers.toggleDuty(user, row.id, { accepting: true, ...(kind !== 'SHOP' && { ...position, accuracy: 10, recordedAt: new Date().toISOString() }) }, context);
    await row.reload();
  }
  await user.reload();
  return row;
}
async function ticket(rider, name, type, fields) {
  const clientRequestId = key(`ticket:${name}`);
  const old = await DispatchTicket.findOne({ where: { userId: rider.userId, clientRequestId } });
  if (old) return Dispatch.dto(old);
  return Dispatch.create(rider, type, { clientRequestId, ...fields });
}
async function move(actor, ticketDto, action, fields = {}) {
  return Dispatch.action(actor, ticketDto.id, action, { expectedRevision: ticketDto.revision, ...fields });
}
async function accept(owner, profile, t) {
  return t.status === '1' ? Dispatch.accept(owner, t.id, { providerId: profile.id, expectedRevision: t.revision }) : t;
}
async function shopTicket(rider, owner, shop, name, stage, description, amount) {
  let t = await ticket(rider, name, 'WALK_IN', {
    providerId: shop.id, incidentVehicle: { type: 'BIKE' }, description,
    requiredCapabilities: ['TYRE_REPAIR'],
    location: { ...center, accuracy: 10, recordedAt: new Date().toISOString() },
  });
  if (stage === 'PENDING') return t;
  t = await accept(owner, shop, t);
  if (stage === 'MATCHED') return t;
  if (t.status === '2') t = await move(owner, t, 'in-shop');
  if (stage === 'IN_SHOP') return t;
  if (t.status === '10') t = await move(owner, t, 'quote', { amount });
  return t;
}
async function seed() {
  if (config.app.env !== 'development' || config.app.isProduction)
    throw new Error('Chỉ tạo dữ liệu tình huống trong môi trường development');
  await db.authenticate();
  if (redis.status === 'wait') await redis.connect();
  const existingGuest = await User.findOne({ where: { role: 'guest', approved: true, onboarded: true, status: 'ACTIVE', emailVerifiedAt: { [Op.ne]: null }, email: { [Op.notLike]: '%@scenario.roadassist.test' } }, order: [['createdAt', 'ASC']] });
  if (!existingGuest) throw new Error('Cần ít nhất một tài khoản khách hiện có, đã được duyệt');
  const shopOwner = await account('cuahang', 'Nguyễn Thị Lan', '0900899101');
  const mobileOwner = await account('luudong', 'Trần Minh Khang', '0900899102');
  const towOwner = await account('xekeoduyet', 'Lê Quốc Bảo', '0900899103', { approved: false });
  const secondRider = await account('khachhang', 'Phạm Hoài An', '0900899104');
  const pendingGuest = await account('choduyet', 'Võ Thanh Hà', '0900899105', { approved: false });
  const setupGuest = await account('chuathietlap', 'Đặng Mai Linh', '0900899106', { onboarded: false, approved: false });
  const mobileBike = await vehicle(mobileOwner, '59-B1 899.02', 'BIKE', 'Wave RSX');
  const towTruck = await vehicle(towOwner, '51-C 899.03', 'CAR', 'Xe sàn cứu hộ');
  const shop = await provider(shopOwner, 'SHOP', 'Tiệm sửa xe An Tâm', center);
  const mobilePoint = { latitude: 10.7801, longitude: 106.704 };
  const mobile = await provider(mobileOwner, 'MOBILE_SHOP', 'Cứu hộ lưu động Minh Khang', mobilePoint, mobileBike);
  await provider(towOwner, 'TOW', 'Xe kéo Quốc Bảo', { latitude: 10.773, longitude: 106.697 }, towTruck);

  // These requests use an incident vehicle snapshot: a guest does not register a vehicle.
  await shopTicket(existingGuest, shopOwner, shop, 'shop-pending', 'PENDING', 'Xe bị thủng lốp trước, đang chờ tiệm nhận');
  await shopTicket(existingGuest, shopOwner, shop, 'shop-matched', 'MATCHED', 'Đã đến tiệm, đang chờ kiểm tra');
  await shopTicket(existingGuest, shopOwner, shop, 'shop-inspection', 'IN_SHOP', 'Tiệm đang kiểm tra bánh sau');
  const quoted = await shopTicket(existingGuest, shopOwner, shop, 'shop-quoted', 'QUOTED', 'Thay lốp sau, chờ khách duyệt báo giá', 220000);
  if (quoted.status === '9') {
    await Chat.send(existingGuest, 'DISPATCH', quoted.id, { clientMessageId: key('chat:rider'), content: 'Anh kiểm tra giúp em lốp sau, xe xuống hơi nhanh.' });
    await Chat.send(shopOwner, 'DISPATCH', quoted.id, { clientMessageId: key('chat:shop'), content: 'Lốp bị rách hông, em đã gửi báo giá để anh xem.' });
    const bill = await require('../services/bill.service').forTicket(quoted);
    if (bill) await Payments.create(existingGuest, 'CASH', { billId: bill.id, ticketId: quoted.id, clientRequestId: key('payment:shop-quoted') });
  }
  let completed = await shopTicket(secondRider, shopOwner, shop, 'shop-completed', 'QUOTED', 'Thay lốp xe và kiểm tra áp suất', 120000);
  if (completed.status === '9') {
    const bill = await require('../services/bill.service').forTicket(completed);
    if (bill) await Payments.create(secondRider, 'CASH', { billId: bill.id, ticketId: completed.id, clientRequestId: key('payment:shop-completed') });
    completed = await move(secondRider, completed, 'approve-quote');
  }
  if (completed.status === '6') completed = await move(shopOwner, completed, 'ready');
  if (completed.status === '7') {
    const bill = await require('../services/bill.service').forTicket(completed);
    const pending = await require('../models').BillPayment.findAll({ where: { billId: bill.id, method: 'CASH', status: 'PENDING' } });
    for (const payment of pending) await Payments.confirmCash(shopOwner, payment.id);
    completed = await move(secondRider, completed, 'resolve');
  }
  if (completed.status === '4') await Ratings.submit(secondRider, { ticketId: completed.id, stars: 5, content: 'Sửa nhanh, báo giá rõ ràng.' });

  let cancelled = await ticket(secondRider, 'shop-cancelled', 'WALK_IN', {
    providerId: shop.id, incidentVehicle: { type: 'BIKE' }, description: 'Khách đổi kế hoạch sau khi gửi yêu cầu', requiredCapabilities: ['TYRE_REPAIR'],
    location: { ...center, accuracy: 10, recordedAt: new Date().toISOString() },
  });
  if (cancelled.status === '1') await Dispatch.cancel(secondRider, cancelled.id, { expectedRevision: cancelled.revision, reason: 'Khách đã tự xử lý' });
  let sos = await ticket(existingGuest, 'sos-matched', 'SOS', {
    incidentVehicle: { type: 'BIKE' }, pickupLatitude: mobilePoint.latitude, pickupLongitude: mobilePoint.longitude,
    pickupAddress: 'Lê Thánh Tôn, Quận 1, TP.HCM', requiredCapabilities: ['BATTERY_JUMPSTART'], description: 'Xe hết bình, cần kích điện',
  });
  if (sos.status === '1') await accept(mobileOwner, mobile, sos);
  await ticket(existingGuest, 'tow-pending', 'TOW', {
    incidentVehicle: { type: 'CAR', length: 4.5, weightKg: 1500, width: 1.8, height: 1.5 },
    pickupLatitude: 10.774, pickupLongitude: 106.699, pickupAddress: 'Hàm Nghi, Quận 1, TP.HCM',
    dropoffShopId: shop.id, requiredCapabilities: ['ENGINE_REPAIR'], description: 'Ô tô chết máy, cần kéo về tiệm',
  });
  for (const [index, [category, description]] of [
    ['FLOOD', 'Đường ngập nhẹ sau mưa, nên đi chậm'],
    ['ACCIDENT', 'Va chạm giao thông gần giao lộ'],
    ['OBSTRUCTION', 'Công trình chiếm một phần làn đường'],
  ].entries()) {
    const existing = await HazardFlag.findOne({ where: { userId: existingGuest.userId, description, status: { [Op.ne]: '4' }, expiresAt: { [Op.gt]: new Date() } } });
    if (!existing) await Flags.create(existingGuest, { category, description, latitude: center.latitude + (index - 1) * 0.003, longitude: center.longitude + 0.004, address: 'Quận 1, TP.HCM', radiusMeters: 50, ttlMinutes: 1440 });
  }
  for (const user of [existingGuest, secondRider]) for (const [name, category, latitude, longitude] of [
    ['Nhà', 'HOME', 10.771, 106.698], ['Cơ quan', 'WORK', 10.783, 106.706],
  ]) await SavedPlace.findOrCreate({ where: { userId: user.userId, name }, defaults: { category, latitude, longitude, address: 'Quận 1, TP.HCM' } });
  const result = { existingGuest: existingGuest.email, scenarioAccounts: [shopOwner, mobileOwner, towOwner, secondRider, pendingGuest, setupGuest].map(u => u.email), password,
    accounts: await User.count(), providers: await Provider.count(), tickets: await DispatchTicket.count(), hazards: await HazardFlag.count() };
  console.log(JSON.stringify(result, null, 2));
  return result;
}
module.exports = { seed };
