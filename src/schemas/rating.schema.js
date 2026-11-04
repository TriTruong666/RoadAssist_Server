const { body, param, query } = require("express-validator");
module.exports = {
  create: [
    body("ticketId").isUUID(4),
    body("stars").isInt({ min: 1, max: 5 }).toInt(),
    body("content").optional().isString().trim().isLength({ max: 280 }),
  ],
  reply: [
    param("id").isUUID(4),
    body("content").isString().trim().isLength({ min: 1, max: 280 }),
  ],
  provider: [param("providerId").isUUID(4)],
  ticket: [param("ticketId").isUUID(4)],
  page: [
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("offset").optional().isInt({ min: 0, max: 100000 }).toInt(),
  ],
};
