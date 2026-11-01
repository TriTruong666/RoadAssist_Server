const UserService = require("../services/user.service");
const VehicleService = require("../services/vehicle.service");
const Response = require("../common/response.handler");
const { requestContext } = require("../utils/request.util");
module.exports = {
  me: async (req, res) =>
    Response.success(res, await UserService.me(req.user.userId)),
  update: async (req, res) =>
    Response.success(
      res,
      await UserService.update(req.user.userId, req.validated),
    ),
  onboard: async (req, res) =>
    Response.success(
      res,
      await UserService.onboard(
        req.user.userId,
        req.validated,
        requestContext(req),
      ),
    ),
  activeVehicle: async (req, res) =>
    Response.success(
      res,
      await VehicleService.setActive(req.user.userId, req.validated.vehicleId),
    ),
};
