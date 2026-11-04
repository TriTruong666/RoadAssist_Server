const { DataTypes: D } = require("sequelize");
const db = require("../config/postgres.config");
module.exports = db.define(
  "Rating",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    ticketId: { type: D.UUID, allowNull: false, field: "ticket_id" },
    authorId: { type: D.UUID, allowNull: false, field: "author_id" },
    targetUserId: { type: D.UUID, allowNull: false, field: "target_user_id" },
    providerId: { type: D.UUID, allowNull: false, field: "provider_id" },
    targetKind: {
      type: D.ENUM("SHOP", "RIDER"),
      allowNull: false,
      field: "target_kind",
    },
    stars: { type: D.INTEGER, allowNull: false, validate: { min: 1, max: 5 } },
    content: { type: D.STRING(280), allowNull: false, defaultValue: "" },
    replyContent: { type: D.STRING(280), field: "reply_content" },
    repliedAt: { type: D.DATE, field: "replied_at" },
  },
  {
    tableName: "ratings",
    indexes: [
      { unique: true, fields: ["ticket_id", "author_id"] },
      { fields: ["provider_id", "target_kind"] },
      { fields: ["target_user_id", "target_kind"] },
    ],
  },
);
