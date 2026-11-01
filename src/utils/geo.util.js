const RADIUS_METERS = 6371000;
const radians = degrees => degrees * Math.PI / 180;
function distanceMeters(a, b) {
  const dLat = radians(b.latitude - a.latitude), dLon = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * RADIUS_METERS * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
}
// Only finite numeric constants enter this expression; aliases are internal constants, never request input.
function distanceSql(latitude, longitude) {
  if (![latitude, longitude].every(value => typeof value === 'number' && Number.isFinite(value))) throw new Error('Finite coordinates required');
  return `${RADIUS_METERS} * 2 * ASIN(SQRT(LEAST(1.0, GREATEST(0.0, POWER(SIN(RADIANS("Provider"."latitude" - (${latitude})) / 2), 2) + COS(RADIANS(${latitude})) * COS(RADIANS("Provider"."latitude")) * POWER(SIN(RADIANS("Provider"."longitude" - (${longitude})) / 2), 2)))))`;
}
module.exports = { distanceMeters, distanceSql };
