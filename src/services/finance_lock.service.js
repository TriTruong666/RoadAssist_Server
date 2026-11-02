const { Op } = require("sequelize");
const db = require("../config/postgres.config");
const { User, Provider, DispatchTicket: Ticket, Bill } = require("../models");
const retry = require("../utils/transaction_retry.util");
const {
  NotFoundException,
  ForbiddenException,
} = require("../common/exceptions/BaseException");
module.exports = {
  async transaction(work) {
    return retry(() =>
      db.transaction(async (transaction) => {
        await db.query("SET LOCAL lock_timeout = '3s'", { transaction });
        await db.query("SET LOCAL statement_timeout = '15s'", { transaction });
        return work(transaction);
      }),
    );
  },
  async lockJourneys(journeyIds, transaction, actor) {
    const snapshots = await Ticket.findAll({
      where: { journeyId: { [Op.in]: journeyIds } },
      transaction,
    });
    if (!snapshots.length)
      throw new NotFoundException("Không tìm thấy hành trình");
    const providers = await Provider.findAll({
      where: {
        id: { [Op.in]: snapshots.map((t) => t.providerId).filter(Boolean) },
      },
      transaction,
    });
    const users = [
      ...new Set([
        ...snapshots.map((t) => t.userId),
        ...providers.map((p) => p.userId),
        ...(actor ? [actor.userId] : []),
      ]),
    ].sort();
    for (const userId of users) {
      const user = await User.findOne({
        where: { userId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        actor?.userId === userId &&
        (!user || user.status !== "ACTIVE" || !user.emailVerifiedAt)
      )
        throw new ForbiddenException();
    }
    const rows = [];
    for (const snapshot of [...snapshots].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      const t = await Ticket.findByPk(snapshot.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (t.providerId !== snapshot.providerId) {
        const e = new Error("Assignment changed");
        e.original = { code: "40001" };
        throw e;
      }
      rows.push(t);
    }
    return rows;
  },
  async journey(journeyId, actor, work) {
    return this.transaction(async (transaction) => {
      const tickets = await this.lockJourneys([journeyId], transaction, actor);
      if (actor && tickets[0].userId !== actor.userId)
        throw new NotFoundException("Không tìm thấy hóa đơn");
      return work(transaction, tickets);
    });
  },
  async admin(actor, transaction) {
    const user = await User.findOne({
      where: { userId: actor.userId },
      transaction,
    });
    if (
      !user ||
      user.role !== "admin" ||
      user.status !== "ACTIVE" ||
      !user.emailVerifiedAt
    )
      throw new ForbiddenException();
  },
};
