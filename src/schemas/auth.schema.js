const { body } = require('express-validator');
const { PROVIDER_KINDS } = require('../common/auth.constants');
const email = () => body('email').isString().bail().trim().isLength({ max: 150 }).isEmail().bail().customSanitizer(value => value.toLowerCase());
const password = () => body('password').isString().bail().isLength({ min: 8 }).custom(value => Buffer.byteLength(value) <= 72).withMessage('Password must contain 8–72 bytes');
const otp = () => [body('challengeId').isUUID(4), body('code').isString().matches(/^\d{6}$/)];
const register = () => [email(), password(), body('name').isString().bail().trim().isLength({ min: 1, max: 120 }),
  body('phone').isString().bail().customSanitizer(value => value.replace(/[\s().-]/g, '')).matches(/^\+?\d{9,15}$/)];
module.exports = {
  register: register(),
  registerProvider: [...register(), body('providerKind').isIn(PROVIDER_KINDS)],
  login: [email(), body('password').isString().bail().notEmpty().custom(value => Buffer.byteLength(value) <= 72)],
  verifyOtp: otp(),
  refresh: [body('refreshToken').isString().bail().isLength({ min: 20, max: 4096 })],
  forgot: [email()], reset: [...otp(), password()],
};
