const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePlate, isValidVietnamesePlate } = require('../src/utils/plate.util');
const { distanceMeters, distanceSql } = require('../src/utils/geo.util');
const { validHours } = require('../src/schemas/provider.schema');
test('VN plate normalization matches the provider business format', () => {
  assert.equal(normalizePlate(' 51a-999.88 '), '51A99988');
  assert.equal(isValidVietnamesePlate('30A-12345'), true);
  assert.equal(isValidVietnamesePlate('59-A1 123.45'), true);
  assert.equal(isValidVietnamesePlate('INVALID'), false);
  assert.equal(isValidVietnamesePlate('30A12'), false);
});
test('geographic distance handles identical, nearby, antipodal and date-line positions', () => {
  assert.equal(distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 }), 0);
  const nearby = distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0.01 });
  assert.ok(nearby > 1110 && nearby < 1115);
  const wrapped = distanceMeters({ latitude: 0, longitude: 179.999 }, { latitude: 0, longitude: -179.999 });
  assert.ok(wrapped > 220 && wrapped < 225);
  const antipodal = distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 });
  assert.ok(Number.isFinite(antipodal) && antipodal > 20000000);
  assert.throws(() => distanceSql('0; DROP TABLE providers', 0), /Finite/);
});
test('SHOP opening hours allow overnight shifts and reject invalid shapes or times', () => {
  assert.equal(validHours({ MON: '22:00-05:00', SUN: '00:00-23:59' }), true);
  assert.equal(validHours({ MON: '24:00-05:00' }), false);
  assert.equal(validHours({ MONDAY: '08:00-17:00' }), false);
  assert.equal(validHours(['08:00-17:00']), false);
});
test('Phase 3 Swagger describes thirteen cookie-authenticated/public operations', () => {
  const { paths } = require('../src/config/provider.swagger');
  assert.equal(Object.values(paths).reduce((total, item) => total + Object.keys(item).length, 0), 13);
  assert.deepEqual(paths['/api/v1/providers/search'].post.security, []);
  assert.deepEqual(paths['/api/v1/admin/providers/{id}/approve'].put.security, [{ cookieAuth: [] }]);
});
