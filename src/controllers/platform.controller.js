const S = require("../services/platform.service");
const R = require("../common/response.handler");
module.exports = {
  alerts: async (req, res) =>
    R.success(
      res,
      await require("../services/admin_alert.service").list(
        req.user,
        req.validated,
      ),
    ),
  readAlert: async (req, res) =>
    R.success(
      res,
      await require("../services/admin_alert.service").read(
        req.user,
        req.validated.id,
      ),
    ),
  providers: async (req, res) =>
    R.success(res, await S.providers(req.validated)),
  hazards: async (req, res) => R.success(res, await S.hazards(req.validated)),
  dispatches: async (req, res) =>
    R.success(res, await S.dispatches(req.validated)),
  dispatchDetail: async (req, res) =>
    R.success(res, await S.dispatchDetail(req.validated.id, req.user)),
  monitor: async (req, res) => R.success(res, await S.monitor(req.validated)),
  stats: async (req, res) => R.success(res, await S.stats()),
  announce: async (req, res) =>
    R.created(res, await S.announce(req.user, req.validated, req.app)),
  adminAnnouncements: async (req, res) =>
    R.success(res, await S.announcements(req.user, req.validated, true)),
  announcements: async (req, res) =>
    R.success(res, await S.announcements(req.user, req.validated)),
  read: async (req, res) =>
    R.success(res, await S.read(req.user, req.validated.id)),
};
