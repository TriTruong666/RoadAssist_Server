const { Op } = require("sequelize");
const { createHash } = require("node:crypto");
const {
  Dispute,
  DisputeEvent: Event,
  Provider,
  DispatchTicket: Ticket,
  Bill,
  BillItem: Item,
  BillPayment: Pay,
  Refund,
  ProviderRecovery,
  PayoutBatch: Batch,
  PayoutEntry: Entry,
  PayoutOffset: Offset,
  Handover,
} = require("../models");
const Locks = require("./finance_lock.service");
const Bills = require("./bill.service");
const Money = require("../utils/money.util");
const Policy = require("./dispatch_policy.service");
const Notice = require("./finance_notification.service");
const hash = (data) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
const ACTIVE = ["OPEN", "REVIEW"];
const fail = Policy.fail;
class Disputes {
  static async event(
    disputeId,
    actorId,
    action,
    details,
    transaction,
    { note, images = [] } = {},
  ) {
    return Event.create(
      { disputeId, actorId, action, details, note, images },
      { transaction },
    );
  }
  static async ticket(actor, id, transaction) {
    const t = await Ticket.findByPk(id, { transaction });
    if (!t) fail("DISPATCH_TICKET_NOT_FOUND", "Không tìm thấy cuốc", 404);
    const provider = t.providerId
      ? await Provider.findByPk(t.providerId, { transaction })
      : null;
    if (actor.userId !== t.userId && actor.userId !== provider?.userId)
      fail("DISPATCH_TICKET_NOT_FOUND", "Không tìm thấy cuốc", 404);
    return { t, provider };
  }
  static async open(actor, data) {
    return Locks.transaction(async (transaction) => {
      const snapshot = await this.ticket(actor, data.ticketId, transaction);
      await Locks.lockJourneys([snapshot.t.journeyId], transaction, actor);
      const { t, provider } = await this.ticket(
        actor,
        data.ticketId,
        transaction,
      );
      const fingerprint = hash({
        ticketId: t.id,
        reason: data.reason,
        note: data.note,
        assetIds: [...(data.assetIds || [])].sort(),
      });
      const existing = await Dispute.findOne({
        where: { ticketId: t.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (existing) {
        if (
          existing.claimantId === actor.userId &&
          existing.fingerprint === fingerprint
        )
          return this.dto(existing, transaction);
        fail(
          "DISPUTE_ALREADY_EXISTS",
          "Cuốc đã có hồ sơ; bổ sung bằng chứng vào hồ sơ hiện tại",
          409,
          { disputeId: existing.id },
        );
      }
      if (!provider || !["4", "12"].includes(t.status) || !t.resolvedAt)
        fail(
          "DISPUTE_REQUEST_NOT_COMPLETED",
          "Chỉ khiếu nại cuốc đã nghiệm thu hoàn thành",
        );
      if (
        Date.now() - new Date(t.resolvedAt) >= 7 * 86400000 ||
        new Date(t.resolvedAt) > new Date()
      )
        fail("DISPUTE_WINDOW_EXPIRED", "Đã hết thời hạn khiếu nại 7 ngày");
      if (provider.userId === t.userId)
        fail("DISPUTE_PARTIES_REQUIRED", "Cần hai bên độc lập");
      await Bills.syncJourney(t.journeyId, transaction);
      const row = await Dispute.create(
        {
          ticketId: t.id,
          journeyId: t.journeyId,
          claimantId: actor.userId,
          respondentId: actor.userId === t.userId ? provider.userId : t.userId,
          providerUserId: provider.userId,
          reason: data.reason,
          note: data.note,
          fingerprint,
          responseDueAt: new Date(
            Date.now() +
              require("../config/app.config").operations.disputeResponseHours *
                3600000,
          ),
        },
        { transaction },
      );
      const images = await require("./dispatch.service").assets(
        actor,
        data.assetIds || [],
        `dispute:${row.id}`,
        transaction,
        0,
        8,
      );
      await t.update({ disputeHold: true }, { transaction });
      await this.event(
        row.id,
        actor.userId,
        "OPENED",
        { ticketId: t.id, responseDueAt: row.responseDueAt },
        transaction,
        { note: data.note, images },
      );
      const bill = await Bill.findOne({
        where: { journeyId: t.journeyId },
        transaction,
      });
      await Bills.event(
        bill.id,
        "DISPUTE_OPENED",
        row.id,
        { ticketId: t.id },
        transaction,
        actor.userId,
      );
      await Notice.enqueue(
        [row.claimantId, row.respondentId],
        "DISPUTE_OPENED",
        { disputeId: row.id, ticketId: t.id, responseDueAt: row.responseDueAt },
        transaction,
      );
      return this.dto(row, transaction);
    });
  }
  static async authorize(actor, row, transaction, admin = false) {
    if (!row) fail("DISPUTE_NOT_FOUND", "Không tìm thấy hồ sơ", 404);
    if (admin) {
      await Locks.admin(actor, transaction);
      return;
    }
    if (![row.claimantId, row.respondentId].includes(actor.userId))
      fail("DISPUTE_NOT_FOUND", "Không tìm thấy hồ sơ", 404);
  }
  static async locked(actor, id, work) {
    const snapshot = await Dispute.findByPk(id);
    if (!snapshot) fail("DISPUTE_NOT_FOUND", "Không tìm thấy hồ sơ", 404);
    return Locks.transaction(async (transaction) => {
      await Locks.lockJourneys([snapshot.journeyId], transaction, actor);
      const row = await Dispute.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      await this.authorize(actor, row, transaction);
      return work(row, transaction);
    });
  }
  static async evidence(actor, id, data) {
    return this.locked(actor, id, async (row, transaction) => {
      if (row.status !== "OPEN" || row.responseDueAt <= new Date())
        fail(
          "DISPUTE_RESPONSE_WINDOW_CLOSED",
          "Đã hết hạn bổ sung; admin sẽ xem xét hồ sơ",
        );
      if (
        (await Event.count({
          where: {
            disputeId: id,
            actorId: actor.userId,
            action: "EVIDENCE_ADDED",
          },
          transaction,
        })) >= 20
      )
        fail("DISPUTE_EVIDENCE_LIMIT", "Tối đa 20 lần bổ sung cho mỗi bên");
      const images = await require("./dispatch.service").assets(
        actor,
        data.assetIds || [],
        `dispute:${id}`,
        transaction,
        0,
        8,
      );
      await this.event(id, actor.userId, "EVIDENCE_ADDED", {}, transaction, {
        note: data.note,
        images,
      });
      if (actor.userId === row.respondentId && !row.respondedAt)
        await row.update({ respondedAt: new Date() }, { transaction });
      await Notice.enqueue(
        [row.claimantId, row.respondentId].filter(
          (user) => user !== actor.userId,
        ),
        "DISPUTE_UPDATED",
        { disputeId: id },
        transaction,
      );
      return this.dto(row, transaction);
    });
  }
  static async dto(row, transaction) {
    const t = await Ticket.findByPk(row.ticketId, { transaction });
    return {
      ...row.toJSON(),
      events: await Event.findAll({
        where: { disputeId: row.id },
        order: [
          ["createdAt", "ASC"],
          ["id", "ASC"],
        ],
        transaction,
      }),
      handovers: await Handover.findAll({
        where: {
          ticketId: {
            [Op.in]: [row.ticketId, t?.parentTicketId].filter(Boolean),
          },
        },
        order: [["createdAt", "ASC"]],
        transaction,
      }),
      refund: await Refund.findOne({
        where: { disputeId: row.id },
        transaction,
      }),
      recovery: await this.recoveryDetail(row, transaction),
    };
  }
  static async recoveryDetail(row, transaction) {
    const recovery = await ProviderRecovery.findOne({
      where: { disputeId: row.id },
      transaction,
    });
    if (!recovery) return null;
    const balances = await require("./provider_recovery.service").balances(
      row.providerUserId,
      transaction,
    );
    return {
      ...recovery.toJSON(),
      outstanding: balances.find((b) => b.id === recovery.id).outstanding,
      offsets: await require("../models").RecoveryOffset.findAll({
        where: { recoveryId: recovery.id },
        order: [["createdAt", "ASC"]],
        transaction,
      }),
    };
  }
  static async detail(actor, id, admin = false) {
    return Locks.transaction(async (transaction) => {
      const row = await Dispute.findByPk(id, { transaction });
      await this.authorize(actor, row, transaction, admin);
      return this.dto(row, transaction);
    });
  }
  static async list(
    actor,
    { limit = 50, offset = 0, status } = {},
    admin = false,
  ) {
    if (admin) await Locks.admin(actor);
    const where = {
      ...(status && { status }),
      ...(!admin && {
        [Op.or]: [{ claimantId: actor.userId }, { respondentId: actor.userId }],
      }),
    };
    const result = await Dispute.findAndCountAll({
      where,
      limit,
      offset,
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
    });
    return { total: result.count, items: result.rows };
  }
  static async cancelProviderBatches(userId, transaction, actor) {
    const entries = await Entry.findAll({ where: { userId }, transaction });
    const batches = await Batch.findAll({
      where: {
        id: { [Op.in]: entries.map((e) => e.batchId) },
        status: "PENDING",
      },
      order: [["id", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const batch of batches) {
      await require("./provider_recovery.service").cancel(
        batch.id,
        transaction,
        actor.userId,
      );
      await Offset.update(
        { status: "CANCELLED" },
        { where: { batchId: batch.id, status: "RESERVED" }, transaction },
      );
      await Pay.update(
        { payoutBatchId: null },
        { where: { payoutBatchId: batch.id }, transaction },
      );
      await batch.update(
        { status: "CANCELLED", cancelReason: "DISPUTE_ADJUDICATION_REBUILD" },
        { transaction },
      );
      await Bills.event(
        null,
        "PAYOUT_CANCELLED",
        batch.id,
        { reason: "DISPUTE_ADJUDICATION_REBUILD" },
        transaction,
        actor.userId,
      );
    }
  }
  static async resolve(actor, id, data) {
    await Locks.admin(actor);
    const snapshot = await Dispute.findByPk(id);
    if (!snapshot) fail("DISPUTE_NOT_FOUND", "Không tìm thấy hồ sơ", 404);
    const fingerprint = hash({
      resolution: data.resolution,
      amount:
        data.amount === undefined
          ? null
          : Money.amount(Money.cents(data.amount)),
      note: data.note,
    });
    return require("./payout.service").locked(
      actor,
      async (transaction, tickets) => {
        const t = tickets.find((t) => t.id === snapshot.ticketId);
        const row = await Dispute.findByPk(id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if ([row.claimantId, row.respondentId].includes(actor.userId))
          fail(
            "DISPUTE_IMPARTIAL_ADMIN_REQUIRED",
            "Người tham gia không được tự phán quyết",
          );
        if (!ACTIVE.includes(row.status)) {
          if (row.resolutionFingerprint !== fingerprint)
            fail("DISPUTE_ALREADY_RESOLVED", "Hồ sơ đã có phán quyết khác");
          return this.dto(row, transaction);
        }
        if (!row.respondedAt && row.responseDueAt > new Date())
          fail(
            "DISPUTE_AWAITING_RESPONSE",
            "Cần phản hồi của bị đơn hoặc hết thời hạn phản hồi",
          );
        const bill = await Bills.syncJourney(t.journeyId, transaction);
        const items = await Item.findAll({
          where: { ticketId: t.id },
          order: [["id", "ASC"]],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const payments = await Pay.findAll({
          where: {
            billItemId: { [Op.in]: items.map((i) => i.id) },
            providerUserId: row.providerUserId,
            status: { [Op.in]: ["HELD", "CONFIRMED"] },
          },
          transaction,
        });
        const budgets = items.map((item) => {
          const paid = payments
            .filter((p) => p.billItemId === item.id)
            .reduce((n, p) => n + Money.cents(p.appliedAmount), 0);
          return {
            item,
            paid,
            unpaid: Math.max(0, Money.cents(item.amount) - paid),
          };
        });
        const budget = budgets.reduce((n, b) => n + b.paid + b.unpaid, 0);
        const refundDecision = ["FAVOR_RIDER", "PARTIAL_REFUND"].includes(
          data.resolution,
        );
        let award = refundDecision
          ? data.resolution === "FAVOR_RIDER"
            ? budget
            : Money.cents(data.amount)
          : 0;
        if (
          !refundDecision &&
          data.amount !== undefined &&
          Money.cents(data.amount) !== 0
        )
          fail("DISPUTE_AMOUNT_MISMATCH", "Phán quyết này không cấp hoàn tiền");
        if (
          refundDecision &&
          (!award ||
            award > budget ||
            (data.resolution === "PARTIAL_REFUND" && award >= budget))
        )
          fail(
            "DISPUTE_INVALID_AWARD",
            "Số tiền phải nằm trong giá trị cuốc; hoàn một phần phải nhỏ hơn toàn bộ",
          );
        if (
          data.resolution === "FAVOR_RIDER" &&
          data.amount !== undefined &&
          Money.cents(data.amount) !== budget
        )
          fail(
            "DISPUTE_AMOUNT_MISMATCH",
            "Hoàn toàn bộ phải khớp giá trị còn được xét",
          );
        let debtCredit = 0,
          remaining = award;
        if (award) {
          await this.cancelProviderBatches(
            row.providerUserId,
            transaction,
            actor,
          );
          for (const b of budgets) {
            const use = Math.min(remaining, b.unpaid);
            if (use) {
              await b.item.update(
                {
                  disputeCredit: Money.amount(
                    Money.cents(b.item.disputeCredit) + use,
                  ),
                },
                { transaction },
              );
              debtCredit += use;
              remaining -= use;
            }
          }
        }
        if (remaining) {
          await Refund.create(
            {
              billId: bill.id,
              disputeId: id,
              amount: Money.amount(remaining),
              reason: "DISPUTE_AWARD",
            },
            { transaction },
          );
          await ProviderRecovery.create(
            {
              disputeId: id,
              userId: row.providerUserId,
              amount: Money.amount(remaining),
            },
            { transaction },
          );
        }
        await row.update(
          {
            status: data.resolution === "NO_ACTION" ? "REJECTED" : "RESOLVED",
            adminResolution: data.resolution,
            adminNote: data.note,
            awardAmount: Money.amount(award),
            debtCreditAmount: Money.amount(debtCredit),
            refundAmount: Money.amount(remaining),
            resolvedAt: new Date(),
            resolvedBy: actor.userId,
            resolutionFingerprint: fingerprint,
          },
          { transaction },
        );
        await t.update({ disputeHold: false }, { transaction });
        await Bills.syncJourney(t.journeyId, transaction);
        await this.event(
          id,
          actor.userId,
          "ADJUDICATED",
          {
            resolution: data.resolution,
            awardAmount: row.awardAmount,
            debtCreditAmount: row.debtCreditAmount,
            refundAmount: row.refundAmount,
          },
          transaction,
          { note: data.note },
        );
        await Bills.event(
          bill.id,
          "DISPUTE_ADJUDICATED",
          id,
          {
            resolution: data.resolution,
            awardAmount: row.awardAmount,
            debtCreditAmount: row.debtCreditAmount,
            refundAmount: row.refundAmount,
          },
          transaction,
          actor.userId,
        );
        await Notice.enqueue(
          [row.claimantId, row.respondentId],
          "DISPUTE_RESOLVED",
          { disputeId: id, ticketId: t.id, resolution: data.resolution },
          transaction,
        );
        return this.dto(row, transaction);
      },
      [snapshot.journeyId],
    );
  }
  static async expireResponses() {
    let cursor;
    for (;;) {
      const rows = await Dispute.findAll({
        where: {
          status: "OPEN",
          responseDueAt: { [Op.lte]: new Date() },
          ...(cursor && { id: { [Op.gt]: cursor } }),
        },
        order: [["id", "ASC"]],
        limit: 100,
      });
      if (!rows.length) break;
      for (const snapshot of rows)
        await Locks.transaction(async (transaction) => {
          await Locks.lockJourneys([snapshot.journeyId], transaction);
          const row = await Dispute.findByPk(snapshot.id, {
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (row.status !== "OPEN" || row.responseDueAt > new Date()) return;
          await row.update({ status: "REVIEW" }, { transaction });
          await this.event(
            row.id,
            null,
            "RESPONSE_DEADLINE_EXPIRED",
            {},
            transaction,
          );
          await Notice.enqueue(
            [row.claimantId, row.respondentId],
            "DISPUTE_REVIEW_REQUIRED",
            { disputeId: row.id },
            transaction,
          );
        });
      cursor = rows.at(-1).id;
    }
  }
}
module.exports = Disputes;
