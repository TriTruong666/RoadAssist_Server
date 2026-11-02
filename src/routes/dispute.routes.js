const router = require("express").Router();
const { protect, restrictTo } = require("../middlewares/auth.middleware");
const R = require("../common/response.handler");
const validate = require("../middlewares/validate.middleware");
const base = require("../schemas/dispatch.schema");
const schema = require("../schemas/custody_dispute.schema");
const S = require("../services/dispute.service");
router.use(protect);
router.post("/", schema.open, validate, async (req, res) =>
  R.created(res, await S.open(req.user, req.validated)),
);
router.get("/my-disputes", base.page, schema.list, validate, async (req, res) =>
  R.success(res, await S.list(req.user, req.validated)),
);
router.get("/:id", base.id, validate, async (req, res) =>
  R.success(res, await S.detail(req.user, req.validated.id)),
);
router.post(
  "/:id/evidence",
  base.id,
  schema.evidence,
  validate,
  async (req, res) =>
    R.success(res, await S.evidence(req.user, req.validated.id, req.validated)),
);
const admin = require("express").Router();
admin.use(protect, restrictTo("admin"));
admin.get("/", base.page, schema.list, validate, async (req, res) =>
  R.success(res, await S.list(req.user, req.validated, true)),
);
admin.get("/:id", base.id, validate, async (req, res) =>
  R.success(res, await S.detail(req.user, req.validated.id, true)),
);
admin.put("/:id/resolve", base.id, schema.resolve, validate, async (req, res) =>
  R.success(res, await S.resolve(req.user, req.validated.id, req.validated)),
);
module.exports = { router, admin };
