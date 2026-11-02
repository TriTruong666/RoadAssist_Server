const router = require("express").Router();
const { body } = require("express-validator");
const schema = require("../schemas/dispatch.schema");
const validate = require("../middlewares/validate.middleware");
const { protect, restrictTo } = require("../middlewares/auth.middleware");
const R = require("../common/response.handler");
const Support = require("../services/dispatch_support.service");
const Intake = require("../services/shop_intake.service");
router.use(protect, restrictTo("admin"));
router.get("/support-cases", schema.page, validate, async (req, res) =>
  R.success(res, await Support.list(req.user, req.validated)),
);
router.get("/support-cases/:id", schema.id, validate, async (req, res) =>
  R.success(res, await Support.detail(req.user, req.validated.id)),
);
router.post(
  "/support-cases/:id/resolve",
  schema.id,
  body("resolution").isString().trim().isLength({ min: 3, max: 1000 }),
  validate,
  async (req, res) =>
    R.success(
      res,
      await Support.resolve(req.user, req.validated.id, req.validated),
    ),
);
router.post(
  "/:id/propose-destination",
  schema.id,
  body("dropoffShopId").isUUID(),
  schema.reason,
  validate,
  async (req, res) =>
    R.success(
      res,
      await Intake.propose(req.user, req.validated.id, req.validated),
    ),
);
module.exports = router;
