const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../index');
const sequelize = require('../src/config/postgres.config');
const redis = require('../src/config/redis.config');
const config = require('../src/config/app.config');
const JWT = require('../src/services/jwt.service');
let server, base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  redis.disconnect();
  await sequelize.close();
});
test('invalid auth requests are rejected before database access without echoing credentials', async () => {
  for (const [route, body] of [
    ['/auth/register', { email: 'invalid', password: 'sensitive' }],
    ['/auth/login', { email: 'invalid', password: 'sensitive' }],
    ['/auth/register-provider', { email: 'valid@example.com', name: 'Test', phone: '0901234567', password: 'sensitive', providerKind: 'admin' }],
    ['/auth/verify-otp', { challengeId: 'invalid', code: '123456' }],
    ['/auth/reset-password', { challengeId: 'invalid', code: '123456', password: 'sensitive' }],
  ]) {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.error_code, 'VALIDATION_ERROR');
    assert.equal(JSON.stringify(result).includes('sensitive'), false);
  }
});
test('protected user/vehicle endpoints require cookie authentication', async () => {
  for (const [method, route] of [['GET', '/users/me'], ['PUT', '/users/onboard'], ['GET', '/vehicles'], ['POST', '/vehicles']]) {
    const response = await fetch(base + route, { method });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error_code, 'UNAUTHORIZED');
  }
  const response = await fetch(base + '/users/me', { headers: { Authorization: 'Bearer invalid-token' } });
  assert.equal(response.status, 401);
});
test('startup refuses missing or short JWT secrets', () => {
  const old = config.jwt.secret;
  try {
    config.jwt.secret = null;
    assert.throws(() => JWT.assertConfigured(), /32 bytes/);
    config.jwt.secret = 'short';
    assert.throws(() => JWT.assertConfigured(), /32 bytes/);
  } finally { config.jwt.secret = old; }
});
test('Swagger describes all twenty-two Auth/User/Vehicle operations', () => {
  const { paths } = require('../src/config/swagger.paths');
  const count = Object.values(paths).reduce((total, value) => total + Object.keys(value).length, 0);
  assert.equal(count, 22);
  assert.deepEqual(paths['/api/v1/auth/login'].post.security, []);
  assert.deepEqual(paths['/api/v1/users/me'].get.security, [{ cookieAuth: [] }]);
});

test('logout is idempotent and expires both cookies without a valid session', async () => {
  const response = await fetch(base + '/auth/logout', { method: 'POST' });
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.some(value => value.startsWith('road_as_token=;')));
  assert.ok(cookies.some(value => value.startsWith('road_as_refresh_token=;')));
});
