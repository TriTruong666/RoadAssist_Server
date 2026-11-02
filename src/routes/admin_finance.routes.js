const router = require("express").Router();
const { Refund, SepayReceipt, FinanceEvent } = require("../models");
const S = require("../services/payment.service");
const schema = require("../schemas/payment.schema");
const validate = require("../middlewares/validate.middleware");
const R = require("../common/response.handler");
const { protect, restrictTo } = require("../middlewares/auth.middleware");
router.use(protect, restrictTo("admin"));
for (const [path, Model] of [
  ["refunds", Refund],
  ["sepay-receipts", SepayReceipt],
  ["events", FinanceEvent],
  ["transfers", require("../models").BankTransferProof],
])
  router.get("/" + path, schema.page, validate, async (req, res) => {
    const result = await Model.findAndCountAll({
      limit: req.validated.limit || 50,
      offset: req.validated.offset || 0,
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
    });
    R.success(res, { total: result.count, items: result.rows });
  });
router.post(
  "/refunds/:id/complete",
  schema.id,
  schema.reference,
  validate,
  async (req, res) =>
    R.success(
      res,
      await S.completeRefund(req.user, req.validated.id, req.validated),
    ),
);
router.post(
  "/sepay-receipts/:id/reconcile",
  schema.id,
  schema.reconcile,
  validate,
  async (req, res) => {
    const receipt = await require("../services/sepay.service").reconcile(
      req.user,
      req.validated.id,
      req.validated,
    );
    R.success(res, receipt);
    setImmediate(() =>
      require("../services/sepay.service")
        .processInbox()
        .catch((error) =>
          console.error("[Finance reconciliation]", error.name),
        ),
    );
  },
);
router.post(
  "/sepay-receipts/:id/refund",
  schema.id,
  schema.reference,
  schema.reason,
  validate,
  async (req, res) =>
    R.success(
      res,
      await require("../services/sepay.service").refundReviewed(
        req.user,
        req.validated.id,
        req.validated,
      ),
    ),
);
module.exports = router;
