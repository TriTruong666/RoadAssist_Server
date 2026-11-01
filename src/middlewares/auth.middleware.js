const { ACCESS_COOKIE } = require("../utils/auth_cookie.util");
const JWTService = require("../services/jwt.service");
const {
  UnauthorizedException,
  ForbiddenException,
} = require("../common/exceptions/BaseException");
const errors = require("../common/exceptions/error_codes");
async function protect(req, res, next) {
  try {
    const token = req.cookies?.[ACCESS_COOKIE];
    if (!token) throw new UnauthorizedException(errors.UNAUTHORIZED);
    const payload = await JWTService.verifyUserSession(token);
    if (!payload) throw new UnauthorizedException(errors.AUTH_SESSION_EXPIRED);
    req.user = payload;
    next();
  } catch (error) {
    next(error);
  }
}
const restrictTo =
  (...roles) =>
  (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role))
      return next(new ForbiddenException(errors.FORBIDDEN));
    next();
  };
const requireServices =
  (...services) =>
  (req, res, next) => {
    if (
      !req.user ||
      !services.some((service) => req.user.services?.includes(service))
    )
      return next(new ForbiddenException(errors.FORBIDDEN));
    next();
  };
async function optionalProtect(req, res, next) {
  try {
    const token = req.cookies?.[ACCESS_COOKIE];
    if (token) req.user = await JWTService.verifyUserSession(token);
    next();
  } catch (error) { next(error); }
}
module.exports = { optionalProtect, protect, restrictTo, requireServices };
