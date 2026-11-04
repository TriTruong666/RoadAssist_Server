const { DataTypes: D } = require("sequelize");
module.exports = require("../config/postgres.config").define(
  "StorageCleanup",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    key: { type: D.STRING(255), unique: true, allowNull: false },
    attempts: { type: D.INTEGER, defaultValue: 0, allowNull: false },
  },
  { tableName: "storage_cleanup" },
);
