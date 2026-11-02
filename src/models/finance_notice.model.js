const { DataTypes: D } = require("sequelize");
module.exports = require("../config/postgres.config").define(
  "FinanceNotice",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    userId: { type: D.UUID, allowNull: false, field: "user_id" },
    event: { type: D.STRING(50), allowNull: false },
    payload: { type: D.JSONB, allowNull: false },
    deliveredAt: { type: D.DATE, field: "delivered_at" },
  },
  {
    tableName: "finance_notices",
    indexes: [
      { fields: ["user_id", "createdAt"] },
      { fields: ["delivered_at"] },
    ],
  },
);
