const { DataTypes: D, Op } = require("sequelize");
module.exports = require("../config/postgres.config").define(
  "Refund",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    billId: { type: D.UUID, allowNull: false, field: "bill_id" },
    paymentId: { type: D.UUID, field: "payment_id" },
    intentId: { type: D.UUID, field: "intent_id" },
    disputeId: { type: D.UUID, unique: true, field: "dispute_id" },
    amount: { type: D.DECIMAL(12, 2), allowNull: false },
    status: {
      type: D.ENUM("PENDING", "COMPLETED", "CANCELLED"),
      allowNull: false,
      defaultValue: "PENDING",
    },
    reason: { type: D.STRING(80), allowNull: false },
    externalReference: { type: D.STRING(150), field: "external_reference" },
    completedBy: { type: D.UUID, field: "completed_by" },
    completedAt: { type: D.DATE, field: "completed_at" },
  },
  {
    tableName: "refunds",
    indexes: [
      {
        unique: true,
        fields: ["payment_id"],
        where: { status: "PENDING", payment_id: { [Op.ne]: null } },
      },
      {
        unique: true,
        fields: ["intent_id"],
        where: { status: "PENDING", payment_id: null },
      },
      { unique: true, fields: ["external_reference"] },
    ],
  },
);
