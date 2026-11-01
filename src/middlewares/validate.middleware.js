const { validationResult, matchedData } = require('express-validator');
const { BadRequestException } = require('../common/exceptions/BaseException');
const errors = require('../common/exceptions/error_codes');
module.exports = (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    // Never include submitted passwords, OTPs or tokens in error responses.
    const details = result.array().map(({ path, msg, location }) => ({ field: path, message: msg, location }));
    const dimensions = details.some(error => /^(baseWidth|baseHeight|rideConfig\.(width|height))$/.test(error.field));
    return next(new BadRequestException(dimensions ? errors.VEHICLE_DIMENSIONS_INVALID : errors.VALIDATION_ERROR, details));
  }
  req.validated = matchedData(req, { locations: ['body', 'params'], onlyValidData: true });
  next();
};
