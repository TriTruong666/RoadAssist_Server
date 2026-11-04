const { body } = require('express-validator');
const { SERVICES } = require('../common/auth.constants');
module.exports = {
  device: [body('clientDeviceId').isUUID(4), body('name').isString().trim().isLength({ min: 1, max: 120 })],
  payout: [body('bankCode').isString().trim().matches(/^[A-Za-z0-9_-]{2,30}$/), body('accountNumber').isString().trim().matches(/^\d{6,34}$/), body('accountName').isString().trim().isLength({ min: 2, max: 120 })],
  update: [body('name').optional().isString().bail().trim().isLength({ min: 1, max: 120 }),
    body('avatar').optional({ nullable: true }).isString().bail().isLength({ max: 2048 }).isURL({ protocols: ['https', 'http'], require_protocol: true, require_tld: false }),
    body('webPushToken').optional({ nullable: true }).isString().bail().isLength({ min: 1, max: 255 })],
  onboard: [body('requestedServices').optional().isArray({ min: 1, max: 4 }), body('requestedServices.*').isIn(SERVICES), body('services').optional().isArray({ min: 1, max: 4 }), body('services.*').isIn(SERVICES)],
  activeVehicle: [body('vehicleId').custom(value => value === null || (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))).withMessage('vehicleId must be a UUID or null')],
};
