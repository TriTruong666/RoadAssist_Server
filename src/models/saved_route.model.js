const { DataTypes: D } = require("sequelize");
const sequelize = require("../config/postgres.config");
module.exports = sequelize.define(
  "SavedRoute",
  {
    id: { type: D.UUID, defaultValue: D.UUIDV4, primaryKey: true },
    userId: { type: D.UUID, allowNull: false, field: "user_id" },
    name: { type: D.STRING(120), allowNull: false },
    stops: { type: D.JSONB, allowNull: false },
    geometry: { type: D.JSONB, allowNull: false },
    costing: { type: D.STRING(30), defaultValue: "auto", allowNull: false },
  },
  {
    tableName: "saved_routes",
    timestamps: true,
    indexes: [{ fields: ["user_id"] }],
  },
);
