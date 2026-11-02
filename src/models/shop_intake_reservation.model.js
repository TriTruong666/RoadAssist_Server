const { DataTypes: D } = require("sequelize");
module.exports = require("../config/postgres.config").define(
  "ShopIntakeReservation",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    ticketId: { type: D.UUID, allowNull: false, field: "ticket_id" },
    shopId: { type: D.UUID, allowNull: false, field: "shop_id" },
    childTicketId: { type: D.UUID, field: "child_ticket_id" },
    version: { type: D.INTEGER, allowNull: false },
    status: {
      type: D.ENUM(
        "REQUESTED",
        "ACCEPTED",
        "IN_TRANSIT",
        "DELIVERED",
        "CONSUMED",
        "DECLINED",
        "EXPIRED",
        "RELEASED",
      ),
      defaultValue: "REQUESTED",
      allowNull: false,
    },
    requestExpiresAt: {
      type: D.DATE,
      allowNull: false,
      field: "request_expires_at",
    },
    holdUntil: { type: D.DATE, field: "hold_until" },
    acceptedAt: { type: D.DATE, field: "accepted_at" },
    reason: { type: D.STRING(200) },
  },
  {
    tableName: "shop_intake_reservations",
    indexes: [
      { unique: true, fields: ["ticket_id", "version"] },
      { fields: ["shop_id", "status"] },
      { unique: true, fields: ["child_ticket_id"] },
    ],
  },
);
