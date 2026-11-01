const ErrorCodes = require("./error_codes");
class BaseException extends Error {
  constructor(error = ErrorCodes.INTERNAL_SERVER_ERROR, details = null) {
    const descriptor = typeof error === "string" ? ErrorCodes[error] : error;
    super(descriptor?.message || error || ErrorCodes.INTERNAL_SERVER_ERROR.message);
    this.name = this.constructor.name;
    this.statusCode = descriptor?.statusCode || 500;
    this.errorCode = descriptor?.code || ErrorCodes.INTERNAL_SERVER_ERROR.code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}
function exceptionType(name, fallback) {
  return class extends BaseException {
    constructor(error = fallback, details = null) {
      super(error, details);
      this.name = name;
      this.statusCode = fallback.statusCode;
      if (typeof error === "string" && !ErrorCodes[error]) this.errorCode = fallback.code;
    }
  };
}
module.exports = {
  BaseException,
  BadRequestException: exceptionType("BadRequestException", ErrorCodes.BAD_REQUEST),
  UnauthorizedException: exceptionType("UnauthorizedException", ErrorCodes.UNAUTHORIZED),
  ForbiddenException: exceptionType("ForbiddenException", ErrorCodes.FORBIDDEN),
  NotFoundException: exceptionType("NotFoundException", ErrorCodes.NOT_FOUND),
  ConflictException: exceptionType("ConflictException", ErrorCodes.CONFLICT),
};
