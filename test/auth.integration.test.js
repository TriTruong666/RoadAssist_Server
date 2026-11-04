const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const enabled = process.env.RUN_DB_TESTS === '1';
if (!enabled) {
  test('Phase 2 PostgreSQL/Redis integration (RUN_DB_TESTS=1)', { skip: true }, () => {});
} else {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = randomUUID() + randomUUID();
  process.env.AUTH_OTP_SECRET = randomUUID() + randomUUID();
  process.env.ALLOWED_CLIENT_URL_1 = 'http://localhost:5173';
  // Always generate an isolated schema and Redis namespace, never reset the application's data.
  const suffix = randomUUID().replaceAll('-', '');
  process.env.DB_SCHEMA = `phase2_test_${suffix}`;
  process.env.AUTH_REDIS_PREFIX = `test:${suffix}:auth:`;
  process.env.PROVIDER_REDIS_PREFIX = `test:${suffix}:providers:`;
 const s3Fixture = require('./s3.fixture');
  const { app } = require('../index');
  const sequelize = require('../src/config/postgres.config');
  const redis = require('../src/config/redis.config');
  const { User, AuthSession, VehicleProfile, VehicleRideConfig, PendingRegistration } = require('../src/models');
  const Auth = require('../src/services/auth.service');
  const Verification = require('../src/services/email_verification.service');
  const RateLimit = require('../src/services/login_rate_limit.service');
  const JWT = require('../src/services/jwt.service');
  const transport = require('../src/config/mail.config');
  const config = require('../src/config/app.config');
  const { DataTypes } = require('sequelize');
  const { restrictTo, requireServices } = require('../src/middlewares/auth.middleware');
  const mail = [];
  const password = 'Test-roadassist-123!';
  const details = n => ({ email: `phase2-${n}@example.com`, name: `User ${n}`, phone: `090${String(n).padStart(7, '0')}`, password });
  let server, base, rider, vehicle, other, provider, Provider, DispatchTicket;
  async function request(method, path, body, token, headers = {}) {
    const response = await fetch(base + '/api/v1' + path, { method, headers: { ...(body && { 'Content-Type': 'application/json' }), ...(token && { Cookie: `road_as_token=${token}` }), ...headers }, ...(body && { body: JSON.stringify(body) }) });
    const cookieHeaders = response.headers.getSetCookie();
    const cookies = Object.fromEntries(cookieHeaders.map(value => value.split(';')[0].split(/=(.*)/s).slice(0, 2)));
    const bodyData = await response.json();
    if (bodyData.data?.user) {
      assert.equal(bodyData.data.token, undefined, 'Access tokens must not appear in HTTP JSON');
      assert.equal(bodyData.data.refreshToken, undefined, 'Refresh tokens must not appear in HTTP JSON');
      assert.equal(bodyData.data.tokenType, undefined);
    }
    return { status: response.status, body: bodyData, headers: response.headers, cookies, cookieHeaders };
  }
  async function ok(method, path, body, token, expected = 200) {
    const result = await request(method, path, body, token);
    assert.equal(result.status, expected, JSON.stringify(result.body));
    const data = result.body.data;
    // Test-only handle for the browser cookie jar; these values never come from JSON.
    return result.cookies.road_as_token ? { ...data, token: result.cookies.road_as_token, refreshToken: result.cookies.road_as_refresh_token } : data;
  }
  async function registerUser(data, isProvider = false) {
    const challenge = await ok('POST', isProvider ? '/auth/register-provider' : '/auth/register', data, undefined, 201);
    return ok('POST', '/auth/verify-email', { challengeId: challenge.challengeId, code: codeFrom(mail.at(-1)) });
  }
  const codeFrom = message => message.text.match(/\b\d{6}\b/)[0];
  before(async () => {
    transport.sendMail = async message => { mail.push(message); return { accepted: [message.to] }; };
    await sequelize.authenticate();
    await sequelize.createSchema(process.env.DB_SCHEMA);
    Provider = require('../src/models').Provider;
    Provider.addHook('beforeValidate', 'fixture-defaults', profile => {
      profile.name ||= 'Provider fixture'; profile.phone ||= '0900000000'; profile.address ||= 'Test address';
      profile.latitude ??= 10.77; profile.longitude ??= 106.69;
    });
    DispatchTicket = require('./dispatch.fixture');
    await sequelize.sync();
    await redis.connect();
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    const keys = await redis.keys(`${process.env.AUTH_REDIS_PREFIX}*`);
    if (keys.length) await redis.del(...keys);
    const geoKeys = await redis.keys(`${process.env.PROVIDER_REDIS_PREFIX}*`);
    if (geoKeys.length) await redis.del(...geoKeys);
    redis.disconnect();
    await sequelize.dropSchema(process.env.DB_SCHEMA, { cascade: true });
    await sequelize.close();
  });
  test('registration stores only a hashed draft; no account/session exists before email ownership is verified', async () => {
    const challenge = await ok('POST', '/auth/register', { ...details(1), email: ' PHASE2-1@example.com ', role: 'admin', services: ['TOW'], emailVerifiedAt: new Date() }, undefined, 201);
    assert.equal(challenge.requiresVerification, true);
    assert.equal(challenge.token, undefined);
    assert.equal(await User.count({ where: { email: details(1).email } }), 0);
    assert.equal(await AuthSession.count(), 0);
    const draft = await PendingRegistration.findByPk(challenge.registrationId);
    assert.notEqual(draft.passwordHash, password);
    const bcrypt = require('bcrypt');
    assert.equal(await bcrypt.compare(password, draft.passwordHash), true);
    rider = await ok('POST', '/auth/verify-email', { challengeId: challenge.challengeId, code: codeFrom(mail.at(-1)) });
    assert.equal(rider.user.role, 'guest');
    assert.deepEqual(rider.user.services, ['RIDER']);
    assert.ok(rider.user.emailVerifiedAt);
    assert.equal(rider.user.password, undefined);
    assert.equal(await PendingRegistration.findByPk(challenge.registrationId), null);
    const user = await User.findOne({ where: { userId: rider.user.userId } });
    assert.equal(await user.comparePassword(password), true);
    const session = await AuthSession.findOne({ where: { userId: user.userId } });
    assert.equal(session.tokenHash, Auth.hash(rider.refreshToken));
    assert.equal(user.get('trustedIpRecords'), undefined);
  });
  test('registration duplicates and invalid credentials never expose submitted passwords', async () => {
    let result = await request('POST', '/auth/register', details(1));
    assert.equal(result.status, 409);
    result = await request('POST', '/auth/register', { ...details(2), password: 'short' });
    assert.equal(result.status, 400);
    assert.equal(JSON.stringify(result.body).includes('short'), false);
  });
  test('password login -> create vehicle with SOLO -> select active -> me', async () => {
    rider = await ok('POST', '/auth/login', { email: details(1).email, password });
    assert.equal(rider.requiresVerification, false);
    vehicle = await ok('POST', '/vehicles', { type: 'BIKE', plateNumber: ' 59a 123.45 ', brand: 'Honda', modelName: 'Wave' }, rider.token, 201);
    assert.equal(vehicle.baseWidth, 0.7);
    assert.equal(vehicle.baseHeight, 1.1);
    assert.equal(vehicle.plateNumber, '59A123.45');
    assert.equal(vehicle.rideConfig.mode, 'SOLO');
    await ok('PUT', '/users/active-vehicle', { vehicleId: vehicle.id }, rider.token);
    const me = await ok('GET', '/users/me', undefined, rider.token);
    assert.equal(me.activeVehicle.id, vehicle.id);
    assert.equal(me.activeVehicle.rideConfig.width, 0.7);
    for (const field of ['password', 'sessionVersion', 'trustedIpRecords', 'loginIp']) assert.equal(me[field], undefined);
  });
  test('ownership, vehicle dimensions, aliases and load configuration are enforced', async () => {
    other = await registerUser(details(2));
    for (const [method, path, body] of [ ['PUT', `/vehicles/${vehicle.id}`, { brand: 'Attack' }], ['DELETE', `/vehicles/${vehicle.id}`], ['PUT', '/users/active-vehicle', { vehicleId: vehicle.id }] ]) {
      assert.equal((await request(method, path, body, other.token)).status, 404);
    }
    const invalid = await request('PUT', `/vehicles/${vehicle.id}`, { width: 9 }, rider.token);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error_code, 'VEHICLE_DIMENSIONS_INVALID');
    let updated = await ok('PUT', `/vehicles/${vehicle.id}`, { width: 0.8, height: 1.2, rideConfig: { mode: 'CARGO', width: 1.3, height: 1.8 } }, rider.token);
    assert.equal(updated.baseWidth, 0.8);
    assert.equal(updated.rideConfig.mode, 'CARGO');
    assert.equal(updated.rideConfig.width, 1.3);
    // Parent-object validation must not permit reassignment of a nested ORM foreign key.
    const otherVehicle = await ok('POST', '/vehicles', { type: 'CAR', plateNumber: '30A99999', brand: 'Toyota', modelName: 'Other' }, other.token, 201);
    updated = await ok('PUT', `/vehicles/${vehicle.id}`, { rideConfig: { mode: 'CARGO', vehicleProfileId: otherVehicle.id, id: otherVehicle.rideConfig.id } }, rider.token);
    assert.equal(updated.rideConfig.vehicleProfileId, vehicle.id);
    const foreignConfig = await VehicleRideConfig.findOne({ where: { vehicleProfileId: otherVehicle.id } });
    assert.equal(foreignConfig.id, otherVehicle.rideConfig.id);
    updated = await ok('PUT', `/vehicles/${vehicle.id}`, { rideConfig: { mode: 'SOLO' } }, rider.token);
    assert.equal(updated.rideConfig.width, 0.8);
    const inactive = await ok('PUT', `/vehicles/${vehicle.id}`, { isActive: false }, rider.token);
    assert.equal(inactive.isActive, false);
    assert.equal((await ok('GET', '/users/me', undefined, rider.token)).activeVehicleId, null);
    await ok('PUT', `/vehicles/${vehicle.id}`, { isActive: true }, rider.token);
    await ok('PUT', '/users/active-vehicle', { vehicleId: vehicle.id }, rider.token);
    await ok('DELETE', `/vehicles/${vehicle.id}`, undefined, rider.token);
    assert.equal((await ok('GET', '/users/me', undefined, rider.token)).activeVehicleId, null);
    assert.equal(await VehicleRideConfig.count({ where: { vehicleProfileId: vehicle.id } }), 0);
  });
  test('profile update cannot change role, services or status; onboarding issues replacement session', async () => {
    const updated = await ok('PUT', '/users/me', { name: 'Updated name', avatar: 'https://example.com/avatar.jpg', role: 'admin', status: 'BANNED', services: ['TOW'] }, rider.token);
    assert.equal(updated.name, 'Updated name');
    assert.equal(updated.role, 'guest');
    assert.deepEqual(updated.services, ['RIDER']);
    rider = await ok('PUT', '/users/onboard', { services: ['RIDER', 'MOBILE_SHOP'], role: 'admin' }, rider.token);
    assert.equal(rider.user.role, 'guest');
    assert.deepEqual(rider.user.requestedServices, ['RIDER', 'MOBILE_SHOP']);
    assert.deepEqual(rider.user.services, ['RIDER']);
    assert.equal(rider.user.onboarded, true);
    assert.equal((await ok('GET', '/users/me', undefined, rider.token)).role, 'guest');
  });
  test('register provider validates kind and grants only expected role/services', async () => {
    assert.equal((await request('POST', '/auth/register-provider', { ...details(3), providerKind: 'ADMIN' })).status, 400);
    provider = await registerUser({ ...details(3), providerKind: 'TOW', role: 'admin' }, true);
    assert.deepEqual(provider.user.services, ['RIDER']);
    assert.deepEqual(provider.user.requestedServices, ['RIDER', 'TOW']);
    assert.equal(provider.user.role, 'guest');
  });
  test('refresh tokens cannot authorize API calls; rotation rejects replay and races', async () => {
    assert.equal((await request('GET', '/users/me', undefined, other.refreshToken)).status, 401);
    const original = other.refreshToken;
    const results = await Promise.all([request('POST', '/auth/refresh-token', undefined, undefined, { Cookie: `road_as_refresh_token=${original}` }), request('POST', '/auth/refresh-token', undefined, undefined, { Cookie: `road_as_refresh_token=${original}` })]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
    const refreshed = results.find(result => result.status === 200);
    other = { ...refreshed.body.data, token: refreshed.cookies.road_as_token, refreshToken: refreshed.cookies.road_as_refresh_token };
    assert.notEqual(other.refreshToken, original);
    assert.equal((await request('POST', '/auth/refresh-token', undefined, undefined, { Cookie: `road_as_refresh_token=${original}` })).status, 401);
  });
  test('logout revokes access and refresh tokens and clears cookies', async () => {
    const result = await request('POST', '/auth/logout', undefined, other.token);
    assert.equal(result.status, 200);
    assert.ok(result.headers.get('set-cookie').includes('road_as_token='));
    assert.equal((await request('GET', '/users/me', undefined, other.token)).status, 401);
    assert.equal((await request('POST', '/auth/refresh-token', undefined, undefined, { Cookie: `road_as_refresh_token=${other.refreshToken}` })).status, 401);
  });
  test('correct password logs in from changing IPs without sending any email or requiring OTP', async () => {
    const count = mail.length;
    for (const ipAddress of ['192.0.2.21', '198.51.100.99', '203.0.113.44']) {
      const session = await Auth.login({ email: details(1).email, password, ipAddress, userAgent: 'Traveling rider' });
      assert.equal(session.requiresVerification, false);
      assert.ok(session.token);
    }
    assert.equal(mail.length, count);
  });
  test('registration OTP is limited to three attempts, expires, is purpose bound and works after changing IP', async () => {
    const challenge = await ok('POST', '/auth/register', details(10), undefined, 201);
    const code = codeFrom(mail.at(-1));
    assert.ok((await redis.ttl(Verification.key(challenge.challengeId))) <= 300);
    assert.notEqual(await redis.hget(Verification.key(challenge.challengeId), 'codeHash'), code);
    await assert.rejects(() => Verification.verifyChallenge({ challengeId: challenge.challengeId, code, purpose: 'password-reset' }));
    const wrong = code === '000000' ? '000001' : '000000';
    for (let n = 0; n < 3; n++) assert.equal((await request('POST', '/auth/verify-email', { challengeId: challenge.challengeId, code: wrong })).status, 400);
    assert.equal(await redis.exists(Verification.key(challenge.challengeId)), 0);
    assert.equal((await request('POST', '/auth/verify-email', { challengeId: challenge.challengeId, code })).status, 400);
    assert.equal(await User.count({ where: { email: details(10).email } }), 0);
    await redis.del(`${Verification.pointer(details(10).email, 'registration')}:cooldown`);
    const resent = await ok('POST', '/auth/resend-verification', { registrationId: challenge.registrationId });
    const newCode = codeFrom(mail.at(-1));
    const session = await Auth.verifyEmail({ challengeId: resent.challengeId, code: newCode }, { ipAddress: '192.0.2.77' });
    assert.ok(session.token);
    await assert.rejects(() => Auth.verifyEmail({ challengeId: resent.challengeId, code: newCode }, { ipAddress: '192.0.2.78' }));
    const expiring = await ok('POST', '/auth/register', details(11), undefined, 201);
    await redis.del(Verification.key(expiring.challengeId));
    assert.equal((await request('POST', '/auth/verify-email', { challengeId: expiring.challengeId, code: codeFrom(mail.at(-1)) })).status, 400);
  });
  test('OTP replay races produce exactly one account and one session', async () => {
    const challenge = await ok('POST', '/auth/register', details(12), undefined, 201);
    const body = { challengeId: challenge.challengeId, code: codeFrom(mail.at(-1)) };
    const results = await Promise.all([request('POST', '/auth/verify-email', body), request('POST', '/auth/verify-email', body)]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
    assert.equal(await User.count({ where: { email: details(12).email } }), 1);
  });
  test('legacy unverified accounts cannot use tokens until proving ownership, then login is password only', async () => {
    const user = await User.create(details(13));
    const token = JWT.signUser(user.name, user.role, user.userId, user.sessionVersion);
    assert.equal(await JWT.verifyUserSession(token), null);
    const denied = await request('POST', '/auth/login', { email: user.email, password });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error_code, 'AUTH_EMAIL_NOT_VERIFIED');
    const challenge = await ok('POST', '/auth/send-verification', { email: user.email, password });
    const session = await ok('POST', '/auth/verify-email', { challengeId: challenge.challengeId, code: codeFrom(mail.at(-1)) });
    assert.ok(session.user.emailVerifiedAt);
    const login = await Auth.login({ email: user.email, password, ipAddress: '203.0.113.200' });
    assert.ok(login.token);
    assert.equal(login.requiresVerification, false);
  });
  test('atomic rate limiter locks on fifth failure by email and independently by IP', async () => {
    const context = { email: 'limit@example.com', ipAddress: '198.51.100.1' };
    for (let attempt = 0; attempt < 4; attempt++) await RateLimit.recordFailure(context);
    await assert.rejects(() => RateLimit.recordFailure(context), error => error.statusCode === 429 && error.details.retryAfter > 0);
    await assert.rejects(() => RateLimit.assertAllowed({ ...context, ipAddress: '198.51.100.2' }), error => error.statusCode === 429);
    await assert.rejects(() => RateLimit.assertAllowed({ ...context, email: 'another@example.com' }), error => error.statusCode === 429);
    const concurrent = { email: 'parallel@example.com', ipAddress: '198.51.100.3' };
    await Promise.allSettled(Array.from({ length: 20 }, () => RateLimit.recordFailure(concurrent)));
    assert.equal(await redis.get(RateLimit.keys(concurrent)[0]), '20');
  });
  test('forgot/reset password is purpose-bound, one-time, and revokes every existing session', async () => {
    const forgot = await ok('POST', '/auth/forgot-password', { email: details(3).email });
    const code = codeFrom(mail.at(-1));
    assert.equal((await request('POST', '/auth/verify-otp', { challengeId: forgot.challengeId, code })).status, 400);
    await ok('POST', '/auth/reset-password', { challengeId: forgot.challengeId, code, password: 'Replacement-123!' });
    assert.equal((await request('GET', '/users/me', undefined, provider.token)).status, 401);
    assert.equal((await request('POST', '/auth/refresh-token', undefined, undefined, { Cookie: `road_as_refresh_token=${provider.refreshToken}` })).status, 401);
    assert.equal((await request('POST', '/auth/reset-password', { challengeId: forgot.challengeId, code, password })).status, 400);
    const user = await User.findOne({ where: { userId: provider.user.userId } });
    assert.ok(await user.comparePassword('Replacement-123!'));
    assert.ok(user.emailVerifiedAt);
    const unknown = await ok('POST', '/auth/forgot-password', { email: 'not-present@example.com' });
    assert.equal(unknown.message, forgot.message);
    assert.equal(unknown.expiresIn, forgot.expiresIn);
    assert.match(unknown.challengeId, /^[a-f0-9-]{36}$/);
  });
  test('password/status/role/email changes invalidate old JWTs, and role/service middleware denies escalation', async () => {
    const user = await User.findOne({ where: { userId: rider.user.userId } });
    const token = JWT.signUser(user.name, user.role, user.userId, user.sessionVersion);
    await user.update({ status: 'BANNED' });
    assert.equal(await JWT.verifyUserSession(token), null);
    assert.equal((await request('GET', '/users/me', undefined, token)).status, 401);
    let error;
    restrictTo('admin')({ user: { role: 'guest' } }, {}, value => { error = value; });
    assert.equal(error.statusCode, 403);
    requireServices('TOW')({ user: { services: ['RIDER'] } }, {}, value => { error = value; });
    assert.equal(error.statusCode, 403);
    await user.update({ status: 'ACTIVE' });
    assert.equal(await JWT.verifyUserSession(token), null);
    const version = user.sessionVersion;
    await user.update({ email: 'changed@example.com' });
    assert.equal(user.sessionVersion, version + 1);
  });
  test('JWT expiry, tampering and stale email challenges cannot create valid sessions', async () => {
    const user = await User.create(details(14));
    const token = JWT.signUser(user.name, user.role, user.userId, user.sessionVersion, { expiresIn: -1 });
    assert.equal(await JWT.verifyUserSession(token), null);
    assert.equal(await JWT.verifyUserSession(provider.token.slice(0, -5) + 'wrong'), null);
    const challenge = await Verification.createChallenge({ user, purpose: 'email-verification' });
    const code = codeFrom(mail.at(-1));
    await user.update({ password: 'Another-secure-123!' });
    assert.equal((await request('POST', '/auth/verify-email', { challengeId: challenge.challengeId, code })).status, 401);
  });
  test('admin seeding is explicit and idempotent, and refuses to promote an existing rider', async () => {
    const { seedSystemAdmin } = require('../src/seeds/admin.seed');
    const keys = ['ADMIN_SEED_EMAIL', 'ADMIN_SEED_PASSWORD', 'ADMIN_SEED_PHONE', 'ADMIN_SEED_NAME'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, { ADMIN_SEED_EMAIL: 'admin-phase2@example.com', ADMIN_SEED_PASSWORD: password, ADMIN_SEED_PHONE: '0909999999', ADMIN_SEED_NAME: 'Test admin' });
      const admin = await seedSystemAdmin();
      assert.equal(admin.role, 'admin');
      const same = await seedSystemAdmin();
      assert.equal(same.userId, admin.userId);
      const session = await Auth.completeLogin({ userId: admin.userId, sessionVersion: admin.sessionVersion, ipAddress: '127.0.0.1' });
      assert.equal((await ok('GET', '/users/me', undefined, session.token)).role, 'admin');
      process.env.ADMIN_SEED_EMAIL = details(2).email;
      process.env.ADMIN_SEED_PHONE = details(2).phone;
      await assert.rejects(seedSystemAdmin, /conflicts/);
    } finally {
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    }
  });
  test('HTTP login returns Retry-After on fifth bad password and unlocks after counter expiry', async () => {
    const credentials = { email: details(2).email, password: 'Wrong-password-123' };
    const keys = RateLimit.keys({ email: credentials.email, ipAddress: '127.0.0.1' });
    await redis.del(...keys);
    for (let i = 0; i < 4; i++) assert.equal((await request('POST', '/auth/login', credentials)).status, 401);
    const result = await request('POST', '/auth/login', credentials);
    assert.equal(result.status, 429);
    assert.ok(Number(result.headers.get('retry-after')) > 0);
    assert.ok(result.body.details.retryAfter > 0);
    assert.equal((await request('POST', '/auth/login', { ...credentials, password })).status, 429);
    await redis.del(...keys);
    const login = await ok('POST', '/auth/login', { ...credentials, password });
    assert.equal(login.requiresVerification, false);
  });
  test('linked mobile/tow licenses are revoked atomically on vehicle removal when Provider is registered', async () => {
    const vehicle = await require('../src/services/vehicle.service').create(provider.user.userId, { type: 'CAR', plateNumber: '30A12345', brand: 'Toyota', modelName: 'Test' });
    const linked = await Provider.create({ userId: provider.user.userId, vehicleProfileId: vehicle.id, kind: 'TOW', status: 'ACTIVE', accepting: true, suspended: false });
    Provider.addHook('beforeUpdate', 'rollback-test', () => { throw new Error('Forced provider failure'); });
    await assert.rejects(() => require('../src/services/vehicle.service').remove(provider.user.userId, vehicle.id), /Forced provider failure/);
    assert.equal(await VehicleProfile.count({ where: { id: vehicle.id } }), 1);
    await linked.reload();
    assert.equal(linked.status, 'ACTIVE');
    Provider.removeHook('beforeUpdate', 'rollback-test');
    const result = await require('../src/services/vehicle.service').remove(provider.user.userId, vehicle.id);
    assert.equal(result.revokedProviders[0].id, linked.id);
    await linked.reload();
    assert.equal(linked.status, 'REVOKED');
    assert.equal(linked.accepting, false);
    assert.equal(linked.vehicleProfileId, null);
    const user = await User.findOne({ where: { userId: provider.user.userId } });
    assert.deepEqual(user.services, ['RIDER']);
    assert.equal(user.role, 'guest');
    assert.equal(await VehicleProfile.count({ where: { id: vehicle.id } }), 0);
  });
  test('requested services and stale stored grants never authorize an unapproved provider', async () => {
    const session = await registerUser({ ...details(20), providerKind: 'TOW' }, true);
    const user = await User.findOne({ where: { userId: session.user.userId } });
    await user.update({ services: ['RIDER', 'TOW'] });
    const payload = await JWT.verifyUserSession(session.token);
    assert.deepEqual(payload.services, ['RIDER']);
    assert.equal(payload.role, 'guest');
    const me = await ok('GET', '/users/me', undefined, session.token);
    assert.deepEqual(me.requestedServices, ['RIDER', 'TOW']);
    assert.deepEqual(me.services, ['RIDER']);
    await Provider.create({ userId: user.userId, kind: 'TOW', status: 'PENDING', suspended: false });
    assert.deepEqual((await JWT.verifyUserSession(session.token)).services, ['RIDER']);
  });
  test('approved provider grants require valid linked vehicles and are removed when suspended', async () => {
    const session = await registerUser(details(21));
    const vehicles = require('../src/services/vehicle.service');
    const bike = await vehicles.create(session.user.userId, { type: 'BIKE', plateNumber: '59A12345', brand: 'Honda', modelName: 'Test' });
    const profile = await Provider.create({ userId: session.user.userId, vehicleProfileId: bike.id, kind: 'TOW', status: 'ACTIVE' });
    assert.deepEqual((await JWT.verifyUserSession(session.token)).services, ['RIDER']);
    await profile.update({ kind: 'MOBILE_SHOP' });
    assert.deepEqual((await JWT.verifyUserSession(session.token)).services, ['RIDER', 'MOBILE_SHOP']);
    await profile.update({ suspended: true });
    assert.deepEqual((await JWT.verifyUserSession(session.token)).services, ['RIDER']);
  });
  test('important vehicle changes require provider reapproval, turn off duty and revoke grants atomically', async () => {
    const session = await registerUser(details(22));
    const vehicles = require('../src/services/vehicle.service');
    const car = await vehicles.create(session.user.userId, { type: 'CAR', plateNumber: '30A12345', brand: 'Toyota', modelName: 'Test' });
    const profile = await Provider.create({ userId: session.user.userId, vehicleProfileId: car.id, plateNumber: car.plateNumber, kind: 'TOW', status: 'ACTIVE', accepting: true, capabilities: ['TOWING'], supportedVehicleTypes: ['CAR'], towMaxWeightKg: 3500, towMaxWidth: 2.5, towMaxHeight: 3, towMaxLength: 6, towMethods: ['FLATBED'] });
    const authenticated = await Auth.completeLogin({ userId: session.user.userId, ipAddress: '127.0.0.1' });
    assert.deepEqual(authenticated.user.services, ['RIDER', 'TOW']);
    assert.equal(authenticated.user.role, 'provider');
    const updated = await ok('PUT', `/vehicles/${car.id}`, { plateNumber: '30B99999' }, authenticated.token);
    assert.equal(updated.reapprovalRequiredProviders[0].id, profile.id);
    await profile.reload();
    assert.equal(profile.status, 'PENDING');
    assert.equal(profile.accepting, false);
    const user = await User.findOne({ where: { userId: session.user.userId } });
    assert.deepEqual(user.services, ['RIDER']);
    const reduced = await JWT.verifyUserSession(authenticated.token);
    assert.equal(reduced.role, 'guest');
    assert.deepEqual(reduced.services, ['RIDER']);
    assert.equal((await request('POST', `/providers/${profile.id}/toggle-duty`, { accepting: true }, authenticated.token)).status, 403);
    assert.ok((await Auth.login({ email: details(22).email, password, ipAddress: '203.0.113.111' })).token);
  });
  test('open rider dispatch blocks edits and deletion; terminal dispatch permits them', async () => {
    const session = await registerUser(details(23));
    const vehicles = require('../src/services/vehicle.service');
    const car = await vehicles.create(session.user.userId, { type: 'CAR', plateNumber: '30C12345', brand: 'Toyota', modelName: 'Test' });
    const ticket = await DispatchTicket.create({ vehicleProfileId: car.id, status: '6' });
    for (const [method, path, body] of [['PUT', `/vehicles/${car.id}`, { type: 'BIKE' }], ['PUT', `/vehicles/${car.id}`, { rideConfig: { width: 2.5 } }], ['DELETE', `/vehicles/${car.id}`]]) {
      const result = await request(method, path, body, session.token);
      assert.equal(result.status, 409);
      assert.equal(result.body.error_code, 'VEHICLE_BUSY');
      assert.equal(result.body.details.dispatchTicketId, ticket.id);
    }
    assert.equal((await VehicleProfile.findByPk(car.id)).type, 'CAR');
    await ticket.update({ status: '4' });
    await ok('DELETE', `/vehicles/${car.id}`, undefined, session.token);
  });
  test('provider assigned to another rider ticket cannot have its vehicle edited or revoked mid-job', async () => {
    const session = await registerUser(details(24));
    const vehicles = require('../src/services/vehicle.service');
    const car = await vehicles.create(session.user.userId, { type: 'CAR', plateNumber: '30D12345', brand: 'Toyota', modelName: 'Test' });
    const profile = await Provider.create({ userId: session.user.userId, vehicleProfileId: car.id, kind: 'TOW', status: 'ACTIVE', accepting: true });
    const ticket = await DispatchTicket.create({ vehicleProfileId: randomUUID(), providerId: profile.id, status: '2' });
    for (const action of [() => vehicles.remove(session.user.userId, car.id), () => vehicles.update(session.user.userId, car.id, { plateNumber: '30D88888' })]) {
      await assert.rejects(action, error => error.errorCode === 'VEHICLE_BUSY');
    }
    await profile.reload();
    assert.equal(profile.status, 'ACTIVE');
    assert.equal(profile.accepting, true);
    assert.equal((await VehicleProfile.findByPk(car.id)).plateNumber, '30D12345');
    await ticket.update({ status: '5' });
    const removed = await vehicles.remove(session.user.userId, car.id);
    assert.equal(removed.revokedProviders[0].id, profile.id);
  });
  test('SMTP failure does not create an account or usable challenge', async () => {
    const sendMail = transport.sendMail;
    transport.sendMail = async () => { throw new Error('SMTP unavailable'); };
    try {
      const result = await request('POST', '/auth/register', details(25));
      assert.equal(result.status, 503);
      assert.equal(result.body.error_code, 'AUTH_MAIL_UNAVAILABLE');
      assert.equal(await User.count({ where: { email: details(25).email } }), 0);
      assert.equal(await PendingRegistration.count({ where: { email: details(25).email } }), 0);
      const pointer = Verification.pointer(details(25).email, 'registration');
      assert.equal(await redis.exists(pointer), 0);
    } finally { transport.sendMail = sendMail; }
  });

  test('migration preserves requested services while removing legacy unapproved grants', async () => {
    const user = await User.create({ ...details(30), role: 'provider', services: ['RIDER', 'TOW'], emailVerifiedAt: new Date() });
    await require('../src/config/database.migrations').runStartupDatabaseMigrations(sequelize);
    await user.reload();
    assert.deepEqual(user.requestedServices, ['RIDER', 'TOW']);
    assert.deepEqual(user.services, ['RIDER']);
    assert.equal(user.role, 'guest');
  });
  test('JSON seeds preserve operator workflow without granting provider permissions or silently verifying email', async t => {
    const fs = require('node:fs');
    const originalExists = fs.existsSync;
    const originalRead = fs.readFileSync;
    const records = [
      { ...details(31), role: 'provider', services: ['RIDER', 'TOW'] },
      { ...details(32), role: 'provider', services: ['RIDER', 'MOBILE_SHOP'], emailVerified: true },
    ];
    t.mock.method(fs, 'existsSync', path => String(path).endsWith('user_seed.json') ? true : originalExists(path));
    t.mock.method(fs, 'readFileSync', (path, ...args) => String(path).endsWith('user_seed.json') ? JSON.stringify(records) : originalRead(path, ...args));
    await require('../src/seeds/user.seed').seedUsers();
    const pending = await User.findOne({ where: { email: details(31).email } });
    const trusted = await User.findOne({ where: { email: details(32).email } });
    assert.equal(pending.role, 'guest');
    assert.deepEqual(pending.services, ['RIDER']);
    assert.deepEqual(pending.requestedServices, ['RIDER', 'TOW']);
    assert.equal(pending.emailVerifiedAt, null);
    assert.ok(trusted.emailVerifiedAt);
  });

  test('login sets scoped HttpOnly cookies; access headers and legacy cookie names cannot authenticate', async () => {
    const login = await request('POST', '/auth/login', { email: details(2).email, password });
    assert.equal(login.status, 200);
    assert.ok(login.cookies.road_as_token);
    assert.ok(login.cookies.road_as_refresh_token);
    for (const header of login.cookieHeaders) {
      assert.match(header, /HttpOnly/i);
      assert.match(header, /SameSite=Lax/i);
      assert.match(header, /Expires=/i);
    }
    assert.match(login.cookieHeaders.find(value => value.startsWith('road_as_token=')), /Path=\/(?:;|$)/);
    assert.match(login.cookieHeaders.find(value => value.startsWith('road_as_refresh_token=')), /Path=\/api\/v1\/auth(?:;|$)/);
    const access = login.cookies.road_as_token;
    assert.equal((await request('GET', '/users/me', undefined, undefined, { Authorization: `Bearer ${access}` })).status, 401);
    assert.equal((await request('GET', '/users/me', undefined, undefined, { Cookie: `token=${access}` })).status, 401);
    assert.equal((await request('GET', '/users/me', undefined, access, { Authorization: 'Bearer invalid-header' })).status, 200);
    // A JSON refresh token cannot replace the refresh cookie.
    assert.equal((await request('POST', '/auth/refresh-token', { refreshToken: login.cookies.road_as_refresh_token })).status, 401);
    assert.equal((await request('POST', '/auth/refresh-token', undefined, access)).status, 401);
  });
  test('cookie-authenticated writes reject untrusted browser origins without logging the user out', async () => {
    const login = await ok('POST', '/auth/login', { email: details(2).email, password });
    const hostile = await request('POST', '/auth/logout', undefined, login.token, { Origin: 'https://attacker.example' });
    assert.equal(hostile.status, 403);
    const missingOrigin = await request('POST', '/auth/logout', undefined, login.token, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(missingOrigin.status, 403);
    assert.equal((await request('GET', '/users/me', undefined, login.token)).status, 200);
    const allowed = await request('GET', '/users/me', undefined, login.token, { Origin: process.env.ALLOWED_CLIENT_URL_1 });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(allowed.headers.get('access-control-allow-origin'), process.env.ALLOWED_CLIENT_URL_1);
  });

  test('logout with expired access still revokes sessions through the refresh cookie and clears both cookies', async () => {
    const login = await ok('POST', '/auth/login', { email: details(2).email, password });
    const decoded = JWT.verify(login.token);
    const expired = JWT.signUser(login.user.name, login.user.role, login.user.userId, decoded.sessionVersion, { jwtid: decoded.jti, expiresIn: -1 });
    const result = await request('POST', '/auth/logout', undefined, undefined, { Cookie: `road_as_token=${expired}; road_as_refresh_token=${login.refreshToken}` });
    assert.equal(result.status, 200);
    assert.equal(result.cookies.road_as_token, '');
    assert.equal(result.cookies.road_as_refresh_token, '');
    assert.equal(await JWT.verifyUserSession(login.token), null);
    await assert.rejects(() => Auth.refresh(login.refreshToken, { ipAddress: '127.0.0.1' }), error => error.statusCode === 401);
  });

}
