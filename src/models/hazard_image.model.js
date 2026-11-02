const { DataTypes: D } = require("sequelize");
const sequelize = require("../config/postgres.config");
module.exports = sequelize.define(
  "HazardImage",
  {
    id: { type: D.UUID, defaultValue: D.UUIDV4, primaryKey: true },
    flagId: { type: D.UUID, allowNull: false, field: "flag_id" },
    s3Key: { type: D.STRING(255), field: 's3_key' },
    url: { type: D.STRING(2048) },
    content: { type: D.BLOB, allowNull: true },
    mimeType: { type: D.STRING, allowNull: false },
    size: { type: D.INTEGER, allowNull: false },
  },
  {
    tableName: "hazard_images",
    timestamps: true,
    indexes: [],
    defaultScope: { attributes: { exclude: ["content"] } },
  },
);
