const { Op } = require("sequelize");
const db = require("./postgres.config");
const {
  HazardMessage: Legacy,
  ChatMessage: Message,
  HazardFlag,
  ChatRoom,
} = require("../models");
async function migrateHazardChat() {
  // Keep legacy rows intact, preserve IDs/time, and make reruns idempotent.
  const { literal } = require("sequelize");
  const qi = db.getQueryInterface();
  const target = qi.queryGenerator.quoteTable(Message.getTableName());
  const rows = await Legacy.findAll({
    where: {
      [Op.and]: literal(
        `NOT EXISTS (SELECT 1 FROM ${target} AS migrated WHERE migrated.id = "HazardMessage".id)`,
      ),
    },
    order: [["createdAt", "ASC"]],
    limit: 500,
  });
  for (const legacy of rows)
    await db.transaction(async (transaction) => {
      const flag = await HazardFlag.findByPk(legacy.flagId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!flag) return;
      const [room] = await ChatRoom.findOrCreate({
        where: { scope: "HAZARD", referenceId: flag.id, version: 1 },
        defaults: {
          isArchived: flag.status === "4" || flag.expiresAt <= new Date(),
        },
        transaction,
      });
      await Message.findOrCreate({
        where: { id: legacy.id },
        defaults: {
          roomId: room.id,
          senderId: legacy.userId,
          senderRole: "COMMUNITY",
          content: legacy.text,
          createdAt: legacy.createdAt,
          updatedAt: legacy.updatedAt,
        },
        transaction,
      });
    });
  return rows.length;
}
module.exports = { migrateHazardChat };
