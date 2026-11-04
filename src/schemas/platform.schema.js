const { body, param, query } = require("express-validator");
module.exports = {
  page: [
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("offset").optional().isInt({ min: 0, max: 100000 }).toInt(),
    query("deviceId").optional().isUUID(4),
  ],
  id: [param("id").isUUID(4)],
  providers: [
    query("kind").optional().isIn(["SHOP", "MOBILE_SHOP", "TOW"]),
    query("status")
      .optional()
      .isIn(["ACTIVE", "PENDING", "DENIED", "REVOKED", "SUSPENDED"]),
    query("q").optional().isString().trim().isLength({ max: 120 }),
  ],
  hazards: [
    query("category").optional().isIn(["FLOOD", "ACCIDENT", "OBSTRUCTION"]),
    query("status").optional().isIn(["1", "2", "3", "4"]),
  ],
  dispatches: [
    query("status")
      .optional()
      .isIn(Array.from({ length: 15 }, (_, i) => String(i + 1))),
    query("q").optional().isString().trim().isLength({ max: 30 }),
  ],
  monitor: [
    query("latitude").isFloat({ min: -85, max: 85 }).toFloat(),
    query("longitude").isFloat({ min: -180, max: 180 }).toFloat(),
    query("radiusKm").optional().isFloat({ min: 1, max: 50 }).toFloat(),
  ],
  announcement: [
    body("title").isString().trim().isLength({ min: 1, max: 160 }),
    body("content").isString().trim().isLength({ min: 1, max: 10000 }),
    body("target").isIn(["ALL", "RIDER", "PROVIDER"]),
    body("priority").isIn(["NORMAL", "IMPORTANT", "CRITICAL"]),
  ],
};
