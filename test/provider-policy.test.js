const { test } = require('node:test');
const assert = require('node:assert/strict');
const Capabilities = require('../src/services/provider_capability.service');
const Gps = require('../src/utils/gps_quality.util');
const { detectMime } = require('../src/services/provider_document.service');
const sequelize = require('../src/config/postgres.config');
const { after } = require('node:test');
after(() => sequelize.close());
test('capability matching requires all requested services and respects towing dimensions', () => {
  const tow = { kind: 'TOW', capabilities: ['TOWING'], supportedVehicleTypes: ['CAR'], towMaxWeightKg: 3000, towMaxWidth: 2, towMaxHeight: 2.5, towMaxLength: 5, towMethods: ['FLATBED'], maxConcurrentJobs: 1 };
  assert.equal(Capabilities.matches(tow, { requiredCapabilities: ['TOWING'], vehicleWeightKg: 2500, vehicleWidth: 1.9 }), true);
  for (const request of [{ vehicleWeightKg: 3500 }, { vehicleHeight: 3 }, { vehicleLength: 6 }, { towMethod: 'WHEEL_LIFT' }, { vehicleType: 'BIKE' }, { requiredCapabilities: ['TYRE_REPAIR'] }]) assert.equal(Capabilities.matches(tow, request), false);
  assert.throws(() => Capabilities.validate({ ...tow, maxConcurrentJobs: 2 }));
});
test('repair providers cannot self-declare towing and incomplete capabilities are not dispatchable', () => {
  assert.throws(() => Capabilities.validate({ kind: 'SHOP', capabilities: ['TOWING'], maxConcurrentJobs: 1 }));
  assert.equal(Capabilities.valid({ kind: 'SHOP', capabilities: [], supportedVehicleTypes: ['CAR'] }), false);
  assert.equal(Capabilities.valid({ kind: 'TOW', capabilities: ['TOWING'], supportedVehicleTypes: ['CAR'] }), false);
});
test('GPS quality distinguishes poor accuracy and impossible movement without treating it as account fraud', () => {
  const now = new Date();
  const profile = { latitude: 10.77, longitude: 106.69, lastTrustedLocationAt: now, lastTrustedRecordedAt: new Date(now - 60000), lastAccuracy: 10 };
  const config = { maxAccuracyMeters: 100, maxPlausibleSpeedMps: 60 };
  assert.equal(Gps.classify(profile, { latitude: 10.771, longitude: 106.69, accuracy: 10 }, now, now, config), 'GOOD');
  assert.equal(Gps.classify(profile, { latitude: 12, longitude: 108, accuracy: 10 }, now, now, config), 'IMPLAUSIBLE_JUMP');
  assert.equal(Gps.classify(profile, { latitude: 10.77, longitude: 106.69, accuracy: 500 }, now, now, config), 'POOR_ACCURACY');
  assert.equal(Gps.classify(profile, { latitude: 10.77, longitude: 106.69 }, now, now, config), 'UNKNOWN');
  assert.equal(Gps.usable({ locationQuality: 'POOR_ACCURACY', lastTrustedLocationAt: now }), false);
  assert.equal(Gps.usable({ locationQuality: 'GOOD', lastTrustedLocationAt: new Date(now - 901000) }), false);
});
test('private evidence upload recognizes image signatures instead of trusting extensions', () => {
  assert.equal(detectMime(Buffer.from('<script>fake.png</script>')), null);
  assert.equal(detectMime(Buffer.from([255, 216, 255, 224])), 'image/jpeg');
  assert.equal(detectMime(Buffer.from('RIFF0000WEBP')), 'image/webp');
});
