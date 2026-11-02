const { body, query } = require("express-validator");
const Money = require("../utils/money.util");
const assets = [
  body("assetIds").optional().isArray({ max: 8 }),
  body("assetIds.*").isUUID(),
];
const note = [body("note").isString().trim().isLength({ min: 3, max: 2000 })];
const reservation = [
  body("handoverId").isUUID(),
  body("expectedRevision").optional().isInt({ min: 1 }).toInt(),
];
module.exports = {
  handover: [
    body("phase").isIn(["PICKUP", "DELIVERY"]),
    body("condition").isString().trim().isLength({ min: 3, max: 2000 }),
    body("assetIds").isArray({ min: 2, max: 8 }),
    body("assetIds.*").isUUID(),
    body("damages").isArray({ max: 30 }),
    body("damages.*.part").isString().trim().isLength({ min: 1, max: 100 }),
    body("damages.*.description")
      .isString()
      .trim()
      .isLength({ min: 3, max: 500 }),
    body("expectedRevision").optional().isInt({ min: 1 }).toInt(),
  ],
  response: [
    ...reservation,
    ...assets,
    body("note").optional().isString().trim().isLength({ max: 1000 }),
  ],
  rejection: [
    ...reservation,
    ...assets,
    body("note").isString().trim().isLength({ min: 3, max: 1000 }),
  ],
  open: [
    body("ticketId").isUUID(),
    body("reason").isIn([
      "LATE",
      "NO_SHOW",
      "OVERCHARGE",
      "UNSAFE",
      "RUDE",
      "POOR_QUALITY",
      "VEHICLE_DAMAGE",
      "OTHER",
    ]),
    ...note,
    ...assets,
  ],
  evidence: [...note, ...assets],
  list: [
    query("status").optional().isIn(["OPEN", "REVIEW", "RESOLVED", "REJECTED"]),
  ],
  resolve: [
    body("resolution").isIn([
      "FAVOR_RIDER",
      "FAVOR_PROVIDER",
      "PARTIAL_REFUND",
      "NO_ACTION",
    ]),
    ...note,
    body("amount")
      .optional()
      .custom((value) => {
        if (Money.cents(value) % 100)
          throw new Error("Số tiền VND phải nguyên đồng");
        return true;
      }),
    body("amount").custom(
      (value, { req }) =>
        req.body.resolution !== "PARTIAL_REFUND" || value !== undefined,
    ),
  ],
};
