const { Router } = require("express");
const router = Router();
const v1 = Router();
v1.use('/auth', require('./auth.routes'));
router.use("/v1", v1);
module.exports = router;
