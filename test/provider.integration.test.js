const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
if (process.env.RUN_DB_TESTS !== '1') {
  test('Phase 3 PostgreSQL/Redis integration (RUN_DB_TESTS=1)', { skip: true }, () => {});
} else {
  const suffix = randomUUID().replaceAll('-', '');
  Object.assign(process.env, { NODE_ENV: 'test', DB_SCHEMA: `phase3_test_${suffix}`, PROVIDER_REDIS_PREFIX: `test:${suffix}:providers:`,
    AUTH_REDIS_PREFIX: `test:${suffix}:auth:`, JWT_SECRET: randomUUID() + randomUUID(), ALLOWED_CLIENT_URL_1: 'http://localhost:5173' });
  const { app } = require('../index');
  const sequelize = require('../src/config/postgres.config');
  const redis = require('../src/config/redis.config');
  const { User, Provider, ProviderLocationHistory, VehicleProfile } = require('../src/models');
  const Auth = require('../src/services/auth.service');
  const Service = require('../src/services/provider.service');
  const Location = require('../src/services/location.service');
  const { DataTypes } = require('sequelize');
  let server, base, owner, other, admin, bike, car, otherCar, shop, mobile, tow, otherShop;
  const clients = new Map();
  const password = 'Phase3-test-password!';
  const origin = { latitude: 10.77, longitude: 106.69 };
  const distant = { latitude: 11.1, longitude: 106.7 };
  const business = (kind, extra = {}) => ({ kind, capabilities: [kind === 'TOW' ? 'TOWING' : 'TYRE_REPAIR'], supportedVehicleTypes: ['BIKE', 'CAR'], ...(kind === 'TOW' ? { towMaxWeightKg: 3500, towMaxWidth: 2.5, towMaxHeight: 3, towMaxLength: 6, towMethods: ['FLATBED'] } : {}), name: `Provider ${kind}`, phone: '0901234567', address: 'Test address', ...origin,
    ...(kind === 'SHOP' ? { serviceSegments: ['SOLO_BIKE', 'CAR'], openHours: { MON: '22:00-05:00' } } : { licenseNumber: 'LICENSE-123' }), ...extra });
  async function client(n, role = 'guest') {
    const user = await User.create({ email: `phase3-${n}@example.com`, password, phone: `09000000${String(n).padStart(2, '0')}`, name: `User ${n}`, role, emailVerifiedAt: new Date() });
    const session = await Auth.completeLogin({ userId: user.userId, ipAddress: '127.0.0.1' });
    const result = { userId: user.userId, email: user.email, token: session.token, refreshToken: session.refreshToken, role };
    clients.set(user.userId, result); return result;
  }
  async function request(actor, method, path, body) {
    if (body && (path === '/providers/location' || path.endsWith('/toggle-duty')) && body.latitude !== undefined && !Object.hasOwn(body, 'accuracy')) body = { ...body, accuracy: 10 };
    const response = await fetch(base + '/api/v1' + path, { method, headers: { ...(actor?.token && { Cookie: `road_as_token=${actor.token}` }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.equal(result.data?.session, undefined, 'Internal sessions must never leak into JSON');
    assert.equal(result.data?.token, undefined);
    for (const value of response.headers.getSetCookie()) {
      if (actor && value.startsWith('road_as_token=')) actor.token = value.split(';')[0].slice('road_as_token='.length);
      if (actor && value.startsWith('road_as_refresh_token=')) actor.refreshToken = value.split(';')[0].slice('road_as_refresh_token='.length);
    }
    return { status: response.status, body: result, headers: response.headers };
  }
  async function ok(actor, method, path, body, expected = 200) {
    if (method === 'PUT' && path.endsWith('/approve') && expected === 200) { await ensureEvidence(path.split('/')[3]); body = { ...body, reason: 'Đã kiểm tra ảnh và thông tin hồ sơ' }; }
    const result = await request(actor, method, path, body);
    assert.equal(result.status, expected, JSON.stringify(result.body));
    return result.body.data;
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  async function uploadProof(actor, id, type) {
    const form = new FormData(); form.set('documentType', type); form.set('file', new Blob([Buffer.concat([png, Buffer.from(randomUUID())])], { type: 'image/png' }), 'proof.png');
    const response = await fetch(base + '/api/v1/providers/' + id + '/documents', { method: 'POST', headers: { Cookie: `road_as_token=${actor.token}` }, body: form });
    const data = await response.json(); assert.equal(response.status, 201, JSON.stringify(data));
    for (const cookie of response.headers.getSetCookie()) if (cookie.startsWith('road_as_token=')) actor.token = cookie.split(';')[0].slice('road_as_token='.length);
    return data.data.document;
  }
  async function ensureEvidence(id) {
    const profile = await Provider.findByPk(id);
    const Documents = require('../src/services/provider_document.service');
    try { await Documents.assertComplete(profile); }
    catch (error) {
      if (error.errorCode !== 'PROVIDER_EVIDENCE_REQUIRED') throw error;
      for (const type of error.details.missing) await uploadProof(clients.get(profile.userId), id, type);
    }
  }
  async function login(actor) { await ok(actor, 'POST', '/auth/login', { email: actor.email, password }); }
  async function vehicle(actor, type, plateNumber) {
    return ok(actor, 'POST', '/vehicles', { type, plateNumber, brand: type === 'CAR' ? 'Toyota' : 'Honda', modelName: 'Test model' }, 201);
  }
  before(async () => {
    await sequelize.authenticate(); await sequelize.createSchema(process.env.DB_SCHEMA); await sequelize.sync(); await redis.connect();
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    owner = await client(1); other = await client(2); admin = await client(3, 'admin');
    bike = await vehicle(owner, 'BIKE', '59a-123.45'); car = await vehicle(owner, 'CAR', '30a-123.45'); otherCar = await vehicle(other, 'CAR', '30b-678.90');
  });
  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const prefix of [process.env.PROVIDER_REDIS_PREFIX, process.env.AUTH_REDIS_PREFIX]) { const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys); }
    redis.disconnect(); await sequelize.dropSchema(process.env.DB_SCHEMA, { cascade: true }); await sequelize.close();
  });
  test('cookie authentication and strict DTOs protect provider/admin endpoints', async () => {
    assert.equal((await request(null, 'POST', '/providers', business('SHOP'))).status, 401);
    assert.equal((await request(owner, 'GET', '/admin/providers/pending-tows')).status, 403);
    assert.equal((await request(owner, 'POST', '/providers', business('SHOP', { openHours: { MON: '24:00-05:00' } }))).status, 400);
    assert.equal((await request(owner, 'POST', '/providers/search', { ...origin, radiusKm: 51 })).status, 400);
    assert.equal((await request(owner, 'POST', '/providers/search', { latitude: "0); DROP TABLE users;--", longitude: 0 })).status, 400);
    assert.equal(await User.count(), 3);
  });
  test('SHOP auto-approval grants service and replacement cookies; overnight hours are informational', async () => {
    const token = owner.token;
    shop = (await ok(owner, 'POST', '/providers', business('SHOP', { status: 'DENIED', ratingAvg: 0, suspended: true }), 201)).provider;
    assert.equal(shop.status, 'ACTIVE'); assert.equal(shop.suspended, false); assert.equal(shop.ratingAvg, 5); assert.equal(shop.accepting, false);
    assert.notEqual(owner.token, token);
    const me = await ok(owner, 'GET', '/users/me');
    assert.equal(me.role, 'provider'); assert.deepEqual(me.services, ['RIDER', 'SHOP']);
    await ok(owner, 'POST', `/providers/${shop.id}/toggle-duty`, { accepting: true });
    assert.equal(await ProviderLocationHistory.count(), 0);
    assert.equal((await ok(null, 'POST', '/providers/search', { ...origin, kinds: ['SHOP'], acceptingOnly: true })).length, 1);
    assert.equal(await redis.zscore(Location.geoKey, shop.id), null);
  });
  test('mobile/tow profiles require owned active vehicles and normalized matching VN plates', async () => {
    assert.equal((await request(owner, 'POST', '/providers', business('TOW', { vehicleProfileId: bike.id }))).status, 400);
    assert.equal((await request(owner, 'POST', '/providers', business('TOW', { vehicleProfileId: otherCar.id }))).status, 404);
    assert.equal((await request(owner, 'POST', '/providers', business('TOW', { vehicleProfileId: car.id, plateNumber: '30A99999' }))).status, 400);
    const withoutLicense = business('MOBILE_SHOP', { vehicleProfileId: bike.id, ...distant }); delete withoutLicense.licenseNumber;
    assert.equal((await request(owner, 'POST', '/providers', withoutLicense)).status, 400);
    mobile = (await ok(owner, 'POST', '/providers', business('MOBILE_SHOP', { vehicleProfileId: bike.id, ...distant }), 201)).provider;
    assert.equal(mobile.plateNumber, '59A12345'); assert.equal(mobile.status, 'ACTIVE');
    tow = (await ok(owner, 'POST', '/providers', business('TOW', { vehicleProfileId: car.id, plateNumber: ' 30a-123.45 ', status: 'ACTIVE' }), 201)).provider;
    assert.equal(tow.status, 'PENDING'); assert.equal(tow.plateNumber, '30A12345');
    assert.equal((await ok(owner, 'GET', '/users/me')).services.includes('TOW'), false);
    assert.equal((await request(owner, 'POST', `/providers/${tow.id}/toggle-duty`, { accepting: true, ...origin })).status, 403);
  });
  test('pending profiles are private, ownership is enforced, and admin approval grants TOW', async () => {
    assert.equal((await request(null, 'GET', `/providers/${tow.id}`)).status, 404);
    assert.equal((await request(other, 'GET', `/providers/${tow.id}`)).status, 404);
    assert.equal((await ok(owner, 'GET', `/providers/${tow.id}`)).licenseNumber, 'LICENSE-123');
    assert.equal((await request(other, 'PUT', `/providers/${tow.id}`, { name: 'Attack' })).status, 404);
    assert.equal((await request(other, 'POST', `/providers/${mobile.id}/location`, origin)).status, 404);
    assert.equal((await request(owner, 'PUT', `/admin/providers/${tow.id}/approve`, {})).status, 403);
    const pending = await ok(admin, 'GET', '/admin/providers/pending-tows?page=1&limit=1');
    assert.equal(pending.total, 1); assert.equal(pending.limit, 1);
    await ok(admin, 'PUT', `/admin/providers/${tow.id}/approve`, {});
    assert.equal((await ok(owner, 'GET', '/users/me')).services.includes('TOW'), true);
    assert.equal((await request(admin, 'PUT', `/admin/providers/${tow.id}/approve`, { reason: 'Kiểm tra trạng thái duyệt lại' })).status, 409);
    const publicTow = await ok(null, 'GET', `/providers/${tow.id}`);
    assert.equal(publicTow.licenseNumber, undefined); assert.equal(publicTow.userId, undefined); assert.equal(publicTow.latitude, null);
    assert.equal((await ok(owner, 'GET', '/providers/me')).length, 3);
  });
  test('nearby registration warns at 300m and explicit confirmation creates a second shop', async () => {
    const body = business('SHOP', { longitude: origin.longitude + 0.001 });
    const warning = await request(other, 'POST', '/providers', body);
    assert.equal(warning.status, 409); assert.equal(warning.body.error_code, 'PROVIDER_LOCATION_CONFIRMATION_REQUIRED');
    assert.equal(warning.body.details.nearby[0].id, shop.id);
    assert.equal(await Provider.count({ where: { userId: other.userId } }), 0);
    const created = await ok(other, 'POST', '/providers', { ...body, confirmNearby: true }, 201);
    otherShop = created.provider; assert.ok(created.nearby.length > 0);
  });
  test('concurrent duplicate registrations permit only one live profile per user and kind', async () => {
    const body = business('MOBILE_SHOP', { vehicleProfileId: otherCar.id, ...distant, longitude: distant.longitude + 0.01 });
    const results = await Promise.all([request(other, 'POST', '/providers', body), request(other, 'POST', '/providers', body)]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    assert.equal(await Provider.count({ where: { userId: other.userId, kind: 'MOBILE_SHOP' } }), 1);
  });
  test('duty activation needs fresh GPS; heartbeat stores SQL history and atomic Redis GEO metadata', async () => {
    assert.equal((await request(owner, 'POST', `/providers/${mobile.id}/toggle-duty`, { accepting: true })).status, 400);
    assert.equal((await request(owner, 'POST', '/providers/location', { providerId: shop.id, ...origin })).status, 403);
    assert.equal((await request(other, 'POST', '/providers/location', { providerId: mobile.id, ...origin })).status, 404);
    const body = { accepting: true, ...origin, recordedAt: new Date(Date.now() - 3000).toISOString(), speed: 2, accuracy: 5 };
    await ok(owner, 'POST', `/providers/${mobile.id}/toggle-duty`, body);
    assert.equal(await ProviderLocationHistory.count({ where: { providerId: mobile.id } }), 1);
    assert.notEqual(await redis.zscore(Location.geoKey, mobile.id), null);
    const meta = await redis.hgetall(Location.metadataKey(mobile.id));
    assert.equal(meta.kind, 'MOBILE_SHOP'); assert.equal(meta.accepting, 'true');
    const ttl = await redis.ttl(Location.metadataKey(mobile.id)); assert.ok(ttl > 0 && ttl <= 900);
    await ok(owner, 'POST', '/providers/location', { providerId: mobile.id, latitude: origin.latitude + 0.0005, longitude: origin.longitude, speed: 3, accuracy: 8 });
    const row = await Provider.findByPk(mobile.id);
    assert.equal(row.latitude, origin.latitude + 0.0005); assert.equal(await ProviderLocationHistory.count({ where: { providerId: mobile.id } }), 2);
    const found = await ok(null, 'POST', '/providers/search', { ...origin, kinds: ['MOBILE_SHOP'], radiusKm: 1, acceptingOnly: true });
    assert.equal(found[0].id, mobile.id); assert.ok(found[0].distanceMeters < 200);
    assert.equal(found[0].licenseNumber, undefined);
  });
  test('invalid, replayed or stale positions never overwrite current GPS/history', async () => {
    const previous = await Provider.findByPk(mobile.id);
    const total = await ProviderLocationHistory.count({ where: { providerId: mobile.id } });
    const stale = await request(owner, 'POST', '/providers/location', { providerId: mobile.id, ...distant, recordedAt: previous.lastLocationRecordedAt.toISOString() });
    assert.equal(stale.status, 409); assert.equal(stale.body.error_code, 'PROVIDER_LOCATION_STALE');
    assert.equal((await request(owner, 'POST', '/providers/location', { providerId: mobile.id, ...distant, recordedAt: '2000-01-01T00:00:00Z' })).status, 409);
    assert.equal((await request(owner, 'POST', '/providers/location', { providerId: mobile.id, latitude: 90, longitude: 106 })).status, 400);
    assert.equal(await ProviderLocationHistory.count({ where: { providerId: mobile.id } }), total);
    assert.equal((await Provider.findByPk(mobile.id)).latitude, previous.latitude);
  });
  test('expired GPS is undiscoverable; fresh SQL positions recover missing or unavailable Redis cache', async t => {
    await Provider.update({ lastHeartbeatAt: new Date(Date.now() - 16 * 60000), lastTrustedLocationAt: new Date(Date.now() - 16 * 60000) }, { where: { id: mobile.id }, individualHooks: true });
    assert.deepEqual(await ok(null, 'POST', '/providers/search', { ...origin, kinds: ['MOBILE_SHOP'], radiusKm: 1 }), []);
    await ok(owner, 'POST', '/providers/location', { providerId: mobile.id, ...origin });
    await redis.del(Location.geoKey, Location.freshnessKey, Location.metadataKey(mobile.id));
    assert.equal((await ok(null, 'POST', '/providers/search', { ...origin, kinds: ['MOBILE_SHOP'], radiusKm: 1 }))[0].id, mobile.id);
    t.mock.method(redis, 'call', async () => { throw new Error('Redis unavailable'); });
    assert.equal((await ok(null, 'POST', '/providers/search', { ...origin, kinds: ['MOBILE_SHOP'], radiusKm: 1 }))[0].id, mobile.id);
  });
  test('duty off removes discovery and public GPS immediately without collecting rider/shop heartbeats', async () => {
    await ok(owner, 'POST', `/providers/${mobile.id}/toggle-duty`, { accepting: false });
    assert.equal(await redis.zscore(Location.geoKey, mobile.id), null);
    const detail = await ok(null, 'GET', `/providers/${mobile.id}`);
    assert.equal(detail.latitude, null); assert.equal(detail.longitude, null);
    const neighbors = await Service.nearbyWarning({ ...origin, kind: 'MOBILE_SHOP', confirmNearby: true });
    assert.equal(neighbors.some(item => item.id === mobile.id), false, 'Duplicate-location warnings must not leak off-duty mobile GPS');
    assert.deepEqual(await ok(null, 'POST', '/providers/search', { ...origin, kinds: ['MOBILE_SHOP'], radiusKm: 1 }), []);
    assert.equal((await request(owner, 'POST', '/providers/location', { providerId: mobile.id, ...origin })).status, 403);
  });
  test('search respects kind, rating, distance and manual duty rather than opening hours', async () => {
    await Provider.update({ ratingAvg: 4.1 }, { where: { id: shop.id }, individualHooks: true });
    await Provider.update({ ratingAvg: 4.8 }, { where: { id: otherShop.id }, individualHooks: true });
    const nearest = await ok(null, 'POST', '/providers/search', { ...origin, kinds: ['SHOP'], radiusKm: 1, limit: 1 });
    assert.equal(nearest[0].id, shop.id);
    const best = await ok(null, 'POST', '/providers/search', { ...origin, kinds: ['SHOP'], radiusKm: 1, sortBy: 'rating', minRating: 4.5 });
    assert.equal(best.length, 1); assert.equal(best[0].id, otherShop.id);
    const accepting = await ok(null, 'POST', '/providers/search', { ...origin, kinds: ['SHOP'], acceptingOnly: true });
    assert.equal(accepting.length, 1); assert.equal(accepting[0].id, shop.id);
  });
  test('changing an approved vehicle removes GEO/grants and makes mobile reapproval visible to admins', async () => {
    await ok(owner, 'POST', `/providers/${mobile.id}/toggle-duty`, { accepting: true, ...origin });
    await ok(owner, 'PUT', `/vehicles/${bike.id}`, { width: 0.9 });
    const row = await Provider.findByPk(mobile.id);
    assert.equal(row.status, 'PENDING'); assert.equal(row.requiresApproval, true); assert.equal(row.accepting, false);
    assert.equal(await redis.zscore(Location.geoKey, mobile.id), null);
    assert.equal((await ok(owner, 'GET', '/users/me')).services.includes('MOBILE_SHOP'), false);
    const pending = await ok(admin, 'GET', '/admin/providers/pending?kind=MOBILE_SHOP');
    assert.equal(pending.items[0].id, mobile.id);
    await ok(admin, 'PUT', `/admin/providers/${mobile.id}/approve`, {});
    assert.equal((await ok(owner, 'GET', '/users/me')).services.includes('MOBILE_SHOP'), true);
  });
  test('deny/resubmit preserves review requirements and never lets the client self-approve', async () => {
    await ok(owner, 'PUT', `/vehicles/${car.id}`, { plateNumber: '30A99999' });
    assert.equal((await request(admin, 'PUT', `/admin/providers/${tow.id}/deny`, {})).status, 400);
    await ok(admin, 'PUT', `/admin/providers/${tow.id}/deny`, { reason: 'Cần bổ sung giấy phép' });
    assert.equal((await request(owner, 'PUT', `/providers/${tow.id}`, { name: 'Change without resubmit' })).status, 409);
    const resubmitted = await ok(owner, 'PUT', `/providers/${tow.id}`, { resubmit: true, licenseNumber: 'NEW-LICENSE', status: 'ACTIVE', suspended: false });
    assert.equal(resubmitted.provider.status, 'PENDING'); assert.equal(resubmitted.provider.denialReason, null);
    await ok(admin, 'PUT', `/admin/providers/${tow.id}/approve`, {});
    assert.equal((await Provider.findByPk(tow.id)).status, 'ACTIVE');
  });
  test('suspension stops duty/GPS and cannot be bypassed through revoke and re-register', async () => {
    await ok(owner, 'POST', `/providers/${mobile.id}/toggle-duty`, { accepting: true, ...origin });
    assert.equal((await request(admin, 'PUT', `/admin/providers/${mobile.id}/suspend`, { suspended: true })).status, 400);
    await ok(admin, 'PUT', `/admin/providers/${mobile.id}/suspend`, { suspended: true, reason: 'Kiểm tra hồ sơ' });
    assert.equal(await redis.zscore(Location.geoKey, mobile.id), null);
    assert.equal((await request(owner, 'POST', '/providers/location', { providerId: mobile.id, ...origin })).status, 403);
    await ok(owner, 'POST', `/providers/${mobile.id}/revoke`, {});
    assert.equal((await request(owner, 'POST', '/providers', business('MOBILE_SHOP', { vehicleProfileId: bike.id, ...distant }))).status, 403);
    await ok(admin, 'PUT', `/admin/providers/${mobile.id}/suspend`, { suspended: false });
    const reapplied = await ok(owner, 'POST', '/providers', business('MOBILE_SHOP', { vehicleProfileId: bike.id, ...distant }), 201);
    mobile = reapplied.provider; assert.equal(mobile.status, 'PENDING');
    await ok(admin, 'PUT', `/admin/providers/${mobile.id}/approve`, {});
  });
  test('busy providers cannot revoke/change license or vehicle; off-duty trip GPS remains private', async () => {
    const Ticket = sequelize.define('DispatchTicket', { id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      providerId: DataTypes.UUID, vehicleProfileId: DataTypes.UUID, status: DataTypes.STRING }, { tableName: 'phase3_test_tickets' });
    await Ticket.sync();
    const ticket = await Ticket.create({ providerId: tow.id, vehicleProfileId: randomUUID(), status: '2' });
    assert.equal((await request(owner, 'POST', `/providers/${tow.id}/revoke`, {})).status, 409);
    assert.equal((await request(owner, 'PUT', `/providers/${tow.id}`, { licenseNumber: 'Change mid-job' })).status, 409);
    await ok(owner, 'POST', `/providers/${tow.id}/toggle-duty`, { accepting: false });
    await ok(owner, 'POST', '/providers/location', { providerId: tow.id, ...origin });
    assert.equal(await redis.zscore(Location.geoKey, tow.id), null);
    assert.equal((await ok(null, 'GET', `/providers/${tow.id}`)).latitude, null);
    await ticket.update({ status: '4' });
    await ok(owner, 'POST', `/providers/${tow.id}/revoke`, {});
    assert.ok(await VehicleProfile.findByPk(car.id));
  });
  test('SQL failure rolls back GPS history and never publishes an uncommitted location', async () => {
    await ok(owner, 'POST', `/providers/${mobile.id}/toggle-duty`, { accepting: true, ...origin });
    const previous = await Provider.findByPk(mobile.id);
    const count = await ProviderLocationHistory.count({ where: { providerId: mobile.id } });
    Provider.addHook('beforeUpdate', 'gps-rollback', () => { throw new Error('Intentional failure'); });
    try {
      await assert.rejects(() => Service.heartbeat(owner, { providerId: mobile.id, ...distant }, { ipAddress: '127.0.0.1' }), /Intentional failure/);
    } finally { Provider.removeHook('beforeUpdate', 'gps-rollback'); }
    assert.equal(await ProviderLocationHistory.count({ where: { providerId: mobile.id } }), count);
    assert.equal((await Provider.findByPk(mobile.id)).latitude, previous.latitude);
    const metadata = await redis.hgetall(Location.metadataKey(mobile.id));
    assert.equal(Number(metadata.version), previous.geoVersion);
  });
  test('expired metadata cleanup removes GEO members, and startup reconciliation restores fresh ones', async () => {
    await redis.zadd(Location.freshnessKey, Date.now() - 901000, mobile.id);
    assert.ok(await Location.prune() >= 1);
    assert.equal(await redis.zscore(Location.geoKey, mobile.id), null);
    await Location.reconcile();
    assert.notEqual(await redis.zscore(Location.geoKey, mobile.id), null);
  });
  test('approval revalidates license and replaces the guest role; owner must reauthenticate after an admin role change', async () => {
    const applicant = await client(4);
    const applicantCar = await vehicle(applicant, 'CAR', '51A99988');
    const body = business('TOW', { vehicleProfileId: applicantCar.id }); delete body.licenseNumber;
    const profile = (await ok(applicant, 'POST', '/providers', body, 201)).provider;
    assert.equal((await request(admin, 'PUT', `/admin/providers/${profile.id}/approve`, { reason: 'Kiểm tra hồ sơ' })).status, 400);
    await ok(applicant, 'PUT', `/providers/${profile.id}`, { licenseNumber: 'APPROVED-LICENSE' });
    await ok(admin, 'PUT', `/admin/providers/${profile.id}/approve`, {});
    assert.equal((await request(applicant, 'GET', '/users/me')).status, 401);
    await login(applicant);
    assert.deepEqual((await ok(applicant, 'GET', '/users/me')).services, ['RIDER', 'TOW']);
    assert.equal((await request(applicant, 'PUT', `/providers/${profile.id}`, { resubmit: true })).status, 409);
  });
  test('a delayed pre-suspension cache update cannot resurrect an offline provider', async t => {
    await ok(owner, 'POST', `/providers/${mobile.id}/toggle-duty`, { accepting: true, ...origin });
    const snapshot = await Provider.findByPk(mobile.id, { include: [{ model: User, as: 'owner' }, { model: VehicleProfile, as: 'vehicle' }] });
    await ok(admin, 'PUT', `/admin/providers/${mobile.id}/suspend`, { suspended: true, reason: 'Testing stale cache ordering' });
    t.mock.method(Provider, 'findByPk', async () => snapshot);
    assert.equal(await Location.syncProvider(mobile.id), true);
    assert.equal(await redis.zscore(Location.geoKey, mobile.id), null);
    assert.equal((await redis.hgetall(Location.metadataKey(mobile.id))).accepting, 'false');
    t.mock.restoreAll();
    await ok(admin, 'PUT', `/admin/providers/${mobile.id}/suspend`, { suspended: false });
  });
  test('cache write failure leaves committed GPS usable through SQL fallback', async t => {
    await ok(owner, 'POST', `/providers/${mobile.id}/toggle-duty`, { accepting: true, ...origin });
    const count = await ProviderLocationHistory.count({ where: { providerId: mobile.id } });
    await Provider.update({ lastTrustedLocationAt: new Date(Date.now() - 901000) }, { where: { id: mobile.id }, individualHooks: true });
    t.mock.method(redis, 'eval', async () => { throw new Error('Redis cache write unavailable'); });
    await ok(owner, 'POST', '/providers/location', { providerId: mobile.id, ...distant });
    assert.equal(await ProviderLocationHistory.count({ where: { providerId: mobile.id } }), count + 1);
    const results = await ok(null, 'POST', '/providers/search', { ...distant, radiusKm: 0.5, kinds: ['MOBILE_SHOP'] });
    assert.equal(results[0].id, mobile.id);
    t.mock.restoreAll();
    await Location.reconcile();
  });
  test('inactive owners disappear immediately even when Redis still contains a fresh GPS point', async () => {
    assert.notEqual(await redis.zscore(Location.geoKey, mobile.id), null);
    const user = await User.findOne({ where: { userId: owner.userId } });
    await user.update({ status: 'BANNED' });
    assert.equal((await request(null, 'GET', `/providers/${mobile.id}`)).status, 404);
    assert.equal((await request(null, 'GET', `/providers/${shop.id}`)).status, 404);
    const results = await ok(null, 'POST', '/providers/search', { ...distant, radiusKm: 1 });
    assert.equal(results.some(item => item.id === mobile.id), false);
    await ok(admin, 'PUT', `/admin/providers/${mobile.id}/suspend`, { suspended: true, reason: 'Administrative action on inactive owner' });
    assert.equal((await Provider.findByPk(mobile.id)).suspended, true);
  });

  let capacityOwner, capacityShop, fleetOwner, fleetMobile, fleetTow, fleetCar, evidenceOwner, evidenceTow, gpsOwner, gpsMobile;
  const upgradePoint = { latitude: 10.8, longitude: 106.8 };
  const Availability = require('../src/services/provider_availability.service');
  const Documents = require('../src/services/provider_document.service');
  const { ProviderDocument, ProviderAuditLog } = require('../src/models');
  async function assign(profileId, requirements = {}) {
    return sequelize.transaction(async transaction => {
      await Availability.lockForAssignment(profileId, requirements, transaction);
      return sequelize.models.DispatchTicket.create({ providerId: profileId, vehicleProfileId: randomUUID(), status: '2' }, { transaction });
    });
  }
  async function closeJobs(profileId) {
    await sequelize.transaction(async transaction => {
      const profile = await Provider.findByPk(profileId, { transaction });
      await sequelize.models.DispatchTicket.update({ status: '4' }, { where: { providerId: profileId }, transaction });
      Availability.afterDispatchChange(profile, transaction);
    });
  }
  test('service declarations are required for duty and cannot claim TOW via a repair profile', async () => {
    capacityOwner = await client(5);
    const created = await ok(capacityOwner, 'POST', '/providers', business('SHOP', { ...upgradePoint, capabilities: [], supportedVehicleTypes: [], maxConcurrentJobs: 2 }), 201);
    capacityShop = created.provider;
    const blocked = await request(capacityOwner, 'POST', `/providers/${capacityShop.id}/toggle-duty`, { accepting: true });
    assert.equal(blocked.status, 400); assert.equal(blocked.body.error_code, 'PROVIDER_CAPABILITIES_REQUIRED');
    assert.equal((await request(capacityOwner, 'PUT', `/providers/${capacityShop.id}`, { capabilities: ['TOWING'] })).status, 400);
    await ok(capacityOwner, 'PUT', `/providers/${capacityShop.id}`, { capabilities: ['TYRE_REPAIR', 'BATTERY_JUMPSTART'], supportedVehicleTypes: ['BIKE', 'CAR'] });
    await ok(capacityOwner, 'POST', `/providers/${capacityShop.id}/toggle-duty`, { accepting: true });
    const available = await ok(null, 'GET', `/providers/${capacityShop.id}/availability`);
    assert.equal(available.onDuty, true); assert.equal(available.state, 'AVAILABLE'); assert.equal(available.freeSlots, 2);
  });
  test('shop assignment locks prevent oversubscription and capacity cannot fall below active jobs', async () => {
    const results = await Promise.allSettled([assign(capacityShop.id), assign(capacityShop.id), assign(capacityShop.id)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
    assert.equal(results.find(result => result.status === 'rejected').reason.errorCode, 'PROVIDER_CAPACITY_EXHAUSTED');
    const availability = await ok(null, 'GET', `/providers/${capacityShop.id}/availability`);
    assert.equal(availability.onDuty, true); assert.equal(availability.state, 'BUSY'); assert.equal(availability.activeJobs, 2);
    const filtered = await ok(null, 'POST', '/providers/search', { ...upgradePoint, radiusKm: 0.2, kinds: ['SHOP'], availableOnly: true });
    assert.equal(filtered.some(item => item.id === capacityShop.id), false);
    const directory = await ok(null, 'POST', '/providers/search', { ...upgradePoint, radiusKm: 0.2, kinds: ['SHOP'], acceptingOnly: true });
    assert.equal(directory[0].available, false);
    assert.equal((await request(capacityOwner, 'PUT', `/providers/${capacityShop.id}`, { maxConcurrentJobs: 1 })).status, 409);
    await ok(capacityOwner, 'PUT', `/providers/${capacityShop.id}`, { maxConcurrentJobs: 3 });
    assert.equal((await ok(null, 'GET', `/providers/${capacityShop.id}/availability`)).freeSlots, 1);
    await closeJobs(capacityShop.id);
  });
  test('mobile and towing profiles on one vehicle share exactly one rescue slot', async () => {
    fleetOwner = await client(6); fleetCar = await vehicle(fleetOwner, 'CAR', '51C12345');
    fleetMobile = (await ok(fleetOwner, 'POST', '/providers', business('MOBILE_SHOP', { ...upgradePoint, longitude: 106.82, vehicleProfileId: fleetCar.id }), 201)).provider;
    fleetTow = (await ok(fleetOwner, 'POST', '/providers', business('TOW', { ...upgradePoint, vehicleProfileId: fleetCar.id }), 201)).provider;
    await ok(admin, 'PUT', `/admin/providers/${fleetTow.id}/approve`, {});
    for (const profile of [fleetMobile, fleetTow]) await ok(fleetOwner, 'POST', `/providers/${profile.id}/toggle-duty`, { accepting: true, ...upgradePoint, longitude: 106.82 });
    assert.equal((await request(fleetOwner, 'PUT', `/providers/${fleetMobile.id}`, { maxConcurrentJobs: 2 })).status, 400);
    const results = await Promise.allSettled([assign(fleetMobile.id), assign(fleetTow.id)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await ok(null, 'GET', `/providers/${fleetTow.id}/availability`)).state, 'BUSY');
    assert.equal(await redis.zscore(Location.geoKey, fleetMobile.id), null);
    assert.equal(await redis.zscore(Location.geoKey, fleetTow.id), null);
    await closeJobs(fleetMobile.id); await closeJobs(fleetTow.id);
    assert.equal((await ok(null, 'GET', `/providers/${fleetTow.id}/availability`)).state, 'AVAILABLE');
  });
  test('discovery and assignment both match capabilities, supported types and towing load limits', async () => {
    const query = { ...upgradePoint, longitude: 106.82, radiusKm: 0.5, kinds: ['TOW'], requiredCapabilities: ['TOWING'], vehicleType: 'CAR', availableOnly: true };
    assert.equal((await ok(null, 'POST', '/providers/search', { ...query, vehicleWeightKg: 3000 }))[0].id, fleetTow.id);
    assert.deepEqual(await ok(null, 'POST', '/providers/search', { ...query, vehicleWeightKg: 5000 }), []);
    assert.deepEqual(await ok(null, 'POST', '/providers/search', { ...query, towMethod: 'WHEEL_LIFT' }), []);
    assert.deepEqual(await ok(null, 'POST', '/providers/search', { ...query, vehicleWidth: 2.8 }), []);
    await assert.rejects(() => assign(fleetTow.id, { requiredCapabilities: ['TOWING'], vehicleWeightKg: 5000 }), error => error.errorCode === 'PROVIDER_CAPABILITY_MISMATCH');
    assert.equal((await request(fleetOwner, 'PUT', `/providers/${fleetTow.id}`, { towMaxWeightKg: 100001 })).status, 400);
    const repairs = await ok(null, 'POST', '/providers/search', { ...upgradePoint, radiusKm: 0.2, kinds: ['SHOP'], requiredCapabilities: ['BATTERY_JUMPSTART', 'TYRE_REPAIR'], vehicleType: 'BIKE' });
    assert.equal(repairs[0].id, capacityShop.id);
  });
  test('manual approval requires current evidence; raw bytes and document identities stay private', async () => {
    evidenceOwner = await client(7); const car = await vehicle(evidenceOwner, 'CAR', '51D67890');
    evidenceTow = (await ok(evidenceOwner, 'POST', '/providers', business('TOW', { ...upgradePoint, vehicleProfileId: car.id }), 201)).provider;
    const blocked = await request(admin, 'PUT', `/admin/providers/${evidenceTow.id}/approve`, { reason: 'Kiểm tra hồ sơ' });
    assert.equal(blocked.status, 409); assert.equal(blocked.body.error_code, 'PROVIDER_EVIDENCE_REQUIRED');
    assert.equal((await request(null, 'GET', `/providers/${evidenceTow.id}/documents`)).status, 401);
    assert.equal((await request(capacityOwner, 'GET', `/providers/${evidenceTow.id}/documents`)).status, 404);
    const license = await uploadProof(evidenceOwner, evidenceTow.id, 'LICENSE_PHOTO');
    assert.equal(license.content, undefined); assert.equal(license.sha256.length, 64);
    const response = await fetch(base + '/api/v1/providers/' + evidenceTow.id + '/documents/' + license.id + '/content', { headers: { Cookie: `road_as_token=${evidenceOwner.token}` } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()).subarray(0, png.length), png);
    assert.equal((await request(capacityOwner, 'GET', `/providers/${evidenceTow.id}/documents/${license.id}/content`)).status, 404);
    await ok(admin, 'PUT', `/admin/providers/${evidenceTow.id}/approve`, {});
    await login(evidenceOwner);
    const detail = await ok(null, 'GET', `/providers/${evidenceTow.id}`);
    assert.equal(detail.verification, 'MANUALLY_APPROVED'); assert.equal(detail.documents, undefined);
    const history = await ok(admin, 'GET', `/providers/${evidenceTow.id}/audit`);
    const approved = history.items.find(event => event.action === 'APPROVED');
    assert.equal(approved.actorUserId, admin.userId); assert.ok(approved.reason); assert.equal(approved.after.documents.length, 2);
    assert.equal(JSON.stringify(history).includes(png.toString('base64')), false);
  });
  test('upload validates image bytes, size, document type and owner authorization', async () => {
    async function rawUpload(actor, bytes, mime, type = 'LICENSE_PHOTO') {
      const form = new FormData(); form.set('documentType', type); form.set('file', new Blob([bytes], { type: mime }), 'test.png');
      return fetch(base + '/api/v1/providers/' + evidenceTow.id + '/documents', { method: 'POST', headers: { Cookie: `road_as_token=${actor.token}` }, body: form });
    }
    assert.equal((await rawUpload(capacityOwner, png, 'image/png')).status, 404);
    assert.equal((await rawUpload(evidenceOwner, Buffer.from('<script>alert(1)</script>'), 'image/png')).status, 400);
    assert.equal((await rawUpload(evidenceOwner, png, 'image/png', 'INVALID')).status, 400);
    assert.equal((await rawUpload(evidenceOwner, Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png')).status, 413);
  });
  test('withdrawn and stale evidence cannot approve a changed license; old review snapshots remain readable', async () => {
    const documents = await ok(evidenceOwner, 'GET', `/providers/${evidenceTow.id}/documents`);
    const license = documents.find(document => document.documentType === 'LICENSE_PHOTO' && !document.withdrawnAt);
    await ok(evidenceOwner, 'DELETE', `/providers/${evidenceTow.id}/documents/${license.id}`);
    assert.equal((await Provider.findByPk(evidenceTow.id)).status, 'PENDING');
    const blocked = await request(admin, 'PUT', `/admin/providers/${evidenceTow.id}/approve`, { reason: 'Kiểm tra ảnh mới' });
    assert.equal(blocked.status, 409);
    const old = await ok(admin, 'GET', `/providers/${evidenceTow.id}/audit`);
    assert.ok(old.items.find(event => event.action === 'APPROVED').after.documents.some(document => document.id === license.id));
    const historical = await fetch(base + '/api/v1/providers/' + evidenceTow.id + '/documents/' + license.id + '/content', { headers: { Cookie: `road_as_token=${admin.token}` } });
    assert.equal(historical.status, 200); await historical.arrayBuffer();
    await ok(admin, 'PUT', `/admin/providers/${evidenceTow.id}/approve`, {}); await login(evidenceOwner);
    await ok(evidenceOwner, 'PUT', `/providers/${evidenceTow.id}`, { licenseNumber: 'NEW-LICENSE-NUMBER' });
    const stale = await request(admin, 'PUT', `/admin/providers/${evidenceTow.id}/approve`, { reason: 'Kiểm tra giấy phép thay đổi' });
    assert.equal(stale.status, 409); assert.ok(stale.body.details.missing.includes('LICENSE_PHOTO'));
    assert.ok((await ok(evidenceOwner, 'GET', `/providers/${evidenceTow.id}/documents`)).some(document => document.documentType === 'LICENSE_PHOTO' && !document.currentForProfile));
  });
  test('audit records are append-only and failures roll back the associated profile change', async () => {
    const event = await ProviderAuditLog.findOne({ where: { providerId: evidenceTow.id } });
    await assert.rejects(() => event.update({ action: 'FORGED' }), /append-only/);
    await assert.rejects(() => ProviderAuditLog.destroy({ where: { id: event.id } }), /append-only/);
    const previous = await Provider.findByPk(evidenceTow.id);
    ProviderAuditLog.addHook('beforeCreate', 'reject-audit', () => { throw new Error('Audit write unavailable'); });
    try { await assert.rejects(() => Service.update(evidenceOwner, evidenceTow.id, { name: 'Must roll back' }, {}), /Audit write unavailable/); }
    finally { ProviderAuditLog.removeHook('beforeCreate', 'reject-audit'); }
    assert.equal((await Provider.findByPk(evidenceTow.id)).name, previous.name);
  });
  test('vehicle reapproval captures the old and new dimensions and invalidates the old vehicle photograph', async () => {
    await ok(fleetOwner, 'PUT', `/vehicles/${fleetCar.id}`, { width: 2.1 });
    await login(fleetOwner);
    const history = await ok(fleetOwner, 'GET', `/providers/${fleetTow.id}/audit`);
    const event = history.items.find(event => event.action === 'VEHICLE_CHANGED');
    assert.equal(event.actorUserId, fleetOwner.userId); assert.equal(event.before.vehicle.baseWidth, 1.9); assert.equal(event.after.vehicle.baseWidth, 2.1);
    assert.equal(event.after.profileRevision, event.before.profileRevision + 1);
    const missing = await request(admin, 'PUT', `/admin/providers/${fleetTow.id}/approve`, { reason: 'Kiểm tra kích thước xe mới' });
    assert.equal(missing.status, 409); assert.ok(missing.body.details.missing.includes('VEHICLE_PHOTO'));
  });
  test('revocation is distinct from rejection and releases the live-profile uniqueness slot', async () => {
    const profile = (await ok(capacityOwner, 'POST', '/providers', business('MOBILE_SHOP', { ...distant, vehicleProfileId: (await vehicle(capacityOwner, 'BIKE', '59Z98765')).id, confirmNearby: true }), 201)).provider;
    await ok(capacityOwner, 'POST', `/providers/${profile.id}/revoke`, {});
    assert.equal((await Provider.findByPk(profile.id)).status, 'REVOKED');
    assert.equal((await request(capacityOwner, 'PUT', `/providers/${profile.id}`, { resubmit: true })).status, 409);
    const replacement = await ok(capacityOwner, 'POST', '/providers', business('MOBILE_SHOP', { ...distant, vehicleProfileId: profile.vehicleProfileId, confirmNearby: true }), 201);
    assert.notEqual(replacement.provider.id, profile.id);
    assert.equal((await Provider.findByPk(profile.id)).denialReason, null);
  });
  test('GPS quality preserves trusted coordinates, hides poor fixes and recovers without banning the account', async () => {
    gpsOwner = await client(8); const bike = await vehicle(gpsOwner, 'BIKE', '59B11223');
    const point = { latitude: 10.9, longitude: 106.9 };
    gpsMobile = (await ok(gpsOwner, 'POST', '/providers', business('MOBILE_SHOP', { ...point, vehicleProfileId: bike.id }), 201)).provider;
    const unknown = await ok(gpsOwner, 'POST', `/providers/${gpsMobile.id}/toggle-duty`, { accepting: true, ...point, accuracy: undefined });
    assert.equal(unknown.provider.locationQuality, 'UNKNOWN'); assert.equal(unknown.availability.available, false);
    const poor = await ok(gpsOwner, 'POST', '/providers/location', { providerId: gpsMobile.id, ...point, accuracy: 500 });
    assert.equal(poor.locationQuality, 'POOR_ACCURACY'); assert.equal(poor.usableForDispatch, false);
    const good = await ok(gpsOwner, 'POST', '/providers/location', { providerId: gpsMobile.id, ...point, accuracy: 10 });
    assert.equal(good.locationQuality, 'GOOD'); assert.equal(good.usableForDispatch, true);
    const jump = await ok(gpsOwner, 'POST', '/providers/location', { providerId: gpsMobile.id, latitude: 12, longitude: 108, accuracy: 5 });
    assert.equal(jump.locationQuality, 'IMPLAUSIBLE_JUMP'); assert.equal(jump.usableForDispatch, false);
    assert.equal((await Provider.findByPk(gpsMobile.id)).latitude, point.latitude);
    assert.equal(await redis.zscore(Location.geoKey, gpsMobile.id), null);
    assert.equal((await ok(null, 'GET', `/providers/${gpsMobile.id}`)).latitude, null);
    const recovered = await ok(gpsOwner, 'POST', '/providers/location', { providerId: gpsMobile.id, ...point, accuracy: 10 });
    assert.equal(recovered.usableForDispatch, true);
    assert.equal((await Provider.findByPk(gpsMobile.id)).status, 'ACTIVE');
    assert.ok(await ProviderLocationHistory.count({ where: { providerId: gpsMobile.id, quality: 'IMPLAUSIBLE_JUMP', usableForDispatch: false } }));
  });
  test('schema preparation upgrades the old enum/index without blocking re-registration after revocation', async t => {
    const schema = `legacy_${suffix}`; await sequelize.createSchema(schema);
    try {
      await sequelize.query(`CREATE TYPE "${schema}".enum_providers_status AS ENUM ('ACTIVE','PENDING','DENIED')`);
      await sequelize.query(`CREATE TABLE "${schema}".providers (id UUID PRIMARY KEY, user_id UUID, kind TEXT, status "${schema}".enum_providers_status)`);
      await sequelize.query(`CREATE UNIQUE INDEX providers_user_id_kind ON "${schema}".providers (user_id,kind) WHERE status != 'DENIED'`);
      t.mock.method(Provider, 'getTableName', () => ({ tableName: 'providers', schema }));
      const prepare = require('../src/config/provider.migrations').prepareProviderSchema;
      await prepare(sequelize); await prepare(sequelize);
      const userId = randomUUID();
      await sequelize.query(`INSERT INTO "${schema}".providers VALUES (:id,:userId,'SHOP','REVOKED')`, { replacements: { id: randomUUID(), userId } });
      await sequelize.query(`INSERT INTO "${schema}".providers VALUES (:id,:userId,'SHOP','ACTIVE')`, { replacements: { id: randomUUID(), userId } });
      await assert.rejects(() => sequelize.query(`INSERT INTO "${schema}".providers VALUES (:id,:userId,'SHOP','ACTIVE')`, { replacements: { id: randomUUID(), userId } }));
    } finally { t.mock.restoreAll(); await sequelize.dropSchema(schema, { cascade: true }); }
  });
  test('legacy self-revoked DENIED rows migrate to REVOKED without rewriting rejected applications', async () => {
    const legacy = await Provider.create({ userId: gpsOwner.userId, kind: 'TOW', name: 'Legacy revoke', phone: '0901234567', address: 'Old', ...distant, status: 'DENIED', revokedAt: new Date() });
    const rejected = await Provider.create({ userId: gpsOwner.userId, kind: 'TOW', name: 'Rejected', phone: '0901234567', address: 'Old', ...distant, status: 'DENIED', denialReason: 'Missing proof' });
    await require('../src/config/provider.migrations').reconcileProviderData(sequelize);
    assert.equal((await Provider.findByPk(legacy.id)).status, 'REVOKED');
    assert.equal((await Provider.findByPk(rejected.id)).status, 'DENIED');
  });

  test('retrying the same evidence upload is idempotent and cannot inflate the audit history', async () => {
    const form = () => { const body = new FormData(); body.set('documentType', 'BUSINESS_DOCUMENT'); body.set('file', new Blob([png], { type: 'image/png' }), 'same.png'); return body; };
    const url = base + '/api/v1/providers/' + evidenceTow.id + '/documents';
    const first = await fetch(url, { method: 'POST', headers: { Cookie: `road_as_token=${evidenceOwner.token}` }, body: form() });
    assert.equal(first.status, 201); const original = await first.json();
    const revision = (await Provider.findByPk(evidenceTow.id)).profileRevision;
    const events = await ProviderAuditLog.count({ where: { providerId: evidenceTow.id } });
    const repeated = await fetch(url, { method: 'POST', headers: { Cookie: `road_as_token=${evidenceOwner.token}` }, body: form() });
    const data = await repeated.json(); assert.equal(repeated.status, 201);
    assert.equal(data.data.document.id, original.data.document.id); assert.equal(data.data.duplicate, true);
    assert.equal((await Provider.findByPk(evidenceTow.id)).profileRevision, revision);
    assert.equal(await ProviderAuditLog.count({ where: { providerId: evidenceTow.id } }), events);
  });
  test('uploading evidence also rolls back the image when its audit write fails', async () => {
    const count = await ProviderDocument.count({ where: { providerId: evidenceTow.id } });
    ProviderAuditLog.addHook('beforeCreate', 'upload-audit-failure', () => { throw new Error('Audit unavailable'); });
    try {
      const buffer = Buffer.concat([png, Buffer.from(randomUUID())]);
      await assert.rejects(() => Documents.upload(evidenceOwner, evidenceTow.id, 'LICENSE_PHOTO', { buffer, size: buffer.length, mimetype: 'image/png', originalname: 'rollback.png' }, {}), /Audit unavailable/);
    } finally { ProviderAuditLog.removeHook('beforeCreate', 'upload-audit-failure'); }
    assert.equal(await ProviderDocument.count({ where: { providerId: evidenceTow.id } }), count);
  });

  test('suspension stops new work but preserves private GPS for an already-assigned rescue', async () => {
    await assign(gpsMobile.id);
    await ok(admin, 'PUT', `/admin/providers/${gpsMobile.id}/suspend`, { suspended: true, reason: 'Dừng nhận cuốc mới, bảo toàn cuốc đang chạy' });
    await login(gpsOwner);
    const heartbeat = await ok(gpsOwner, 'POST', '/providers/location', { providerId: gpsMobile.id, latitude: 10.9, longitude: 106.9, accuracy: 10 });
    assert.equal(heartbeat.usableForDispatch, false);
    assert.equal(await redis.zscore(Location.geoKey, gpsMobile.id), null);
    assert.equal((await request(null, 'GET', `/providers/${gpsMobile.id}`)).status, 404);
    await closeJobs(gpsMobile.id);
    assert.equal((await request(gpsOwner, 'POST', '/providers/location', { providerId: gpsMobile.id, latitude: 10.9, longitude: 106.9, accuracy: 10 })).status, 403);
  });

}
