const { DataTypes: D } = require("sequelize");
const sequelize = require("../config/postgres.config");
module.exports = sequelize.define(
  "HazardMessage",
  {
    id: { type: D.UUID, defaultValue: D.UUIDV4, primaryKey: true },
    flagId: { type: D.UUID, allowNull: false, field: "flag_id" },
    userId: { type: D.UUID, allowNull: false, field: "user_id" },
    text: { type: D.STRING(1000), allowNull: false },
  },
  {
    tableName: "hazard_messages",
    timestamps: true,
    indexes: [{ fields: ["flag_id", "createdAt"] }],
  },
);
