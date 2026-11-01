const { distanceMeters } = require('./geo.util');
function classify(provider, sample, recordedAt, now, config) {
  if (sample.accuracy == null) return 'UNKNOWN';
  if (sample.accuracy > config.maxAccuracyMeters) return 'POOR_ACCURACY';
  if (provider.lastTrustedLocationAt && now - new Date(provider.lastTrustedLocationAt) < 900000) {
    const elapsed = Math.max(0, (recordedAt - new Date(provider.lastTrustedRecordedAt || provider.lastLocationRecordedAt)) / 1000);
    const uncertainty = Math.max(Number(provider.lastAccuracy || 0), sample.accuracy) + 100;
    if (distanceMeters(provider, sample) > elapsed * config.maxPlausibleSpeedMps + uncertainty) return 'IMPLAUSIBLE_JUMP';
  }
  return 'GOOD';
}
function usable(provider, now = Date.now()) {
  return provider.locationQuality === 'GOOD' && provider.lastTrustedLocationAt && now - new Date(provider.lastTrustedLocationAt).getTime() < 900000;
}
module.exports = { classify, usable };
