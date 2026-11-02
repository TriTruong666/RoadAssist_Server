const router = require("express").Router();
const S = require("../services/payment.service");
const Sepay = require("../services/sepay.service");
const Payout = require("../services/payout.service");
const schema = require("../schemas/payment.schema");
const validate = require("../middlewares/validate.middleware");
const R = require("../common/response.handler");
const { protect } = require("../middlewares/auth.middleware");
router.post(
  "/sepay/webhook",
  (req, res, next) => {
    try {
      Sepay.authenticate(req);
      next();
    } catch (e) {
      next(e);
    }
  },
  schema.webhook,
  validate,
  async (req, res) => {
    await Sepay.receive(req.validated);
    res.status(200).json({ success: true });
    setImmediate(() =>
      Sepay.processInbox().catch((e) =>
        console.error("[SePay worker]", e.name),
      ),
    );
  },
);
router.use(protect);
router.post("/create-sepay-qr", schema.create, validate, async (req, res) =>
  R.created(res, await S.create(req.user, "SEPAY", req.validated)),
);
router.post("/choose-cash", schema.create, validate, async (req, res) =>
  R.created(res, await S.create(req.user, "CASH", req.validated)),
);
router.post("/confirm-cash", schema.cash, validate, async (req, res) =>
  R.success(res, await S.confirmCash(req.user, req.validated.paymentId)),
);
router.get("/provider-earnings", schema.page, validate, async (req, res) =>
  R.success(res, await Payout.earnings(req.user, req.validated)),
);
router.get("/:id", schema.id, validate, async (req, res) =>
  R.success(res, await S.get(req.user, req.validated.id)),
);
router.post("/:id/cancel", schema.id, validate, async (req, res) =>
  R.success(res, await S.cancel(req.user, req.validated.id)),
);
module.exports = router;
