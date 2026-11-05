const { query, param, body } = require("express-validator");
module.exports = {
  id: [param("id").isUUID(4)],
  list: [
    query("page").optional().isInt({ min: 1, max: 100000 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("search").optional().isString().trim().isLength({ max: 150 }),
    query("role").optional().isIn(["admin", "guest", "provider"]),
    query("sort").optional().isIn(["by_date", "by_status"]),
  ],
  update: [
    body("name").optional().isString().trim().isLength({ min: 1, max: 120 }),
    body("phone")
      .optional()
      .isString()
      .bail()
      .customSanitizer((value) => value.replace(/[\s().-]/g, ""))
      .matches(/^\+?\d{9,15}$/),
    body("status").optional().isIn(["ACTIVE", "INACTIVE", "BANNED"]),
    body("approved").optional().isBoolean().toBoolean(),
  ],
};
