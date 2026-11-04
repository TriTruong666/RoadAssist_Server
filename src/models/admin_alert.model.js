const { DataTypes: D } = require("sequelize");
module.exports = require("../config/postgres.config").define(
  "AdminAlert",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    userId: { type: D.UUID, allowNull: false, field: "user_id" },
    kind: { type: D.STRING(30), allowNull: false },
    referenceId: { type: D.UUID, allowNull: false, field: "reference_id" },
    occurrenceKey: {
      type: D.STRING(100),
      allowNull: false,
      field: "occurrence_key",
    },
    message: { type: D.STRING(160), allowNull: false },
    readAt: { type: D.DATE, field: "read_at" },
  },
  {
    tableName: "admin_alerts",
    indexes: [
      { unique: true, fields: ["user_id", "kind", "occurrence_key"] },
      { fields: ["user_id", "read_at", "createdAt"] },
    ],
  },
);
