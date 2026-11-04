const S = require("../services/rating.service");
const R = require("../common/response.handler");
module.exports = {
  submit: async (req, res) =>
    R.success(res, await S.submit(req.user, req.validated)),
  reply: async (req, res) =>
    R.success(
      res,
      await S.reply(req.user, req.validated.id, req.validated.content),
    ),
  provider: async (req, res) =>
    R.success(
      res,
      await S.listProvider(req.validated.providerId, req.validated),
    ),
  ticket: async (req, res) =>
    R.success(res, await S.mine(req.user, req.validated.ticketId)),
};
