const { Op } = require("sequelize");
const { randomUUID } = require("node:crypto");
const {
  SepayReceipt: Receipt,
  Bill,
  BillItem: Item,
  BillPayment: Pay,
  PaymentIntent: Intent,
  Refund,
  DispatchTicket: Ticket,
  Provider,
  FinanceEvent: Event,
  PayoutOffset: Offset,
} = require("../models");
const Money = require("../utils/money.util");
const Locks = require("./finance_lock.service");
const Policy = require("./dispatch_policy.service");
const { TERMINAL } = require("../common/dispatch.constants");
const Notices = require("./finance_notification.service");
const fail = (...args) => Policy.fail(...args);
const paid = (p) => ["HELD", "CONFIRMED", "REFUNDED"].includes(p.status);
class Bills {
  static bps() {
    const rate = require("../config/app.config").sepay.commissionRate;
    const bps = Math.round(rate * 10000);
    if (
      !Number.isFinite(rate) ||
      rate < 0 ||
      rate > 1 ||
      Math.abs(rate * 10000 - bps) > 0.00001
    )
      throw new Error(
        "PLATFORM_COMMISSION_RATE must be 0..1 with at most 4 decimal places",
      );
    return bps;
  }
  static commission(cents, bps) {
    return Math.min(
      cents,
      Number((BigInt(cents) * BigInt(bps) + 500000n) / 1000000n) * 100,
    );
  }
  static async event(
    billId,
    action,
    referenceId,
    details,
    transaction,
    actorId = null,
  ) {
    return Event.create(
      { billId, action, referenceId, details, actorId },
      { transaction },
    );
  }
  static async refundDue(
    { billId, paymentId = null, intentId, due, reason },
    transaction,
  ) {
    const completed = await Refund.findAll({
      where: { billId, paymentId, intentId, status: "COMPLETED" },
      transaction,
    });
    const remaining = Math.max(
      0,
      due - completed.reduce((n, r) => n + Money.cents(r.amount), 0),
    );
    const pending = await Refund.findOne({
      where: { billId, paymentId, intentId, status: "PENDING" },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!remaining) {
      if (pending)
        await pending.update({ status: "CANCELLED" }, { transaction });
      return;
    }
    if (pending) {
      if (Money.cents(pending.amount) !== remaining)
        await pending.update(
          { amount: Money.amount(remaining), reason },
          { transaction },
        );
      return;
    }
    const refund = await Refund.create(
      { billId, paymentId, intentId, amount: Money.amount(remaining), reason },
      { transaction },
    );
    await this.event(
      billId,
      "REFUND_REQUIRED",
      refund.id,
      { amount: refund.amount, reason },
      transaction,
    );
  }
  static async cancelIntent(intent, reason, transaction, status = "CANCELLED") {
    if (intent.status !== "PENDING") return;
    await intent.update({ status, cancelReason: reason }, { transaction });
    await Pay.update(
      { status: "CANCELLED", appliedAmount: "0.00" },
      { where: { intentId: intent.id, status: "PENDING" }, transaction },
    );
    if (Money.cents(intent.receivedAmount))
      await this.refundDue(
        {
          billId: intent.billId,
          intentId: intent.id,
          due: Money.cents(intent.receivedAmount),
          reason,
        },
        transaction,
      );
    await this.event(
      intent.billId,
      "PAYMENT_INTENT_CANCELLED",
      intent.id,
      { reason },
      transaction,
    );
  }
  static async syncJourney(journeyId, transaction, { ticketOverride } = {}) {
    const tickets = await Ticket.findAll({
      where: { journeyId },
      transaction,
      order: [
        ["createdAt", "ASC"],
        ["id", "ASC"],
      ],
    });
    if (!tickets.length) return null;
    const [bill] = await Bill.findOrCreate({
      where: { journeyId },
      defaults: {
        code: `RAB-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
        userId: tickets[0].userId,
      },
      transaction,
    });
    const locked = await Bill.findByPk(bill.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    let changed = false;
    const ticketMap = new Map();
    for (const row of tickets) {
      const t =
        ticketOverride?.id === row.id
          ? {
              ...row.get(),
              ...(ticketOverride.get ? ticketOverride.get() : ticketOverride),
            }
          : row.get();
      ticketMap.set(t.id, t);
      const wait =
        t.type === "TOW" && t.status === "3"
          ? Policy.waiting(t)
          : { waitingFee: t.waitingFee || "0.00" };
      const zero = t.chargesVoided || t.status === "5" || t.status === "8";
      const repair = t.quoteVoided ? "0.00" : t.quoteAmount || "0.00";
      const charges =
        t.type === "TOW"
          ? [
              ["TOW_FARE", "Cước kéo xe", t.travelFee],
              ["WAITING_FEE", "Phí chờ", wait.waitingFee],
            ]
          : t.type === "SOS"
            ? [
                ["SOS_CALLOUT", "Phí gọi thợ", t.callOutFee],
                ["SOS_TRAVEL", "Phí di chuyển", t.travelFee],
                ["SHOP_REPAIR", "Sửa chữa", repair],
              ]
            : [["SHOP_REPAIR", "Sửa tại tiệm", repair]];
      const provider = t.providerId
        ? await Provider.findByPk(t.providerId, {
            transaction,
            attributes: ["userId"],
          })
        : null;
      for (const [type, title, value] of charges) {
        const originalAmount = zero ? 0 : Money.cents(value || 0);
        let amount = Money.amount(originalAmount);
        const [item, created] = await Item.findOrCreate({
          where: { ticketId: t.id, type },
          defaults: {
            billId: locked.id,
            providerId: t.providerId,
            providerUserId: provider?.userId || null,
            title,
            amount,
            ticketRevision: t.revision,
          },
          transaction,
        });
        amount = Money.amount(
          Math.max(0, originalAmount - Money.cents(item.disputeCredit)),
        );
        if (
          !created &&
          (item.amount !== amount ||
            item.providerId !== t.providerId ||
            item.ticketRevision !== t.revision)
        ) {
          await item.update(
            {
              amount,
              providerId: t.providerId,
              providerUserId: provider?.userId || null,
              ticketRevision: t.revision,
            },
            { transaction },
          );
          changed = true;
        }
        if (created) changed = true;
      }
    }
    const items = await Item.findAll({
      where: { billId: locked.id },
      order: [["id", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const itemMap = new Map(items.map((i) => [i.id, i]));
    const intents = await Intent.findAll({
      where: { billId: locked.id },
      order: [["id", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const intentMap = new Map(intents.map((i) => [i.id, i]));
    let payments = await Pay.findAll({
      where: { billId: locked.id },
      order: [
        ["createdAt", "ASC"],
        ["id", "ASC"],
      ],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const intent of intents.filter((i) => i.status === "PENDING")) {
      const lines = payments.filter(
        (p) => p.intentId === intent.id && p.status === "PENDING",
      );
      const invalid = lines.some((p) => {
        const i = itemMap.get(p.billItemId);
        return (
          !i ||
          i.providerId !== p.providerId ||
          Money.cents(i.amount) < Money.cents(p.amount)
        );
      });
      const awaitingReceipt =
        intent.method === "SEPAY" && intent.expiresAt <= new Date()
          ? await Receipt.count({
              where: {
                intentId: intent.id,
                status: "RECEIVED",
                createdAt: { [Op.lte]: intent.expiresAt },
              },
              transaction,
            })
          : 0;
      if (
        invalid ||
        (intent.method === "SEPAY" &&
          intent.expiresAt <= new Date() &&
          !awaitingReceipt)
      )
        await this.cancelIntent(
          intent,
          invalid ? "CHARGES_CHANGED" : "PAYMENT_EXPIRED",
          transaction,
          invalid ? "CANCELLED" : "EXPIRED",
        );
    }
    payments = await Pay.findAll({
      where: { billId: locked.id },
      order: [
        ["createdAt", "ASC"],
        ["id", "ASC"],
      ],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const available = new Map(items.map((i) => [i.id, Money.cents(i.amount)]));
    payments.sort(
      (a, b) =>
        (({ CONFIRMED: 0, HELD: 1, PENDING: 2 })[a.status] ?? 3) -
          ({ CONFIRMED: 0, HELD: 1, PENDING: 2 }[b.status] ?? 3) ||
        new Date(a.createdAt) - new Date(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
    for (const p of payments) {
      const item = itemMap.get(p.billItemId);
      const t = ticketMap.get(item?.ticketId);
      const apply =
        !["CANCELLED", "REFUNDED"].includes(p.status) &&
        item?.providerId === p.providerId
          ? Math.min(
              Math.max(
                0,
                Money.cents(p.amount) - Money.cents(p.refundedAmount),
              ),
              available.get(item.id) || 0,
            )
          : 0;
      if (item)
        available.set(
          item.id,
          Math.max(0, (available.get(item.id) || 0) - apply),
        );
      const commission = this.commission(apply, p.commissionBps);
      const update = {
        appliedAmount: Money.amount(apply),
        commissionAmount: Money.amount(commission),
        payoutAmount:
          p.method === "SEPAY" ? Money.amount(apply - commission) : "0.00",
      };
      if (
        p.payoutBatchId &&
        (p.appliedAmount !== update.appliedAmount ||
          p.commissionAmount !== update.commissionAmount)
      )
        fail(
          "PAYMENT_PAYOUT_LOCKED",
          "Khoản thu đã được đưa vào đối soát, cần hủy lô trước",
        );
      if (
        p.method === "SEPAY" &&
        p.status === "HELD" &&
        apply > 0 &&
        ["4", "12"].includes(t?.status)
      ) {
        update.status = "CONFIRMED";
        update.confirmedAt = new Date();
        await this.event(
          locked.id,
          "PAYMENT_CONFIRMED",
          p.id,
          { amount: update.appliedAmount },
          transaction,
        );
        await Notices.enqueue(
          [locked.userId, p.providerUserId],
          "PAYMENT_CONFIRMED",
          { billId: locked.id, paymentId: p.id },
          transaction,
        );
      }
      if (p.method === "CASH" && p.status === "CONFIRMED") {
        // Settled offsets survive cancellation/replacement of the cash receipt's batch.
        const settled = Money.cents(
          (await Offset.sum("amount", {
            where: { paymentId: p.id, status: "SETTLED" },
            transaction,
          })) || 0,
        );
        if (settled > commission)
          fail(
            "PAYMENT_PAYOUT_LOCKED",
            "Hoa hồng đã cấn trừ; cần đối soát điều chỉnh trước khi giảm khoản thu",
          );
        update.cashCommissionOutstanding = Money.amount(commission - settled);
      }
      await p.update(update, { transaction });
      if (paid(p) && Money.cents(p.amount) > apply)
        await this.refundDue(
          {
            billId: locked.id,
            paymentId: p.id,
            intentId: p.intentId,
            due: Money.cents(p.amount) - apply,
            reason: "CHARGES_REDUCED",
          },
          transaction,
        );
    }
    const total = items.reduce((n, i) => n + Money.cents(i.amount), 0);
    const paidAmount = payments
      .filter((p) => ["HELD", "CONFIRMED"].includes(p.status))
      .reduce((n, p) => n + Money.cents(p.appliedAmount), 0);
    const due = Math.max(0, total - paidAmount);
    const status =
      total === 0
        ? tickets.every((t) => TERMINAL.includes(t.status))
          ? "VOID"
          : "DRAFT"
        : due === 0
          ? "PAID"
          : paidAmount
            ? "PARTIAL"
            : "PENDING";
    if (
      locked.totalAmount !== Money.amount(total) ||
      locked.paidAmount !== Money.amount(paidAmount) ||
      locked.status !== status
    )
      changed = true;
    await locked.update(
      {
        totalAmount: Money.amount(total),
        paidAmount: Money.amount(paidAmount),
        dueAmount: Money.amount(due),
        status,
      },
      { transaction },
    );
    if (changed)
      await this.event(
        locked.id,
        "BILL_RECONCILED",
        locked.id,
        { total: locked.totalAmount, paid: locked.paidAmount, status },
        transaction,
      );
    return locked;
  }
  static async detail(actor, id) {
    const snapshot = await Bill.findByPk(id);
    if (!snapshot || snapshot.userId !== actor.userId)
      fail("BILL_NOT_FOUND", "Không tìm thấy hóa đơn", 404);
    return Locks.journey(snapshot.journeyId, actor, async (transaction) => {
      const bill = await this.syncJourney(snapshot.journeyId, transaction);
      return this.dto(bill, transaction);
    });
  }
  static async dto(bill, transaction) {
    return {
      ...bill.toJSON(),
      items: await Item.findAll({
        where: { billId: bill.id },
        order: [
          ["createdAt", "ASC"],
          ["id", "ASC"],
        ],
        transaction,
      }),
      payments: await Pay.findAll({
        where: { billId: bill.id },
        order: [["createdAt", "ASC"]],
        attributes: { exclude: ["sepayReference"] },
        transaction,
      }),
      disputeAwards: await require("../models").Dispute.findAll({
        where: {
          journeyId: bill.journeyId,
          status: { [Op.in]: ["RESOLVED", "REJECTED"] },
        },
        attributes: [
          "id",
          "ticketId",
          "adminResolution",
          "awardAmount",
          "debtCreditAmount",
          "refundAmount",
          "resolvedAt",
        ],
        transaction,
      }),
      refunds: await Refund.findAll({
        where: { billId: bill.id },
        order: [["createdAt", "ASC"]],
        transaction,
      }),
    };
  }
  static async mine(actor, { limit = 50, offset = 0 } = {}) {
    const result = await Bill.findAndCountAll({
      where: { userId: actor.userId },
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit,
      offset,
    });
    return {
      total: result.count,
      unpaidCount: await Bill.count({
        where: { userId: actor.userId, dueAmount: { [Op.gt]: 0 } },
      }),
      items: result.rows,
    };
  }
  static async backfill() {
    const tickets = await Ticket.findAll({
      where: {
        journeyId: {
          [Op.notIn]: require("sequelize").literal(
            `(SELECT journey_id FROM ${require("../config/postgres.config").getQueryInterface().queryGenerator.quoteTable(Bill.getTableName())})`,
          ),
        },
      },
      attributes: ["journeyId"],
      group: ["journeyId"],
      limit: 50,
    });
    for (const t of tickets)
      await Locks.journey(t.journeyId, null, (transaction) =>
        this.syncJourney(t.journeyId, transaction),
      );
    return tickets.length;
  }
}
module.exports = Bills;
