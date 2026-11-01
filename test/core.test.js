const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../index');
const sequelize = require('../src/config/postgres.config');
const redis = require('../src/config/redis.config');
const errors = require('../src/common/exceptions/error_codes');
const { BaseException, ConflictException, UnauthorizedException } = require('../src/common/exceptions/BaseException');
let server, base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  redis.disconnect();
  await sequelize.close();
});
test('RoadAssist exception descriptors retain business codes and HTTP status', () => {
  const conflict = new ConflictException(errors.VEHICLE_BUSY);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.errorCode, 'VEHICLE_BUSY');
  assert.equal(new UnauthorizedException().statusCode, 401);
  assert.equal(new UnauthorizedException('Session invalid').errorCode, 'UNAUTHORIZED');
  assert.equal(new BaseException('AUTH_LOGIN_RATE_LIMITED').statusCode, 429);
});
test('unknown API and removed warehouse route use the standard 404 response', async () => {
  for (const path of ['/api/v1/missing', '/api/warehouse']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error_code, 'NOT_FOUND');
    assert.equal(body.success, false);
  }
});
test('malformed JSON returns BAD_REQUEST', async () => {
  const response = await fetch(base + '/api/v1/missing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error_code, 'BAD_REQUEST');
});
test('JSON bodies above the former 1mb limit reach the router', async () => {
  const response = await fetch(base + '/api/v1/missing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: 'a'.repeat(2 * 1024 * 1024) }) });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error_code, 'NOT_FOUND');
});
test('10mb body limit is enforced with a structured error', async () => {
  const response = await fetch(base + '/api/v1/missing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: 'a'.repeat(10 * 1024 * 1024) }) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error_code, 'PAYLOAD_TOO_LARGE');
});
test('CORS rejects domains containing a misleading localhost substring', async () => {
  const response = await fetch(base + '/health', { headers: { Origin: 'https://localhost.attacker.example' } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error_code, 'FORBIDDEN');
});
test('health reports actual dependency readiness', async t => {
  t.mock.method(sequelize, 'authenticate', async () => {});
  const oldStatus = redis.status;
  redis.status = 'ready';
  t.mock.method(redis, 'ping', async () => 'PONG');
  try {
    let response = await fetch(base + '/health');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).redis, 'Connected');
    sequelize.authenticate.mock.mockImplementation(async () => { throw new Error('offline'); });
    redis.status = 'end';
    response = await fetch(base + '/health');
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.database, 'Disconnected');
    assert.equal(body.redis, 'Disconnected');
  } finally { redis.status = oldStatus; }
});
test('Swagger contains RoadAssist health and no legacy schemas', async () => {
  const spec = require('../src/config/swagger.config');
  assert.ok(spec.paths['/health']);
  assert.equal(spec.components.schemas?.ProductPayload, undefined);
  const response = await fetch(base + '/api-docs/');
  assert.equal(response.status, 200);
});
