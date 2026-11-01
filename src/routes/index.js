const { Router } = require("express");
const router = Router();
const v1 = Router();
// Mount RoadAssist feature routers here as they are implemented.
router.use("/v1", v1);
module.exports = router;
