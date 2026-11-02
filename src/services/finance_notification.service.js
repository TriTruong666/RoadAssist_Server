const { Op } = require("sequelize");
const { FinanceNotice } = require("../models");
let io;
module.exports = {
  setIO(value) {
    io = value;
  },
  async enqueue(users, event, payload, transaction) {
    for (const userId of new Set(users.filter(Boolean)))
      await FinanceNotice.create({ userId, event, payload }, { transaction });
    transaction.afterCommit(async () => {
      try {
        await this.deliver();
      } catch (e) {
        console.error("[Finance notice]", e.message);
      }
    });
  },
  async deliver() {
    if (!io) return;
    const online = [...io.sockets.adapter.rooms.keys()]
      .filter((k) => k.startsWith("user:"))
      .map((k) => k.slice(5));
    if (!online.length) return;
    const rows = await FinanceNotice.findAll({
      where: { userId: { [Op.in]: online }, deliveredAt: null },
      order: [["createdAt", "ASC"]],
      limit: 100,
    });
    for (const row of rows) {
      io.to(`user:${row.userId}`).emit(row.event, {
        notificationId: row.id,
        ...row.payload,
      });
      await row.update({ deliveredAt: new Date() });
    }
  },
};
