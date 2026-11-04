const { DataTypes: D } = require("sequelize");
const db = require("../config/postgres.config");
const id = () => ({ type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 });
const money = (field) => ({
  type: D.DECIMAL(12, 2),
  allowNull: false,
  defaultValue: 0,
  field,
});
const PayoutBatch = db.define(
  "PayoutBatch",
  {
    id: id(),
    status: {
      type: D.ENUM("PENDING", "SETTLED", "CANCELLED"),
      allowNull: false,
      defaultValue: "PENDING",
    },
    createdBy: { type: D.UUID, allowNull: false, field: "created_by" },
    settledBy: { type: D.UUID, field: "settled_by" },
    settledAt: { type: D.DATE, field: "settled_at" },
    gross: money("gross"),
    commission: money("commission"),
    net: money("net"),
    settlementFingerprint: {
      type: D.STRING(64),
      field: "settlement_fingerprint",
    },
    cancelReason: { type: D.STRING(200), field: "cancel_reason" },
  },
  { tableName: "payout_batches" },
);
const PayoutEntry = db.define(
  "PayoutEntry",
  {
    id: id(),
    batchId: { type: D.UUID, allowNull: false, field: "batch_id" },
    userId: { type: D.UUID, allowNull: false, field: "user_id" },
    onlineGross: money("online_gross"),
    cashGross: money("cash_gross"),
    onlineCommission: money("online_commission"),
    cashCommission: money("cash_commission"),
    debtOffset: money("debt_offset"),
    recoveryOffset: money("recovery_offset"),
    netAmount: money("net_amount"),
    bankSnapshot: { type: D.JSONB, field: "bank_snapshot" },
    externalReference: { type: D.STRING(150), field: "external_reference" },
  },
  {
    tableName: "payout_entries",
    indexes: [
      { unique: true, fields: ["batch_id", "user_id"] },
      { unique: true, fields: ["external_reference"] },
    ],
  },
);
const PayoutOffset = db.define(
  "PayoutOffset",
  {
    id: id(),
    batchId: { type: D.UUID, allowNull: false, field: "batch_id" },
    paymentId: { type: D.UUID, allowNull: false, field: "payment_id" },
    amount: money("amount"),
    status: {
      type: D.ENUM("RESERVED", "SETTLED", "CANCELLED"),
      defaultValue: "RESERVED",
      allowNull: false,
    },
  },
  {
    tableName: "payout_offsets",
    indexes: [{ unique: true, fields: ["batch_id", "payment_id"] }],
  },
);
module.exports = { PayoutBatch, PayoutEntry, PayoutOffset };
