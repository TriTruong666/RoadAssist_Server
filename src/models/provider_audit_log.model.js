const { DataTypes } = require("sequelize");
const sequelize = require("../config/postgres.config");
const immutable = () => {
  throw new Error("Provider audit history is append-only");
};
module.exports = sequelize.define(
  "ProviderAuditLog",
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    providerId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "provider_id",
    },
    actorUserId: { type: DataTypes.UUID, field: "actor_user_id" },
    action: { type: DataTypes.STRING(50), allowNull: false },
    reason: { type: DataTypes.STRING(500) },
    before: { type: DataTypes.JSONB },
    after: { type: DataTypes.JSONB, allowNull: false },
  },
  {
    tableName: "provider_audit_logs",
    timestamps: true,
    updatedAt: false,
    indexes: [{ fields: ["provider_id", "createdAt"] }],
    hooks: {
      beforeUpdate: immutable,
      beforeDestroy: immutable,
      beforeBulkUpdate: immutable,
      beforeBulkDestroy: immutable,
    },
  },
);
