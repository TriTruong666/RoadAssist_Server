const {
  ProviderRecovery: Recovery,
  RecoveryOffset: Offset,
  DisputeEvent: Event,
} = require("../models");
const Money = require("../utils/money.util");
const fail = require("./dispatch_policy.service").fail;
module.exports = {
  async balances(userId, transaction) {
    const rows = await Recovery.findAll({
      where: { userId },
      order: [["id", "ASC"]],
      transaction,
    });
    const out = [];
    for (const row of rows) {
      const settled = Money.cents(
        (await Offset.sum("amount", {
          where: { recoveryId: row.id, status: "SETTLED" },
          transaction,
        })) || 0,
      );
      const reserved = Money.cents(
        (await Offset.sum("amount", {
          where: { recoveryId: row.id, status: "RESERVED" },
          transaction,
        })) || 0,
      );
      out.push({
        id: row.id,
        disputeId: row.disputeId,
        amount: row.amount,
        outstanding: Money.amount(
          Math.max(0, Money.cents(row.amount) - settled),
        ),
        available: Math.max(0, Money.cents(row.amount) - settled - reserved),
      });
    }
    return out;
  },
  async reserve(userId, batchId, available, transaction, actorId = null) {
    let used = 0;
    for (const debt of await this.balances(userId, transaction)) {
      const amount = Math.min(debt.available, available - used);
      if (amount > 0) {
        const offset = await Offset.create(
          { batchId, recoveryId: debt.id, amount: Money.amount(amount) },
          { transaction },
        );
        await Event.create(
          {
            disputeId: debt.disputeId,
            actorId,
            action: "RECOVERY_RESERVED",
            details: { batchId, offsetId: offset.id, amount: offset.amount },
          },
          { transaction },
        );
        used += amount;
      }
    }
    return used;
  },
  async settle(batchId, transaction, actorId = null) {
    const rows = await Offset.findAll({
      where: { batchId, status: "RESERVED" },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const row of rows) {
      const debt = await Recovery.findByPk(row.recoveryId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const settled = Money.cents(
        (await Offset.sum("amount", {
          where: { recoveryId: debt.id, status: "SETTLED" },
          transaction,
        })) || 0,
      );
      if (settled + Money.cents(row.amount) > Money.cents(debt.amount))
        fail("RECOVERY_EXCEEDS_BALANCE", "Cấn trừ vượt nghĩa vụ tranh chấp");
      await row.update({ status: "SETTLED" }, { transaction });
      await Event.create(
        {
          disputeId: debt.disputeId,
          actorId,
          action: "RECOVERY_SETTLED",
          details: { batchId, offsetId: row.id, amount: row.amount },
        },
        { transaction },
      );
    }
  },
  async cancel(batchId, transaction, actorId = null) {
    const rows = await Offset.findAll({
      where: { batchId, status: "RESERVED" },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const row of rows) {
      const debt = await Recovery.findByPk(row.recoveryId, { transaction });
      await row.update({ status: "CANCELLED" }, { transaction });
      await Event.create(
        {
          disputeId: debt.disputeId,
          actorId,
          action: "RECOVERY_RESERVATION_CANCELLED",
          details: { batchId, offsetId: row.id, amount: row.amount },
        },
        { transaction },
      );
    }
  },
};
