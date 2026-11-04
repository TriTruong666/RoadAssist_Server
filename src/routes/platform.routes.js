const { Router } = require("express");
const { protect, restrictTo } = require("../middlewares/auth.middleware");
const V = require("../middlewares/validate.middleware");
const S = require("../schemas/platform.schema");
const C = require("../controllers/platform.controller");
const admin = Router();
admin.use(protect, restrictTo("admin"));
admin.get("/settings", async (req, res) =>
  require("../common/response.handler").success(
    res,
    await require("../services/platform_settings.service").load(),
  ),
);
admin.put(
  "/settings",
  require("express-validator").body("revision").isInt({ min: 0 }).toInt(),
  require("express-validator").body("values").isObject({ strict: true }),
  V,
  async (req, res) =>
    require("../common/response.handler").success(
      res,
      await require("../services/platform_settings.service").update(
        req.user,
        req.validated,
      ),
    ),
);
admin.get("/providers", S.page, S.providers, V, C.providers);
admin.get("/flags", S.page, S.hazards, V, C.hazards);
admin.get("/dispatch", S.page, S.dispatches, V, C.dispatches);
admin.get("/dispatch/tickets/:id", S.id, V, C.dispatchDetail);
admin.get("/monitor", S.monitor, V, C.monitor);
admin.get("/stats", C.stats);
admin.get("/alerts", S.page, V, C.alerts);
admin.post("/alerts/:id/read", S.id, V, C.readAlert);
admin.get("/announcements", S.page, V, C.adminAnnouncements);
admin.post("/announcements", S.announcement, V, C.announce);
const notifications = Router();
notifications.use(protect);
notifications.get("/", S.page, V, C.announcements);
notifications.post("/:id/read", S.id, V, C.read);
module.exports = { admin, notifications };
