const { DataTypes: D } = require("sequelize");
const Event = require("../config/postgres.config").define(
  "FinanceEvent",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    billId: { type: D.UUID, field: "bill_id" },
    actorId: { type: D.UUID, field: "actor_id" },
    action: { type: D.STRING(60), allowNull: false },
    referenceId: { type: D.UUID, field: "reference_id" },
    details: { type: D.JSONB, defaultValue: {}, allowNull: false },
  },
  {
    tableName: "finance_events",
    updatedAt: false,
    indexes: [{ fields: ["bill_id", "createdAt"] }],
  },
);
for (const hook of [
  "beforeUpdate",
  "beforeDestroy",
  "beforeBulkUpdate",
  "beforeBulkDestroy",
])
  Event.addHook(hook, () => {
    throw new Error("Finance events are append-only");
  });
module.exports = Event;
