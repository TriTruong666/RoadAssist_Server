const { DataTypes: D } = require("sequelize");
const sequelize = require("../config/postgres.config");
module.exports = sequelize.define(
  "HazardVote",
  {
    id: { type: D.UUID, defaultValue: D.UUIDV4, primaryKey: true },
    userId: { type: D.UUID, allowNull: false, field: "user_id" },
    flagId: { type: D.UUID, allowNull: false, field: "flag_id" },
    voteType: {
      type: D.ENUM("CONFIRM", "DENY"),
      allowNull: false,
      field: "vote_type",
    },
  },
  {
    tableName: "hazard_votes",
    timestamps: true,
    indexes: [{ unique: true, fields: ["user_id", "flag_id"] }],
  },
);
