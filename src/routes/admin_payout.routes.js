const router = require("express").Router();
const S = require("../services/payout.service");
const schema = require("../schemas/payment.schema");
const validate = require("../middlewares/validate.middleware");
const R = require("../common/response.handler");
const { protect, restrictTo } = require("../middlewares/auth.middleware");
router.use(protect, restrictTo("admin"));
router.get("/pending-items", schema.page, validate, async (req, res) =>
  R.success(res, await S.pending(req.user, req.validated)),
);
router.post("/create-batch", async (req, res) =>
  R.created(res, await S.create(req.user)),
);
router.get("/batches", schema.page, validate, async (req, res) =>
  R.success(res, await S.list(req.user, req.validated)),
);
router.put(
  "/:id/settle",
  schema.id,
  schema.settle,
  validate,
  async (req, res) =>
    R.success(res, await S.settle(req.user, req.validated.id, req.validated)),
);
router.post(
  "/:id/cancel",
  schema.id,
  schema.reason,
  validate,
  async (req, res) =>
    R.success(
      res,
      await S.cancel(req.user, req.validated.id, req.validated.reason),
    ),
);
module.exports = router;
