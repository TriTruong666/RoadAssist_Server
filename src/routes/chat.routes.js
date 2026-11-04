const router = require("express").Router();
const Chat = require("../services/chat.service");
const schema = require("../schemas/chat.schema");
const validate = require("../middlewares/validate.middleware");
const Response = require("../common/response.handler");
router.use(require("../middlewares/auth.middleware").protect);
router.get(
  "/:scope/:referenceId",
  schema.reference,
  schema.page,
  validate,
  async (req, res) =>
    Response.success(
      res,
      await Chat.list(
        req.user,
        req.validated.scope,
        req.validated.referenceId,
        req.validated,
      ),
    ),
);
router.get(
  "/:scope/:referenceId/history",
  schema.reference,
  schema.history,
  validate,
  async (req, res) =>
    Response.success(
      res,
      await Chat.history(
        req.user,
        req.validated.scope,
        req.validated.referenceId,
        req.validated,
      ),
    ),
);
router.post(
  "/:scope/:referenceId/messages",
  require("../middlewares/upload.middleware"),
  schema.reference,
  schema.message,
  validate,
  async (req, res) => {
    const { scope, referenceId } = req.validated;
    const message = await Chat.send(
      req.user,
      scope,
      referenceId,
      req.validated,
      req.files,
    );
    Chat.broadcast(req.app, scope, referenceId, message);
    Response.created(res, message);
  },
);
module.exports = router;
