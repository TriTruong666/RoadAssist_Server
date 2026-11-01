const Service = require("../services/vehicle.service");
const Response = require("../common/response.handler");
module.exports = {
  list: async (req, res) =>
    Response.success(res, await Service.list(req.user.userId)),
  create: async (req, res) =>
    Response.created(res, await Service.create(req.user.userId, req.validated)),
  async update(req, res) {
    const { id, ...data } = req.validated;
    return Response.success(
      res,
      await Service.update(req.user.userId, id, data),
    );
  },
  remove: async (req, res) =>
    Response.success(
      res,
      await Service.remove(req.user.userId, req.validated.id),
    ),
};
