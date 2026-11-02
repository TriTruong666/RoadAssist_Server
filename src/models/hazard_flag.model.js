const { DataTypes: D } = require("sequelize");
const sequelize = require("../config/postgres.config");
module.exports = sequelize.define(
  "HazardFlag",
  {
    id: { type: D.UUID, defaultValue: D.UUIDV4, primaryKey: true },
    userId: { type: D.UUID, allowNull: false, field: "user_id" },
    category: {
      type: D.ENUM("FLOOD", "ACCIDENT", "OBSTRUCTION"),
      allowNull: false,
      defaultValue: "FLOOD",
    },
    description: D.STRING(500),
    latitude: { type: D.DOUBLE, allowNull: false },
    longitude: { type: D.DOUBLE, allowNull: false },
    address: D.STRING(255),
    radiusMeters: {
      type: D.INTEGER,
      defaultValue: 50,
      allowNull: false,
      field: "radius_meters",
      validate: { isIn: [[25, 50, 100, 200, 250]] },
    },
    status: {
      type: D.ENUM("1", "2", "3", "4"),
      defaultValue: "1",
      allowNull: false,
    },
    confirmVotes: {
      type: D.INTEGER,
      defaultValue: 0,
      allowNull: false,
      field: "confirm_votes",
    },
    denyVotes: {
      type: D.INTEGER,
      defaultValue: 0,
      allowNull: false,
      field: "deny_votes",
    },
    ttlMinutes: {
      type: D.INTEGER,
      defaultValue: 120,
      allowNull: false,
      field: "ttl_minutes",
      validate: { isIn: [[60, 120, 240, 720, 1440]] },
    },
    expiresAt: { type: D.DATE, allowNull: false, field: "expires_at" },
    reputationAwardedAt: { type: D.DATE, field: "reputation_awarded_at" },
    removedReason: D.STRING(40),
  },
  {
    tableName: "hazard_flags",
    timestamps: true,
    indexes: [
      { fields: ["status", "expires_at"] },
      { fields: ["latitude", "longitude"] },
    ],
  },
);
