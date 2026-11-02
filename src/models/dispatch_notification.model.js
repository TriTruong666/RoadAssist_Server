const { DataTypes: D } = require("sequelize");
module.exports = require("../config/postgres.config").define(
  "DispatchNotification",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    ticketId: { type: D.UUID, allowNull: false, field: "ticket_id" },
    recipientId: { type: D.UUID, allowNull: false, field: "recipient_id" },
    event: { type: D.STRING(40), allowNull: false },
    payload: { type: D.JSONB, allowNull: false },
    deliveredAt: { type: D.DATE, field: "delivered_at" },
    attempts: { type: D.INTEGER, defaultValue: 0, allowNull: false },
  },
  {
    tableName: "dispatch_notifications",
    indexes: [
      { fields: ["recipient_id", "createdAt"] },
      { fields: ["delivered_at"] },
    ],
  },
);
