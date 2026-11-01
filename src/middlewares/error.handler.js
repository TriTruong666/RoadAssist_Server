const ResponseHandler = require("../common/response.handler");
const { BaseException } = require("../common/exceptions/BaseException");
const ErrorCodes = require("../common/exceptions/error_codes");
module.exports = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  let descriptor = ErrorCodes.INTERNAL_SERVER_ERROR;
  let details = null;
  if (err instanceof BaseException) {
    descriptor = {
      statusCode: err.statusCode,
      code: err.errorCode,
      message: err.message,
    };
    details = err.details;
  } else if (err.name === "SequelizeUniqueConstraintError") {
    descriptor = ErrorCodes.DUPLICATE_ENTRY;
  } else if (
    ["ValidationError", "SequelizeValidationError"].includes(err.name)
  ) {
    descriptor = ErrorCodes.VALIDATION_ERROR;
  } else if (err.name === 'MulterError') {
    descriptor = err.code === 'LIMIT_FILE_SIZE' ? ErrorCodes.PAYLOAD_TOO_LARGE : ErrorCodes.VALIDATION_ERROR;
  } else if (err.type === "entity.parse.failed") {
    descriptor = ErrorCodes.BAD_REQUEST;
  } else if (err.type === "entity.too.large") {
    descriptor = ErrorCodes.PAYLOAD_TOO_LARGE;
  }
  if (descriptor.statusCode === 429 && details?.retryAfter)
    res.set("Retry-After", String(details.retryAfter));
  if (descriptor.statusCode >= 500) {
    console.error(`[ERROR] ${req.method} ${req.url}`, err);
    return ResponseHandler.internalError(
      res,
      descriptor.message,
      err,
      descriptor.code,
      details,
      descriptor.statusCode,
    );
  }
  return ResponseHandler.error(
    res,
    descriptor.message,
    descriptor.statusCode,
    descriptor.code,
    details,
  );
};
