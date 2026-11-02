const { Op } = require("sequelize");
const db = require("../config/postgres.config");
const { createHash } = require("node:crypto");
const {
  BillPayment: Pay,
  BillItem: Item,
  DispatchTicket: Ticket,
  Bill,
  Refund,
  PayoutBatch: Batch,
  PayoutEntry: Entry,
  PayoutOffset: Offset,
} = require("../models");
const Locks = require("./finance_lock.service");
const Money = require("../utils/money.util");
const Bills = require("./bill.service");
const Notice = require("./finance_notification.service");
const Policy = require("./dispatch_policy.service");
const config = require("../config/app.config").sepay;
class Payouts {
  static async eligible(payment, transaction) {
    if (payment.status !== "CONFIRMED" || !Money.cents(payment.appliedAmount))
      return false;
    const item = await Item.findByPk(payment.billItemId, { transaction });
    const t = item
      ? await Ticket.findByPk(item.ticketId, { transaction })
      : null;
    if (
      !t ||
      !["4", "12"].includes(t.status) ||
      t.disputeHold ||
      !t.resolvedAt ||
      new Date(t.resolvedAt) > new Date(Date.now() - config.holdDays * 86400000)
    )
      return false;
    if (
      await Refund.count({
        where: { paymentId: payment.id, status: "PENDING" },
        transaction,
      })
    )
      return false;
    const Dispute = db.models.Dispute;
    if (
      Dispute &&
      (await Dispute.count({
        where: { ticketId: t.id, status: "OPEN" },
        transaction,
      }))
    )
      return false;
    return true;
  }
  static async candidates(transaction) {
    const rows = await Pay.findAll({
      where: {
        status: "CONFIRMED",
        [Op.or]: [
          { payoutBatchId: null },
          { method: "CASH", cashCommissionOutstanding: { [Op.gt]: 0 } },
        ],
      },
      order: [["id", "ASC"]],
      transaction,
    });
    const out = [];
    for (const p of rows) if (await this.eligible(p, transaction)) out.push(p);
    return out;
  }
  static async pending(actor, { limit = 50, offset = 0 }) {
    await Locks.admin(actor);
    return (await this.candidates()).slice(offset, offset + limit);
  }
  static async locked(actor, work) {
    return Locks.transaction(async (transaction) => {
      await db.query("SELECT pg_advisory_xact_lock(657193, 6)", {
        transaction,
      });
      await Locks.admin(actor, transaction);
      const snapshots = await Pay.findAll({
        where: { status: "CONFIRMED" },
        transaction,
        attributes: ["billId"],
      });
      const bills = await Bill.findAll({
        where: {
          id: { [Op.in]: [...new Set(snapshots.map((p) => p.billId))] },
        },
        transaction,
      });
      const journeys = [...new Set(bills.map((b) => b.journeyId))];
      if (journeys.length)
        await Locks.lockJourneys(journeys, transaction, actor);
      return work(transaction);
    });
  }
  static async create(actor) {
    return this.locked(actor, async (transaction) => {
      const candidates = await this.candidates(transaction);
      if (!candidates.length)
        Policy.fail("PAYOUT_EMPTY", "Không có khoản thu đủ điều kiện đối soát");
      const rows = [];
      for (const p of candidates)
        rows.push(
          await Pay.findByPk(p.id, {
            transaction,
            lock: transaction.LOCK.UPDATE,
          }),
        );
      const fresh = rows.filter((p) => !p.payoutBatchId);
      if (!fresh.length)
        Policy.fail("PAYOUT_EMPTY", "Không có khoản thu mới đủ điều kiện");
      const batch = await Batch.create(
        { createdBy: actor.userId },
        { transaction },
      );
      const owners = [...new Set(fresh.map((p) => p.providerUserId))];
      let gross = 0,
        commission = 0,
        net = 0;
      for (const owner of owners) {
        const newRows = fresh.filter((p) => p.providerUserId === owner);
        const online = newRows.filter((p) => p.method === "SEPAY");
        const cash = newRows.filter((p) => p.method === "CASH");
        const onlineGross = online.reduce(
            (n, p) => n + Money.cents(p.appliedAmount),
            0,
          ),
          cashGross = cash.reduce(
            (n, p) => n + Money.cents(p.appliedAmount),
            0,
          ),
          onlineCommission = online.reduce(
            (n, p) => n + Money.cents(p.commissionAmount),
            0,
          ),
          cashCommission = cash.reduce(
            (n, p) => n + Money.cents(p.commissionAmount),
            0,
          );
        let available = onlineGross - onlineCommission;
        let offset = 0;
        for (const debt of rows.filter(
          (p) =>
            p.providerUserId === owner &&
            p.method === "CASH" &&
            Money.cents(p.cashCommissionOutstanding) > 0,
        )) {
          const reserved = await Offset.sum("amount", {
            where: { paymentId: debt.id, status: "RESERVED" },
            transaction,
          });
          const owed = Math.max(
            0,
            Money.cents(debt.cashCommissionOutstanding) -
              Money.cents(reserved || 0),
          );
          const use = Math.min(owed, available);
          if (use) {
            await Offset.create(
              {
                batchId: batch.id,
                paymentId: debt.id,
                amount: Money.amount(use),
              },
              { transaction },
            );
            available -= use;
            offset += use;
          }
        }
        await Entry.create(
          {
            batchId: batch.id,
            userId: owner,
            onlineGross: Money.amount(onlineGross),
            cashGross: Money.amount(cashGross),
            onlineCommission: Money.amount(onlineCommission),
            cashCommission: Money.amount(cashCommission),
            debtOffset: Money.amount(offset),
            netAmount: Money.amount(available),
          },
          { transaction },
        );
        for (const p of newRows)
          await p.update({ payoutBatchId: batch.id }, { transaction });
        gross += onlineGross + cashGross;
        commission += onlineCommission + cashCommission;
        net += available;
      }
      await batch.update(
        {
          gross: Money.amount(gross),
          commission: Money.amount(commission),
          net: Money.amount(net),
        },
        { transaction },
      );
      await Bills.event(
        null,
        "PAYOUT_BATCH_CREATED",
        batch.id,
        { gross: batch.gross, commission: batch.commission, net: batch.net },
        transaction,
        actor.userId,
      );
      return this.dto(batch, transaction);
    });
  }
  static async dto(batch, transaction) {
    return {
      ...batch.toJSON(),
      entries: await Entry.findAll({
        where: { batchId: batch.id },
        order: [["userId", "ASC"]],
        transaction,
      }),
      offsets: await Offset.findAll({
        where: { batchId: batch.id },
        transaction,
      }),
    };
  }
  static async settle(actor, id, { transfers = [] }) {
    const sorted = [...transfers].sort((a, b) =>
      a.entryId.localeCompare(b.entryId),
    );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          sorted.map((t) => ({
            entryId: t.entryId,
            amount: Money.amount(Money.cents(t.amount)),
            reference: t.reference,
          })),
        ),
      )
      .digest("hex");
    return this.locked(actor, async (transaction) => {
      const batch = await Batch.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!batch)
        Policy.fail("PAYOUT_NOT_FOUND", "Không tìm thấy lô đối soát", 404);
      if (batch.status === "SETTLED") {
        if (batch.settlementFingerprint !== fingerprint)
          Policy.fail(
            "PAYOUT_ALREADY_SETTLED",
            "Lô đã chốt với biên nhận khác",
          );
        return this.dto(batch, transaction);
      }
      if (batch.status !== "PENDING")
        Policy.fail("PAYOUT_NOT_PENDING", "Lô không còn chờ chi trả");
      const payments = await Pay.findAll({
        where: { payoutBatchId: id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      for (const p of payments)
        if (!(await this.eligible(p, transaction)))
          Policy.fail(
            "PAYOUT_BLOCKED",
            "Khoản thu bị thay đổi, đang tranh chấp hoặc có hoàn tiền",
          );
      const offsets = await Offset.findAll({
        where: { batchId: id, status: "RESERVED" },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      for (const o of offsets) {
        const debt = await Pay.findByPk(o.paymentId, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (
          !(await this.eligible(debt, transaction)) ||
          Money.cents(debt.cashCommissionOutstanding) < Money.cents(o.amount)
        )
          Policy.fail(
            "PAYOUT_DEBT_CHANGED",
            "Nợ hoa hồng thay đổi, cần lập lại lô",
          );
      }
      const entries = await Entry.findAll({
        where: { batchId: id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const nonzero = entries.filter((e) => Money.cents(e.netAmount) > 0);
      if (
        sorted.length !== nonzero.length ||
        new Set(sorted.map((t) => t.entryId)).size !== sorted.length
      )
        Policy.fail(
          "PAYOUT_TRANSFER_MISMATCH",
          "Cần biên nhận cho đúng từng người nhận",
        );
      for (const entry of nonzero) {
        const transfer = sorted.find((t) => t.entryId === entry.id);
        if (
          !transfer ||
          Money.cents(transfer.amount) !== Money.cents(entry.netAmount)
        )
          Policy.fail(
            "PAYOUT_TRANSFER_MISMATCH",
            "Số tiền chuyển không khớp lô",
          );
        await require("../models").BankTransferProof.create(
          {
            externalReference: transfer.reference,
            purpose: "PAYOUT",
            referenceId: entry.id,
            recipientId: entry.userId,
            amount: entry.netAmount,
            confirmedBy: actor.userId,
          },
          { transaction },
        );
        await entry.update(
          { externalReference: transfer.reference },
          { transaction },
        );
      }
      for (const offset of offsets) {
        const debt = await Pay.findByPk(offset.paymentId, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        await debt.update(
          {
            cashCommissionOutstanding: Money.amount(
              Money.cents(debt.cashCommissionOutstanding) -
                Money.cents(offset.amount),
            ),
          },
          { transaction },
        );
        await offset.update({ status: "SETTLED" }, { transaction });
      }
      await batch.update(
        {
          status: "SETTLED",
          settledAt: new Date(),
          settledBy: actor.userId,
          settlementFingerprint: fingerprint,
        },
        { transaction },
      );
      await Bills.event(
        null,
        "PAYOUT_SETTLED",
        id,
        { net: batch.net },
        transaction,
        actor.userId,
      );
      for (const entry of entries)
        await Notice.enqueue(
          [entry.userId],
          "PAYOUT_SETTLED",
          { batchId: id, amount: entry.netAmount },
          transaction,
        );
      return this.dto(batch, transaction);
    });
  }
  static async cancel(actor, id, reason) {
    return this.locked(actor, async (transaction) => {
      const batch = await Batch.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!batch) Policy.fail("PAYOUT_NOT_FOUND", "Không tìm thấy lô", 404);
      if (batch.status === "CANCELLED") return this.dto(batch, transaction);
      if (batch.status !== "PENDING")
        Policy.fail("PAYOUT_ALREADY_SETTLED", "Không hủy được lô đã chi trả");
      await Offset.update(
        { status: "CANCELLED" },
        { where: { batchId: id, status: "RESERVED" }, transaction },
      );
      await Pay.update(
        { payoutBatchId: null },
        { where: { payoutBatchId: id }, transaction },
      );
      await batch.update(
        { status: "CANCELLED", cancelReason: reason },
        { transaction },
      );
      await Bills.event(
        null,
        "PAYOUT_CANCELLED",
        id,
        { reason },
        transaction,
        actor.userId,
      );
      return this.dto(batch, transaction);
    });
  }
  static async list(actor, { limit = 50, offset = 0 }) {
    await Locks.admin(actor);
    const result = await Batch.findAndCountAll({
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit,
      offset,
    });
    return { total: result.count, items: result.rows };
  }
  static async earnings(actor, { limit = 50, offset = 0 }) {
    const rows = await Pay.findAll({ where: { providerUserId: actor.userId } });
    const gross = rows
      .filter((p) => p.status === "CONFIRMED")
      .reduce((n, p) => n + Money.cents(p.appliedAmount), 0);
    const cashDebt = rows
      .filter((p) => p.method === "CASH" && p.status === "CONFIRMED")
      .reduce((n, p) => n + Money.cents(p.cashCommissionOutstanding), 0);
    const held = rows
      .filter((p) => p.status === "HELD")
      .reduce((n, p) => n + Money.cents(p.appliedAmount), 0);
    return {
      gross: Money.amount(gross),
      held: Money.amount(held),
      cashCommissionDebt: Money.amount(cashDebt),
      payments: rows
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(offset, offset + limit),
      payouts: await Entry.findAll({
        where: { userId: actor.userId },
        order: [["createdAt", "DESC"]],
        limit,
        offset,
      }),
    };
  }
}
module.exports = Payouts;
