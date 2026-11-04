const router = require("express").Router();
const controller = require("../controllers/auth.controller");
const schema = require("../schemas/auth.schema");
const validate = require("../middlewares/validate.middleware");
router.post("/register", schema.register, validate, controller.register);
router.post(
  "/register-provider",
  schema.registerProvider,
  validate,
  controller.registerProvider,
);
router.post("/login", schema.login, validate, controller.login);
router.post("/verify-email", schema.verifyOtp, validate, controller.verifyOtp);
router.post(
  "/resend-verification",
  schema.resendVerification,
  validate,
  controller.resendVerification,
);
router.post(
  "/send-verification",
  schema.sendVerification,
  validate,
  controller.sendVerification,
);
// Compatibility alias: verifies registration email only, never a login IP.
router.post("/verify-otp", schema.verifyOtp, validate, controller.verifyOtp);
router.post("/refresh-token", controller.refresh);
router.post("/logout", controller.logout);
router.post("/forgot-password", schema.forgot, validate, controller.forgot);
router.post("/reset-password", schema.reset, validate, controller.reset);
module.exports = router;
