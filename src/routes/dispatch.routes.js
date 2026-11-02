const router = require("express").Router();
const schema = require("../schemas/dispatch.schema");
const validate = require("../middlewares/validate.middleware");
const R = require("../common/response.handler");
const Service = require("../services/dispatch.service");
router.use(require("../middlewares/auth.middleware").protect);
for (const [path, type, validation] of [
  ["walk-in", "WALK_IN", schema.walkIn],
  ["sos", "SOS", schema.sos],
  ["tow", "TOW", schema.tow],
])
  router.post("/" + path, validation, validate, async (req, res) =>
    R.created(res, await Service.create(req.user, type, req.validated)),
  );
router.get(
  "/my-requests",
  schema.page,
  schema.mine,
  validate,
  async (req, res) =>
    R.success(res, await Service.mine(req.user, req.validated)),
);
router.get(
  "/provider-feed",
  schema.page,
  schema.feed,
  validate,
  async (req, res) =>
    R.success(res, await Service.feed(req.user, req.validated)),
);
router.get(
  "/provider-requests",
  schema.page,
  schema.feed,
  schema.mine,
  validate,
  async (req, res) =>
    R.success(res, await Service.providerRequests(req.user, req.validated)),
);
router.get("/notifications", schema.page, validate, async (req, res) =>
  R.success(res, await Service.notifications(req.user, req.validated)),
);
router.get("/:id", schema.id, validate, async (req, res) =>
  R.success(res, await Service.detail(req.user, req.validated.id)),
);
router.post(
  "/:id/accept",
  schema.id,
  schema.accept,
  validate,
  async (req, res) =>
    R.success(
      res,
      await Service.accept(req.user, req.validated.id, req.validated),
    ),
);
router.post(
  "/:id/cancel",
  schema.id,
  schema.reason,
  validate,
  async (req, res) =>
    R.success(
      res,
      await Service.cancel(req.user, req.validated.id, req.validated),
    ),
);
router.post(
  "/:id/retarget",
  schema.id,
  schema.destination,
  schema.revision,
  validate,
  async (req, res) =>
    R.success(
      res,
      await Service.retarget(req.user, req.validated.id, req.validated),
    ),
);
router.post(
  "/:id/tow-offer",
  schema.id,
  schema.offer,
  validate,
  async (req, res) =>
    R.success(
      res,
      await Service.towOffer(req.user, req.validated.id, req.validated),
    ),
);
for (const [action, validation] of [
  ["arrive", []],
  ["in-shop", []],
  ["quote", schema.quote],
  ["approve-quote", []],
  ["start", []],
  ["ready", []],
  ["resolve", []],
  ["unfixable", schema.unfixable],
  ["acknowledge-unfixable", []],
  ["decline", schema.reason],
  ["estimate", schema.quote],
  ["approve-estimate", schema.estimateVersion],
  ["reject-estimate", schema.estimateVersion],
])
  router.post(
    "/:id/" + action,
    schema.id,
    validation,
    schema.revision,
    validate,
    async (req, res) =>
      R.success(
        res,
        await Service.action(req.user, req.validated.id, action, req.validated),
      ),
  );
for (const [path, kind, validation] of [
  ["retry-sos", "RETRY_SOS", []],
  ["request-tow", "TOW_HANDOFF", schema.destination],
  ["return-tow", "RETURN_TOW", schema.location],
])
  router.post(
    "/:id/" + path,
    schema.id,
    schema.handoff,
    validation,
    validate,
    async (req, res) =>
      R.created(
        res,
        await Service.handoff(req.user, req.validated.id, kind, req.validated),
      ),
  );
module.exports = router;
