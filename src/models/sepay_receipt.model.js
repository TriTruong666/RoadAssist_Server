const { DataTypes: D } = require("sequelize");
module.exports = require("../config/postgres.config").define(
  "SepayReceipt",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    eventId: {
      type: D.STRING(80),
      unique: true,
      allowNull: false,
      field: "event_id",
    },
    bankReference: {
      type: D.STRING(255),
      unique: true,
      field: "bank_reference",
    },
    payload: { type: D.JSONB, allowNull: false },
    payloadHash: {
      type: D.STRING(64),
      allowNull: false,
      field: "payload_hash",
    },
    intentId: { type: D.UUID, field: "intent_id" },
    resolvedCode: { type: D.STRING(30), field: "resolved_code" },
    status: {
      type: D.ENUM("RECEIVED", "APPLIED", "REVIEW", "IGNORED", "REFUNDED"),
      allowNull: false,
      defaultValue: "RECEIVED",
    },
    reason: { type: D.STRING(80) },
    attempts: { type: D.INTEGER, defaultValue: 0, allowNull: false },
    processedAt: { type: D.DATE, field: "processed_at" },
  },
  {
    tableName: "sepay_receipts",
    indexes: [{ fields: ["status", "createdAt"] }],
  },
);
