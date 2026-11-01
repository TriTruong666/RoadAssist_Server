const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const enabled = process.env.RUN_DB_TESTS === '1';
if (!enabled) {
  test('Phase 2 PostgreSQL/Redis integration (RUN_DB_TESTS=1)', { skip: true }, () => {});
} else {
  process.env.NODE_ENV = 'test';
  // Always generate an isolated schema and Redis namespace, never reset the application's data.
  const suffix = randomUUID().replaceAll('-', '');
  process.env.DB_SCHEMA = `phase2_test_${suffix}`;
  process.env.AUTH_REDIS_PREFIX = `test:${suffix}:auth:`;
  const { app } = require('../index');
  const sequelize = require('../src/config/postgres.config');
  const redis = require('../src/config/redis.config');
  const { User, AuthSession, VehicleProfile, VehicleRideConfig } = require('../src/models');
  const Auth = require('../src/services/auth.service');
  const Verification = require('../src/services/login_verification.service');
  const RateLimit = require('../src/services/login_rate_limit.service');
  const JWT = require('../src/services/jwt.service');
  const transport = require('../src/config/mail.config');
  const config = require('../src/config/app.config');
  const { DataTypes } = require('sequelize');
  const { restrictTo, requireServices } = require('../src/middlewares/auth.middleware');
  const mail = [];
  const password = 'Test-roadassist-123!';
  const details = n => ({ email: `phase2-${n}@example.com`, name: `User ${n}`, phone: `090${String(n).padStart(7, '0')}`, password });
  let server, base, rider, vehicle, other, provider;
  async function request(method, path, body, token, headers = {}) {
    const response = await fetch(base + '/api/v1' + path, { method, headers: { ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }), ...headers }, ...(body && { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function ok(method, path, body, token, expected = 200) {
    const result = await request(method, path, body, token);
    assert.equal(result.status, expected, JSON.stringify(result.body));
    return result.body.data;
  }
  const codeFrom = message => message.text.match(/\b\d{6}\b/)[0];
  before(async () => {
    transport.sendMail = async message => { mail.push(message); return { accepted: [message.to] }; };
    await sequelize.authenticate();
    await sequelize.createSchema(process.env.DB_SCHEMA);
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
    redis.disconnect();
    await sequelize.dropSchema(process.env.DB_SCHEMA, { cascade: true });
    await sequelize.close();
  });
  test('register rider ignores privilege injection, hashes password and persists only hashed refresh tokens', async () => {
    rider = await ok('POST', '/auth/register', { ...details(1), email: ' PHASE2-1@example.com ', role: 'admin', services: ['TOW'], sessionVersion: 900 }, undefined, 201);
    assert.equal(rider.user.role, 'guest');
    assert.deepEqual(rider.user.services, ['RIDER']);
    assert.equal(rider.user.password, undefined);
    const user = await User.findOne({ where: { userId: rider.user.userId } });
    assert.notEqual(user.password, password);
    assert.equal(await user.comparePassword(password), true);
    const session = await AuthSession.findOne({ where: { userId: user.userId } });
    assert.equal(session.tokenHash, Auth.hash(rider.refreshToken));
    assert.equal(session.tokenHash.includes(rider.refreshToken), false);
    assert.equal(user.trustedIpRecords[0].ipAddress, '127.0.0.1');
  });
  test('registration duplicates and invalid credentials never expose submitted passwords', async () => {
    let result = await request('POST', '/auth/register', details(1));
    assert.equal(result.status, 409);
    result = await request('POST', '/auth/register', { ...details(2), password: 'short' });
    assert.equal(result.status, 400);
    assert.equal(JSON.stringify(result.body).includes('short'), false);
  });
  test('trusted login -> create vehicle with SOLO -> select active -> me', async () => {
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
    other = await ok('POST', '/auth/register', details(2), undefined, 201);
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
    assert.equal(rider.user.role, 'provider');
    assert.equal(rider.user.onboarded, true);
    assert.equal((await ok('GET', '/users/me', undefined, rider.token)).role, 'provider');
  });
  test('register provider validates kind and grants only expected role/services', async () => {
    assert.equal((await request('POST', '/auth/register-provider', { ...details(3), providerKind: 'ADMIN' })).status, 400);
    provider = await ok('POST', '/auth/register-provider', { ...details(3), providerKind: 'TOW', role: 'admin' }, undefined, 201);
    assert.deepEqual(provider.user.services, ['RIDER', 'TOW']);
    assert.equal(provider.user.role, 'provider');
  });
  test('refresh tokens cannot authorize API calls; rotation rejects replay and races', async () => {
    assert.equal((await request('GET', '/users/me', undefined, other.refreshToken)).status, 401);
    const original = other.refreshToken;
    const results = await Promise.all([request('POST', '/auth/refresh-token', { refreshToken: original }), request('POST', '/auth/refresh-token', { refreshToken: original })]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
    other = results.find(result => result.status === 200).body.data;
    assert.notEqual(other.refreshToken, original);
    assert.equal((await request('POST', '/auth/refresh-token', { refreshToken: original })).status, 401);
  });
  test('logout revokes access and refresh tokens and clears cookies', async () => {
    const result = await request('POST', '/auth/logout', undefined, other.token);
    assert.equal(result.status, 200);
    assert.ok(result.headers.get('set-cookie').includes('token='));
    assert.equal((await request('GET', '/users/me', undefined, other.token)).status, 401);
    assert.equal((await request('POST', '/auth/refresh-token', { refreshToken: other.refreshToken })).status, 401);
  });
  test('new-IP OTP has five-minute TTL, three attempts, IP binding and one-time consumption', async () => {
    const context = { ipAddress: '192.0.2.21', userAgent: 'Integration Browser' };
    const challenge = await Auth.login({ email: details(1).email, password, ...context });
    assert.equal(challenge.requiresVerification, true);
    assert.equal(challenge.token, undefined);
    const code = codeFrom(mail.at(-1));
    const key = `${config.login.keyPrefix}challenge:${challenge.challengeId}`;
    assert.ok((await redis.ttl(key)) <= 300);
    assert.notEqual(await redis.hget(key, 'codeHash'), code);
    await assert.rejects(() => Auth.verifyLogin({ challengeId: challenge.challengeId, code }, { ...context, ipAddress: '192.0.2.22' }));
    const authenticated = await Auth.verifyLogin({ challengeId: challenge.challengeId, code }, context);
    assert.ok(authenticated.token);
    await assert.rejects(() => Auth.verifyLogin({ challengeId: challenge.challengeId, code }, context));
    const user = await User.findOne({ where: { userId: rider.user.userId } });
    assert.ok(user.trustedIpRecords.some(record => record.ipAddress === context.ipAddress));
    await redis.del(`${Verification.pointer(user.userId, 'login')}:cooldown`);
    const next = await Verification.createChallenge({ user, ipAddress: context.ipAddress });
    const correct = codeFrom(mail.at(-1));
    const wrong = correct === '000000' ? '000001' : '000000';
    for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(() => Verification.verifyChallenge({ challengeId: next.challengeId, code: wrong, ipAddress: context.ipAddress }));
    assert.equal(await redis.exists(`${config.login.keyPrefix}challenge:${next.challengeId}`), 0);
    await assert.rejects(() => Verification.verifyChallenge({ challengeId: next.challengeId, code: correct, ipAddress: context.ipAddress }));
  });
  test('OTP HTTP endpoint and expired challenges reject without trusting forwarded headers', async () => {
    const user = await User.findOne({ where: { userId: provider.user.userId } });
    const challenge = await Verification.createChallenge({ user, ipAddress: '127.0.0.1' });
    const code = codeFrom(mail.at(-1));
    const result = await ok('POST', '/auth/verify-otp', { challengeId: challenge.challengeId, code });
    assert.ok(result.token);
    await redis.del(`${Verification.pointer(user.userId, 'login')}:cooldown`);
    const expired = await Verification.createChallenge({ user, ipAddress: '127.0.0.1' });
    await redis.del(`${config.login.keyPrefix}challenge:${expired.challengeId}`);
    assert.equal((await request('POST', '/auth/verify-otp', { challengeId: expired.challengeId, code: codeFrom(mail.at(-1)) })).status, 400);
    // Forwarded headers are ignored unless a trusted proxy is configured by the deployment.
    const login = await request('POST', '/auth/login', { email: details(3).email, password }, undefined, { 'X-Forwarded-For': '203.0.113.99' });
    assert.equal(login.body.data.requiresVerification, false);
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
    assert.equal((await request('POST', '/auth/refresh-token', { refreshToken: provider.refreshToken })).status, 401);
    assert.equal((await request('POST', '/auth/reset-password', { challengeId: forgot.challengeId, code, password })).status, 400);
    const user = await User.findOne({ where: { userId: provider.user.userId } });
    assert.ok(await user.comparePassword('Replacement-123!'));
    assert.deepEqual(user.trustedIpRecords, []);
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
  test('JWT expiry, tampering and stale OTP versions cannot create valid sessions', async () => {
    const user = await User.findOne({ where: { userId: provider.user.userId } });
    const token = JWT.signUser(user.name, user.role, user.userId, user.sessionVersion, { expiresIn: -1 });
    assert.equal(await JWT.verifyUserSession(token), null);
    assert.equal(await JWT.verifyUserSession(provider.token.slice(0, -5) + 'wrong'), null);
    await redis.del(`${Verification.pointer(user.userId, 'login')}:cooldown`);
    const challenge = await Verification.createChallenge({ user, ipAddress: '127.0.0.1' });
    const code = codeFrom(mail.at(-1));
    await user.update({ password: 'Another-secure-123!' });
    assert.equal((await request('POST', '/auth/verify-otp', { challengeId: challenge.challengeId, code })).status, 401);
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
    // Use the future Provider interface in this isolated schema without creating Phase 3 production tables.
    const Provider = sequelize.define('Provider', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      userId: DataTypes.UUID, vehicleProfileId: DataTypes.UUID, kind: DataTypes.STRING,
      status: DataTypes.STRING, accepting: DataTypes.BOOLEAN, suspended: DataTypes.BOOLEAN,
    }, { tableName: 'provider_test_links' });
    await Provider.sync();
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
    assert.equal(linked.status, 'DENIED');
    assert.equal(linked.accepting, false);
    assert.equal(linked.vehicleProfileId, null);
    const user = await User.findOne({ where: { userId: provider.user.userId } });
    assert.deepEqual(user.services, ['RIDER']);
    assert.equal(user.role, 'guest');
    assert.equal(await VehicleProfile.count({ where: { id: vehicle.id } }), 0);
  });
}
