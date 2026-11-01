const AuthService = require('../services/auth.service');
const Response = require('../common/response.handler');
const { requestContext } = require('../utils/request.util');
const JWTService = require("../services/jwt.service");
const { ACCESS_COOKIE, REFRESH_COOKIE, setSessionCookies, clearSessionCookies } = require('../utils/auth_cookie.util');
const { UnauthorizedException } = require('../common/exceptions/BaseException');
const errors = require('../common/exceptions/error_codes');
module.exports = {
  register: async (req, res) => Response.created(res, await AuthService.register(req.validated, requestContext(req))),
  registerProvider: async (req, res) => Response.created(res, await AuthService.registerProvider(req.validated, requestContext(req))),
  async login(req, res) {
    const session = await AuthService.login({ ...req.validated, ...requestContext(req) });
    return Response.success(res, setSessionCookies(res, session));
  },
  async verifyOtp(req, res) {
    const session = await AuthService.verifyEmail(req.validated, requestContext(req));
    return Response.success(res, setSessionCookies(res, session));
  },
  resendVerification: async (req, res) => Response.success(res, await AuthService.resendVerification(req.validated, requestContext(req))),
  sendVerification: async (req, res) => Response.success(res, await AuthService.sendVerification(req.validated, requestContext(req))),
  async refresh(req, res) {
    try {
      const token = req.cookies?.[REFRESH_COOKIE];
      if (typeof token !== 'string' || token.length > 4096) throw new UnauthorizedException(errors.AUTH_SESSION_EXPIRED);
      const session = await AuthService.refresh(token, requestContext(req));
      return Response.success(res, setSessionCookies(res, session));
    } catch (error) {
      if (error.statusCode === 401 || error.statusCode === 403) clearSessionCookies(res);
      throw error;
    }
  },
  async logout(req, res) {
    try {
      const access = req.cookies?.[ACCESS_COOKIE];
      const user = access ? await JWTService.verifyUserSession(access) : null;
      if (user) await AuthService.logout(user.userId);
      else if (req.cookies?.[REFRESH_COOKIE]) await AuthService.logoutByRefreshToken(req.cookies[REFRESH_COOKIE]);
    } catch (error) {
      if (![401, 403].includes(error.statusCode)) throw error;
    } finally {
      clearSessionCookies(res);
    }
    return Response.success(res, { loggedOut: true });
  },
  forgot: async (req, res) => Response.success(res, await AuthService.forgotPassword(req.validated, requestContext(req))),
  async reset(req, res) {
    const result = await AuthService.resetPassword(req.validated, requestContext(req));
    clearSessionCookies(res);
    return Response.success(res, result);
  },
};
