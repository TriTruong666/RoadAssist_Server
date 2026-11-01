const { body, param, query } = require('express-validator');
const { PROVIDER_KINDS } = require('../common/auth.constants');
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
function validHours(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([day, hours]) => DAYS.includes(day) && typeof hours === 'string' &&
    /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(hours));
}
const finite = value => Number.isFinite(Number(value));
const latitude = () => body('latitude').isFloat({ min: -85.05112878, max: 85.05112878 }).bail().custom(finite).bail().customSanitizer(Number);
const longitude = () => body('longitude').isFloat({ min: -180, max: 180 }).bail().custom(finite).bail().customSanitizer(Number);
const gps = () => [latitude().optional(), longitude().optional(),
  body('speed').optional().isFloat({ min: 0, max: 150 }).bail().customSanitizer(Number),
  body('accuracy').optional().isFloat({ min: 0, max: 10000 }).bail().customSanitizer(Number),
  body('recordedAt').optional().isISO8601({ strict: true }).bail().toDate()];
function fields(update = false) {
  const required = rule => update ? rule.optional() : rule;
  return [required(body('name')).isString().bail().trim().isLength({ min: 1, max: 120 }),
    required(body('phone')).isString().bail().customSanitizer(value => value.replace(/[\s().-]/g, '')).matches(/^\+?\d{9,15}$/),
    required(body('address')).isString().bail().trim().isLength({ min: 1, max: 255 }),
    ...(update ? [latitude().optional(), longitude().optional()] : [latitude(), longitude()]),
    body('vehicleProfileId').optional({ nullable: true }).isUUID(4),
    body('plateNumber').optional().isString().bail().trim().isLength({ min: 1, max: 30 }),
    body('licenseNumber').optional().isString().bail().trim().isLength({ min: 1, max: 50 }),
    body('serviceSegments').optional().isArray({ min: 1, max: 2 }).bail().custom(value => new Set(value).size === value.length),
    body('serviceSegments.*').isIn(['SOLO_BIKE', 'CAR']),
    body('openHours').optional().custom(validHours).withMessage('Use MON–SUN with HH:MM-HH:MM; overnight opening is supported'),
    body('confirmNearby').optional().isBoolean({ strict: true }),
  ];
}
module.exports = {
  id: [param('id').isUUID(4)],
  create: [body('kind').isIn(PROVIDER_KINDS), ...fields()],
  update: [...fields(true), body('resubmit').optional().isBoolean({ strict: true })],
  duty: [body('accepting').isBoolean({ strict: true }), ...gps()],
  location: [body('providerId').isUUID(4), ...gps(), latitude(), longitude()],
  deny: [body('reason').isString().bail().trim().isLength({ min: 1, max: 500 })],
  suspend: [body('suspended').isBoolean({ strict: true }), body('reason').if(body('suspended').equals('true')).isString().bail().trim().isLength({ min: 1, max: 500 })],
  pending: [query('page').optional().isInt({ min: 1, max: 10000 }).bail().toInt(), query('limit').optional().isInt({ min: 1, max: 100 }).bail().toInt(), query('kind').optional().isIn(PROVIDER_KINDS)],
  search: [latitude(), longitude(), body('radiusKm').optional().isFloat({ gt: 0, max: 50 }).bail().customSanitizer(Number),
    body('kinds').optional().isArray({ min: 1, max: 3 }), body('kinds.*').isIn(PROVIDER_KINDS),
    body('minRating').optional().isFloat({ min: 0, max: 5 }).bail().customSanitizer(Number),
    body('acceptingOnly').optional().isBoolean({ strict: true }), body('sortBy').optional().isIn(['distance', 'rating']),
    body('limit').optional().isInt({ min: 1, max: 100 }).bail().toInt()],
  validHours,
};
