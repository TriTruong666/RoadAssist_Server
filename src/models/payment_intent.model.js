const { DataTypes: D } = require("sequelize");
const money = (field) => ({
  type: D.DECIMAL(12, 2),
  allowNull: false,
  defaultValue: 0,
  field,
});
module.exports = require("../config/postgres.config").define(
  "PaymentIntent",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    billId: { type: D.UUID, allowNull: false, field: "bill_id" },
    userId: { type: D.UUID, allowNull: false, field: "user_id" },
    code: { type: D.STRING(30), unique: true, allowNull: false },
    method: { type: D.ENUM("SEPAY", "CASH"), allowNull: false },
    status: {
      type: D.ENUM("PENDING", "HELD", "CONFIRMED", "CANCELLED", "EXPIRED"),
      defaultValue: "PENDING",
      allowNull: false,
    },
    amount: money("amount"),
    receivedAmount: money("received_amount"),
    expiresAt: { type: D.DATE, field: "expires_at" },
    bankSnapshot: {
      type: D.JSONB,
      allowNull: false,
      defaultValue: {},
      field: "bank_snapshot",
    },
    clientRequestId: { type: D.UUID, field: "client_request_id" },
    fingerprint: { type: D.STRING(64), allowNull: false },
    cancelReason: { type: D.STRING(100), field: "cancel_reason" },
  },
  {
    tableName: "payment_intents",
    indexes: [
      { unique: true, fields: ["user_id", "client_request_id"] },
      { fields: ["bill_id", "status"] },
    ],
  },
);
