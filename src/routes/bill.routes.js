const router = require("express").Router();
const S = require("../services/bill.service");
const schema = require("../schemas/payment.schema");
const validate = require("../middlewares/validate.middleware");
const R = require("../common/response.handler");
router.use(require("../middlewares/auth.middleware").protect);
router.get("/my-bills", schema.page, validate, async (req, res) =>
  R.success(res, await S.mine(req.user, req.validated)),
);
router.get("/:id", schema.id, validate, async (req, res) =>
  R.success(res, await S.detail(req.user, req.validated.id)),
);
module.exports = router;
