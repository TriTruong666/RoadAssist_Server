const UserService = require("../services/user.service");
const VehicleService = require("../services/vehicle.service");
const Response = require("../common/response.handler");
const { setSessionCookies } = require("../utils/auth_cookie.util");
const { requestContext } = require("../utils/request.util");
module.exports = {
  registerDevice: async (req, res) => Response.success(res, await require('../services/user_preferences.service').device(req.user, req.validated, req.get('user-agent'))),
  devices: async (req, res) => Response.success(res, await require('../services/user_preferences.service').devices(req.user)),
  payoutAccount: async (req, res) => Response.success(res, await require('../services/user_preferences.service').account(req.user)),
  savePayoutAccount: async (req, res) => Response.success(res, await require('../services/user_preferences.service').saveAccount(req.user, req.validated)),
  me: async (req, res) =>
    Response.success(res, await UserService.me(req.user.userId)),
  update: async (req, res) =>
    Response.success(
      res,
      await UserService.update(req.user.userId, req.validated),
    ),
  async onboard(req, res) {
    const session = await UserService.onboard(
      req.user.userId,
      req.validated,
      requestContext(req),
    );
    return Response.success(res, setSessionCookies(res, session));
  },
  activeVehicle: async (req, res) =>
    Response.success(
      res,
      await VehicleService.setActive(req.user.userId, req.validated.vehicleId),
    ),
};
