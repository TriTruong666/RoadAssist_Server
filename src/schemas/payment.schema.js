const { body, param, query } = require("express-validator");
const Money = require("../utils/money.util");
const page = [
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("offset").optional().isInt({ min: 0, max: 100000 }).toInt(),
];
module.exports = {
  reconcile: [
    body("intentId").isUUID(),
    body("reason").isString().trim().isLength({ min: 3, max: 200 }),
  ],
  page,
  id: [param("id").isUUID()],
  create: [
    body("billId").isUUID(),
    body("billItemId").optional().isUUID(),
    body("ticketId").optional().isUUID(),
    body("clientRequestId").optional().isUUID(),
  ],
  cash: [body("paymentId").isUUID()],
  reference: [
    body("externalReference").isString().trim().isLength({ min: 3, max: 150 }),
  ],
  reason: [body("reason").isString().trim().isLength({ min: 3, max: 200 })],
  settle: [
    body("transfers").isArray({ max: 1000 }),
    body("transfers.*.entryId").isUUID(),
    body("transfers.*.amount").custom((v) => {
      Money.cents(v);
      return true;
    }),
    body("transfers.*.reference")
      .isString()
      .trim()
      .isLength({ min: 3, max: 150 }),
  ],
  webhook: [
    body("id").custom(
      (v) =>
        (typeof v === "number" && Number.isSafeInteger(v) && v > 0) ||
        (typeof v === "string" && /^\d{1,30}$/.test(v)),
    ),
    body("gateway").isString().isLength({ min: 1, max: 100 }),
    body("accountNumber").isString().isLength({ min: 1, max: 100 }),
    body("subAccount")
      .optional({ nullable: true })
      .isString()
      .isLength({ max: 100 }),
    body("content").isString().isLength({ max: 2000 }),
    body("code").optional({ nullable: true }).isString().isLength({ max: 100 }),
    body("transferType").isIn(["in", "out"]),
    body("transferAmount").custom(
      (v) =>
        typeof v === "number" &&
        Number.isSafeInteger(v) &&
        v > 0 &&
        v <= 9999999999,
    ),
    body("referenceCode")
      .optional({ nullable: true })
      .isString()
      .isLength({ max: 100 }),
    body("transactionDate").optional().isString().isLength({ max: 50 }),
  ],
};
