const { DataTypes: D } = require("sequelize");
const db = require("../config/postgres.config");
const Event = db.define(
  "DispatchEvent",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    ticketId: { type: D.UUID, allowNull: false, field: "ticket_id" },
    actorId: { type: D.UUID, field: "actor_id" },
    action: { type: D.STRING(40), allowNull: false },
    fromStatus: { type: D.STRING(2), field: "from_status" },
    toStatus: { type: D.STRING(2), allowNull: false, field: "to_status" },
    revision: { type: D.INTEGER, allowNull: false },
    details: { type: D.JSONB, defaultValue: {}, allowNull: false },
  },
  {
    tableName: "dispatch_events",
    updatedAt: false,
    indexes: [{ fields: ["ticket_id", "createdAt"] }],
  },
);
for (const hook of [
  "beforeUpdate",
  "beforeDestroy",
  "beforeBulkUpdate",
  "beforeBulkDestroy",
])
  Event.addHook(hook, () => {
    throw new Error("Dispatch events are append-only");
  });
module.exports = Event;
