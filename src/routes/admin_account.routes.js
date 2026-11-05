const router = require("express").Router();
const { protect, restrictTo } = require("../middlewares/auth.middleware");
const validate = require("../middlewares/validate.middleware");
const S = require("../schemas/admin_account.schema");
const Accounts = require("../services/admin_account.service");
const R = require("../common/response.handler");
router.use(protect, restrictTo("admin"));
router.get("/", S.list, validate, async (req, res) =>
  R.success(res, await Accounts.list(req.validated, req.app)),
);
router.get("/:id", S.id, validate, async (req, res) =>
  R.success(res, await Accounts.detail(req.validated.id, req.app)),
);
router.put("/:id", S.id, S.update, validate, async (req, res) =>
  R.success(
    res,
    await Accounts.update(req.user, req.validated.id, req.validated, req.app),
  ),
);
module.exports = router;
