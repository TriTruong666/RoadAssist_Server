const { DataTypes } = require("sequelize");
const sequelize = require("../config/postgres.config");
module.exports = sequelize.define(
  "AuthSession",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: { type: DataTypes.UUID, allowNull: false, field: "user_id" },
    tokenHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
      field: "token_hash",
    },
    sessionVersion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "session_version",
    },
    expiresAt: { type: DataTypes.DATE, allowNull: false, field: "expires_at" },
    revokedAt: { type: DataTypes.DATE, field: "revoked_at" },
    ipAddress: { type: DataTypes.STRING(50), field: "ip_address" },
    userAgent: { type: DataTypes.STRING(512), field: "user_agent" },
  },
  {
    tableName: "auth_sessions",
    timestamps: true,
    indexes: [{ fields: ["user_id"] }, { fields: ["expires_at"] }],
  },
);
