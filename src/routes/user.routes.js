const router = require("express").Router();
const controller = require("../controllers/user.controller");
const schema = require("../schemas/user.schema");
const validate = require("../middlewares/validate.middleware");
const { protect, requireServices } = require("../middlewares/auth.middleware");
router.use(protect);
router.post('/devices', schema.device, validate, controller.registerDevice);
router.get('/devices', controller.devices);
router.get('/payout-account', controller.payoutAccount);
router.put('/payout-account', schema.payout, validate, controller.savePayoutAccount);
router.get("/me", controller.me);
router.put("/me", schema.update, validate, controller.update);
router.put("/onboard", schema.onboard, validate, controller.onboard);
router.put(
  "/active-vehicle",
  requireServices("RIDER"),
  schema.activeVehicle,
  validate,
  controller.activeVehicle,
);
module.exports = router;
