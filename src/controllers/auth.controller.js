const AuthService = require('../services/auth.service');
const Response = require('../common/response.handler');
const { requestContext } = require('../utils/request.util');
module.exports = {
  register: async (req, res) => Response.created(res, await AuthService.register(req.validated, requestContext(req))),
  registerProvider: async (req, res) => Response.created(res, await AuthService.registerProvider(req.validated, requestContext(req))),
  login: async (req, res) => Response.success(res, await AuthService.login({ ...req.validated, ...requestContext(req) })),
  verifyOtp: async (req, res) => Response.success(res, await AuthService.verifyLogin(req.validated, requestContext(req))),
  refresh: async (req, res) => Response.success(res, await AuthService.refresh(req.validated.refreshToken, requestContext(req))),
  async logout(req, res) {
    const result = await AuthService.logout(req.user.userId);
    res.clearCookie('token', { path: '/' });
    res.clearCookie('refreshToken', { path: '/' });
    return Response.success(res, result);
  },
  forgot: async (req, res) => Response.success(res, await AuthService.forgotPassword(req.validated, requestContext(req))),
  reset: async (req, res) => Response.success(res, await AuthService.resetPassword(req.validated, requestContext(req))),
};
