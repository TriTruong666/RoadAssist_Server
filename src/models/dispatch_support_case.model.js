const { DataTypes: D } = require("sequelize");
module.exports = require("../config/postgres.config").define(
  "DispatchSupportCase",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    ticketId: { type: D.UUID, allowNull: false, field: "ticket_id" },
    requesterId: { type: D.UUID, field: "requester_id" },
    reason: {
      type: D.ENUM(
        "NO_PROGRESS",
        "MISSED_ETA",
        "GPS_LOST_IN_TRANSIT",
        "DESTINATION_UNAVAILABLE",
        "CUSTOMER_REQUEST",
        "INTAKE_TIMEOUT",
      ),
      allowNull: false,
    },
    note: { type: D.STRING(500) },
    status: {
      type: D.ENUM("OPEN", "RESOLVED"),
      allowNull: false,
      defaultValue: "OPEN",
    },
    resolution: { type: D.STRING(1000) },
    resolvedBy: { type: D.UUID, field: "resolved_by" },
    resolvedAt: { type: D.DATE, field: "resolved_at" },
  },
  {
    tableName: "dispatch_support_cases",
    indexes: [
      { unique: true, fields: ["ticket_id"], where: { status: "OPEN" } },
      { fields: ["status", "createdAt"] },
    ],
  },
);
