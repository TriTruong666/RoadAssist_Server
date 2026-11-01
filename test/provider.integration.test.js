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
  const password = 'Phase3-test-password!';
  const origin = { latitude: 10.77, longitude: 106.69 };
  const distant = { latitude: 11.1, longitude: 106.7 };
  const business = (kind, extra = {}) => ({ kind, name: `Provider ${kind}`, phone: '0901234567', address: 'Test address', ...origin,
    ...(kind === 'SHOP' ? { serviceSegments: ['SOLO_BIKE', 'CAR'], openHours: { MON: '22:00-05:00' } } : { licenseNumber: 'LICENSE-123' }), ...extra });
  async function client(n, role = 'guest') {
    const user = await User.create({ email: `phase3-${n}@example.com`, password, phone: `09000000${String(n).padStart(2, '0')}`, name: `User ${n}`, role, emailVerifiedAt: new Date() });
    const session = await Auth.completeLogin({ userId: user.userId, ipAddress: '127.0.0.1' });
    return { userId: user.userId, email: user.email, token: session.token, refreshToken: session.refreshToken, role };
  }
  async function request(actor, method, path, body) {
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
    const result = await request(actor, method, path, body);
    assert.equal(result.status, expected, JSON.stringify(result.body));
    return result.body.data;
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
    assert.equal((await request(admin, 'PUT', `/admin/providers/${tow.id}/approve`, {})).status, 409);
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
    await ok(owner, 'POST', '/providers/location', { providerId: mobile.id, latitude: origin.latitude + 0.001, longitude: origin.longitude, speed: 3, accuracy: 8 });
    const row = await Provider.findByPk(mobile.id);
    assert.equal(row.latitude, origin.latitude + 0.001); assert.equal(await ProviderLocationHistory.count({ where: { providerId: mobile.id } }), 2);
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
    await Provider.update({ lastHeartbeatAt: new Date(Date.now() - 16 * 60000) }, { where: { id: mobile.id }, individualHooks: true });
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
    assert.equal((await request(admin, 'PUT', `/admin/providers/${profile.id}/approve`, {})).status, 400);
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

}
