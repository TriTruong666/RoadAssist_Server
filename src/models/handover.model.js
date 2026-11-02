const { DataTypes: D } = require("sequelize");
const db = require("../config/postgres.config");
const Handover = db.define(
  "Handover",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    ticketId: { type: D.UUID, allowNull: false, field: "ticket_id" },
    phase: { type: D.ENUM("PICKUP", "DELIVERY"), allowNull: false },
    version: { type: D.INTEGER, allowNull: false },
    providerId: { type: D.UUID, allowNull: false, field: "provider_id" },
    authorId: { type: D.UUID, allowNull: false, field: "author_id" },
    recipientId: { type: D.UUID, allowNull: false, field: "recipient_id" },
    destinationShopId: { type: D.UUID, field: "destination_shop_id" },
    images: { type: D.ARRAY(D.STRING(2048)), allowNull: false },
    assetIds: { type: D.ARRAY(D.UUID), allowNull: false, field: "asset_ids" },
    condition: { type: D.STRING(2000), allowNull: false },
    damages: { type: D.JSONB, allowNull: false, defaultValue: [] },
    fingerprint: { type: D.STRING(64), allowNull: false },
    status: {
      type: D.ENUM("PENDING", "CONFIRMED", "REJECTED", "SUPERSEDED"),
      defaultValue: "PENDING",
      allowNull: false,
    },
    confirmedAt: { type: D.DATE, field: "confirmed_at" },
    responseNote: { type: D.STRING(1000), field: "response_note" },
    responseImages: {
      type: D.ARRAY(D.STRING(2048)),
      defaultValue: [],
      allowNull: false,
      field: "response_images",
    },
    locationSnapshot: {
      type: D.JSONB,
      allowNull: false,
      field: "location_snapshot",
    },
  },
  {
    tableName: "handovers",
    indexes: [
      { unique: true, fields: ["ticket_id", "phase", "version"] },
      { fields: ["ticket_id", "status"] },
    ],
  },
);
Handover.addHook("beforeUpdate", (row) => {
  const allowed = [
    "status",
    "confirmedAt",
    "responseNote",
    "responseImages",
    "updatedAt",
  ];
  if ((row.changed() || []).some((field) => !allowed.includes(field)))
    throw new Error("Handover evidence is immutable; create a new version");
  const prior = row.previous("status");
  if (
    prior !== "PENDING" &&
    !(prior === "CONFIRMED" && row.status === "SUPERSEDED")
  )
    throw new Error("Final handover responses are immutable");
});
for (const hook of ["beforeDestroy", "beforeBulkDestroy", "beforeBulkUpdate"])
  Handover.addHook(hook, () => {
    throw new Error("Handover history cannot be rewritten");
  });
module.exports = Handover;
