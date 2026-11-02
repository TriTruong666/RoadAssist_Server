const { Op } = require("sequelize");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const {
  SepayReceipt: Receipt,
  Bill,
  BillItem: Item,
  BillPayment: Pay,
  PaymentIntent: Intent,
  Provider,
  DispatchTicket: Ticket,
  Refund,
} = require("../models");
const Bills = require("./bill.service");
const Locks = require("./finance_lock.service");
const Money = require("../utils/money.util");
const Policy = require("./dispatch_policy.service");
const Notice = require("./finance_notification.service");
const config = require("../config/app.config").sepay;
const fail = Policy.fail;
class Payments {
  static code() {
    return `RA${BigInt("0x" + randomBytes(8).toString("hex"))
      .toString()
      .padStart(20, "0")}`;
  }
  static bank() {
    if (
      !config.accountNumber ||
      !config.bankCode ||
      !config.gatewayName ||
      (config.webhookAuth === "apikey"
        ? !config.webhookToken
        : !config.webhookSecret)
    )
      fail("SEPAY_NOT_CONFIGURED", "Chưa cấu hình tài khoản nhận SePay", 503);
    return {
      accountNumber: config.accountNumber,
      bankCode: config.bankCode,
      gatewayName: config.gatewayName,
      subAccount: config.subAccount,
      accountName: config.accountName,
      transferPrefix: config.transferPrefix,
    };
  }
  static dto(intent, payments) {
    const result = {
      id: intent.id,
      billId: intent.billId,
      method: intent.method,
      status: intent.status,
      amount: intent.amount,
      receivedAmount: intent.receivedAmount,
      code: intent.code,
      expiresAt: intent.expiresAt,
      payments,
    };
    if (intent.method === "SEPAY") {
      const bank = intent.bankSnapshot;
      const des = [bank.transferPrefix, intent.code].filter(Boolean).join(" ");
      const params = new URLSearchParams({
        acc: bank.subAccount || bank.accountNumber,
        bank: bank.bankCode,
        amount: String(Money.cents(intent.amount) / 100),
        des,
        template: "compact",
        holder: bank.accountName || "",
      });
      result.bank = {
        ...bank,
        transferContent: des,
        qrUrl: `https://vietqr.app/img?${params}`,
      };
    }
    return result;
  }
  static async create(actor, method, data, context = {}) {
    const snapshot = await Bill.findByPk(data.billId);
    if (!snapshot || snapshot.userId !== actor.userId)
      fail("BILL_NOT_FOUND", "Không tìm thấy hóa đơn", 404);
    const bank = method === "SEPAY" ? this.bank() : {};
    const bps = Bills.bps();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          billId: data.billId,
          billItemId: data.billItemId || null,
          ticketId: data.ticketId || null,
          method,
        }),
      )
      .digest("hex");
    const execute = async (transaction, tickets) => {
      const bill = await Bills.syncJourney(snapshot.journeyId, transaction);
      if (data.clientRequestId) {
        const prior = await Intent.findOne({
          where: {
            userId: actor.userId,
            clientRequestId: data.clientRequestId,
          },
          transaction,
        });
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            fail(
              "PAYMENT_IDEMPOTENCY_CONFLICT",
              "Mã yêu cầu đã được dùng cho nội dung khác",
            );
          return this.dto(
            prior,
            await Pay.findAll({ where: { intentId: prior.id }, transaction }),
          );
        }
      }
      const selected = await Item.findAll({
        where: {
          billId: bill.id,
          ...(data.billItemId && { id: data.billItemId }),
          ...(data.ticketId && { ticketId: data.ticketId }),
        },
        transaction,
        order: [["id", "ASC"]],
      });
      if (!selected.length)
        fail("BILL_ITEM_NOT_FOUND", "Không tìm thấy hạng mục thanh toán", 404);
      const allocations = [];
      const priorIntents = new Set();
      for (const item of selected) {
        if (!Money.cents(item.amount)) continue;
        if (!item.providerId || !item.providerUserId)
          fail("PAYMENT_PROVIDER_UNASSIGNED", "Hạng mục chưa có đối tác nhận");
        const payments = await Pay.findAll({
          where: {
            billItemId: item.id,
            providerId: item.providerId,
            status: { [Op.in]: ["PENDING", "HELD", "CONFIRMED"] },
          },
          transaction,
        });
        const received = payments
          .filter((p) => p.status !== "PENDING")
          .reduce((n, p) => n + Money.cents(p.appliedAmount), 0);
        const promised = payments.filter((p) => p.status === "PENDING");
        const reserved = promised.reduce(
          (n, p) => n + Money.cents(p.appliedAmount),
          0,
        );
        for (const p of promised) priorIntents.add(p.intentId);
        const needed = Math.max(
          0,
          Money.cents(item.amount) - received - reserved,
        );
        if (needed) allocations.push({ item, amount: needed });
      }
      if (priorIntents.size && allocations.length === 0) {
        const ids = [...priorIntents];
        if (ids.length === 1) {
          const previous = await Intent.findByPk(ids[0], { transaction });
          const lines = await Pay.findAll({
            where: { intentId: previous.id },
            transaction,
          });
          if (
            previous.method === method &&
            lines.every((p) => selected.some((i) => i.id === p.billItemId))
          )
            return this.dto(previous, lines);
        }
        fail(
          "PAYMENT_PENDING_EXISTS",
          "Đã có phương thức đang chờ; hủy mã cũ trước khi đổi phương thức",
        );
      }
      if (!allocations.length)
        fail("PAYMENT_ALREADY_FUNDED", "Các hạng mục đã được thanh toán");
      const amount = allocations.reduce((n, a) => n + a.amount, 0);
      if (amount % 100 !== 0 || allocations.some((a) => a.amount % 100 !== 0))
        fail(
          "PAYMENT_VND_INTEGER_REQUIRED",
          "Thanh toán VND phải có số tiền nguyên đồng",
          400,
        );
      if (method === "CASH")
        await require("./cash_eligibility.service").assert(
          actor.userId,
          transaction,
        );
      const code = this.code();
      const intent = await Intent.create(
        {
          billId: bill.id,
          userId: actor.userId,
          code,
          method,
          amount: Money.amount(amount),
          expiresAt:
            method === "SEPAY"
              ? new Date(Date.now() + config.paymentTtlMinutes * 60000)
              : null,
          bankSnapshot: bank,
          clientRequestId: data.clientRequestId,
          fingerprint,
        },
        { transaction },
      );
      const payments = [];
      for (const [index, allocation] of allocations.entries()) {
        const { item, amount } = allocation;
        if (method === "CASH" && !item.cashCommittedAt)
          await item.update({ cashCommittedAt: new Date() }, { transaction });
        payments.push(
          await Pay.create(
            {
              billId: bill.id,
              billItemId: item.id,
              intentId: intent.id,
              providerId: item.providerId,
              providerUserId: item.providerUserId,
              amount: Money.amount(amount),
              appliedAmount: Money.amount(amount),
              method,
              transactionCode: `${code}-${index + 1}`,
              commissionBps: bps,
              commissionRate: String(bps / 10000),
            },
            { transaction },
          ),
        );
      }
      await Bills.event(
        bill.id,
        "PAYMENT_INTENT_CREATED",
        intent.id,
        { method, amount: intent.amount },
        transaction,
        actor.userId,
      );
      return this.dto(intent, payments);
    };
    return context.transaction
      ? execute(context.transaction, context.tickets)
      : Locks.journey(snapshot.journeyId, actor, execute);
  }
  static async switchCashToSepay(actor, data) {
    const bill = await Bill.findByPk(data.billId);
    if (!bill || bill.userId !== actor.userId)
      fail("BILL_NOT_FOUND", "Không tìm thấy hóa đơn", 404);
    return Locks.journey(
      bill.journeyId,
      actor,
      async (transaction, tickets) => {
        await Bills.syncJourney(bill.journeyId, transaction);
        if (
          data.clientRequestId &&
          (await Intent.findOne({
            where: {
              userId: actor.userId,
              clientRequestId: data.clientRequestId,
            },
            transaction,
          }))
        )
          return this.create(actor, "SEPAY", data, { transaction, tickets });
        const items = await Item.findAll({
          where: {
            billId: bill.id,
            ...(data.ticketId && { ticketId: data.ticketId }),
            ...(data.billItemId && { id: data.billItemId }),
          },
          transaction,
        });
        const promises = await Pay.findAll({
          where: {
            billItemId: { [Op.in]: items.map((i) => i.id) },
            method: "CASH",
            status: "PENDING",
            appliedAmount: { [Op.gt]: 0 },
          },
          transaction,
        });
        if (!promises.length)
          fail(
            "PAYMENT_NO_CASH_COMMITMENT",
            "Không có cam kết tiền mặt cần đổi",
          );
        for (const promise of promises) {
          const item = items.find((i) => i.id === promise.billItemId);
          const t = tickets.find((t) => t.id === item.ticketId);
          if (!["4", "12"].includes(t?.status))
            fail(
              "PAYMENT_HANDOVER_REQUIRED",
              "Chỉ đổi nợ của cuốc đã kết thúc sang online",
            );
        }
        for (const intentId of new Set(promises.map((p) => p.intentId))) {
          const intent = await Intent.findByPk(intentId, {
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          const siblings = await Pay.findAll({
            where: { intentId, status: "PENDING" },
            transaction,
          });
          if (siblings.some((p) => !items.some((i) => i.id === p.billItemId)))
            fail(
              "PAYMENT_SCOPE_CONFLICT",
              "Cần chọn toàn bộ cam kết tiền mặt này",
            );
          await Bills.cancelIntent(intent, "SWITCHED_TO_SEPAY", transaction);
        }
        await Bills.syncJourney(bill.journeyId, transaction);
        const result = await this.create(actor, "SEPAY", data, {
          transaction,
          tickets,
        });
        await Bills.event(
          bill.id,
          "CASH_SWITCHED_TO_SEPAY",
          result.id,
          {},
          transaction,
          actor.userId,
        );
        return result;
      },
    );
  }
  static async get(actor, id) {
    const intent = await Intent.findByPk(id);
    if (!intent || intent.userId !== actor.userId)
      fail("PAYMENT_NOT_FOUND", "Không tìm thấy thanh toán", 404);
    const bill = await Bill.findByPk(intent.billId);
    return Locks.journey(bill.journeyId, actor, async (transaction) => {
      await Bills.syncJourney(bill.journeyId, transaction);
      const current = await Intent.findByPk(id, { transaction });
      return this.dto(
        current,
        await Pay.findAll({ where: { intentId: id }, transaction }),
      );
    });
  }
  static async cancel(actor, id) {
    const intent = await Intent.findByPk(id);
    if (!intent || intent.userId !== actor.userId)
      fail("PAYMENT_NOT_FOUND", "Không tìm thấy thanh toán", 404);
    const bill = await Bill.findByPk(intent.billId);
    return Locks.journey(
      bill.journeyId,
      actor,
      async (transaction, tickets) => {
        await Bills.syncJourney(bill.journeyId, transaction);
        const current = await Intent.findByPk(id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (["CANCELLED", "EXPIRED"].includes(current.status))
          return this.dto(current, []);
        if (
          await Receipt.count({
            where: { intentId: id, status: "RECEIVED" },
            transaction,
          })
        )
          fail(
            "PAYMENT_WEBHOOK_PENDING",
            "Đang kiểm tra giao dịch ngân hàng, vui lòng thử lại",
          );
        if (current.status !== "PENDING")
          fail(
            "PAYMENT_CANNOT_CANCEL",
            "Tiền đã được ghi nhận, cần xử lý hoàn tiền",
          );
        const lines = await Pay.findAll({
          where: { intentId: id },
          transaction,
        });
        const itemIds = lines.map((p) => p.billItemId);
        const items = await Item.findAll({
          where: { id: { [Op.in]: itemIds } },
          transaction,
        });
        if (
          tickets.some(
            (t) =>
              items.some((i) => i.ticketId === t.id) &&
              ["6", "7", "4"].includes(t.status),
          )
        )
          fail(
            "PAYMENT_WORK_ALREADY_APPROVED",
            "Không được hủy cam kết khi công việc đã được duyệt",
          );
        await Bills.cancelIntent(current, "RIDER_CANCELLED", transaction);
        await Bills.syncJourney(bill.journeyId, transaction);
        return this.dto(current, []);
      },
    );
  }
  static async confirmCash(actor, paymentId) {
    const snapshot = await Pay.findByPk(paymentId);
    if (!snapshot) fail("PAYMENT_NOT_FOUND", "Không tìm thấy thanh toán", 404);
    const provider = await Provider.findOne({
      where: { id: snapshot.providerId, userId: actor.userId },
    });
    if (!provider) fail("PAYMENT_NOT_FOUND", "Không tìm thấy thanh toán", 404);
    const bill = await Bill.findByPk(snapshot.billId);
    return Locks.transaction(async (transaction) => {
      await Locks.lockJourneys([bill.journeyId], transaction, actor);
      await Bills.syncJourney(bill.journeyId, transaction);
      const p = await Pay.findByPk(paymentId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (p.method !== "CASH")
        fail("PAYMENT_METHOD_MISMATCH", "Chỉ được xác nhận tiền mặt");
      if (p.status === "CONFIRMED") return p;
      if (p.status !== "PENDING")
        fail("PAYMENT_CANNOT_CONFIRM", "Khoản tiền mặt không còn chờ xác nhận");
      const item = await Item.findByPk(p.billItemId, { transaction });
      const ticket = await Ticket.findByPk(item.ticketId, { transaction });
      if (
        ticket.providerId !== p.providerId ||
        !["7", "4", "15", "12"].includes(ticket.status)
      )
        fail(
          "PAYMENT_HANDOVER_REQUIRED",
          "Chỉ xác nhận tiền mặt lúc bàn giao hoặc kết thúc xử lý",
        );
      if (!Money.cents(p.appliedAmount) || p.appliedAmount !== p.amount)
        fail("PAYMENT_CHARGES_CHANGED", "Số tiền cần xác nhận đã thay đổi");
      await p.update(
        { status: "CONFIRMED", paidAt: new Date(), confirmedAt: new Date() },
        { transaction },
      );
      await Bills.syncJourney(bill.journeyId, transaction);
      if (
        p.intentId &&
        !(await Pay.count({
          where: { intentId: p.intentId, status: "PENDING" },
          transaction,
        }))
      )
        await Intent.update(
          { status: "CONFIRMED" },
          { where: { id: p.intentId }, transaction },
        );
      await Bills.event(
        bill.id,
        "CASH_RECEIVED",
        p.id,
        { amount: p.amount },
        transaction,
        actor.userId,
      );
      await Notice.enqueue(
        [bill.userId, p.providerUserId],
        "PAYMENT_CONFIRMED",
        { paymentId: p.id, billId: bill.id },
        transaction,
      );
      return p.reload({ transaction });
    });
  }
  static async completeRefund(actor, id, { externalReference }) {
    const refund = await Refund.findByPk(id);
    if (!refund)
      fail("REFUND_NOT_FOUND", "Không tìm thấy yêu cầu hoàn tiền", 404);
    const bill = await Bill.findByPk(refund.billId);
    return Locks.transaction(async (transaction) => {
      await Locks.lockJourneys([bill.journeyId], transaction, actor);
      await Locks.admin(actor, transaction);
      await Bills.syncJourney(bill.journeyId, transaction);
      const current = await Refund.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (current.status === "COMPLETED") {
        if (current.externalReference !== externalReference)
          fail("REFUND_ALREADY_COMPLETED", "Biên nhận hoàn tiền không khớp");
        return current;
      }
      if (current.status !== "PENDING")
        fail("REFUND_NOT_PENDING", "Yêu cầu không chờ hoàn tiền");
      if (current.paymentId) {
        const p = await Pay.findByPk(current.paymentId, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (p.payoutBatchId)
          fail("PAYMENT_PAYOUT_LOCKED", "Khoản thu đã đưa vào lô đối soát");
        const refunded =
          Money.cents(p.refundedAmount) + Money.cents(current.amount);
        if (refunded > Money.cents(p.amount) - Money.cents(p.appliedAmount))
          fail(
            "REFUND_EXCEEDS_AVAILABLE",
            "Tiền hoàn vượt khoản dư có thể hoàn",
          );
        await p.update(
          {
            refundedAmount: Money.amount(refunded),
            ...(refunded === Money.cents(p.amount) && { status: "REFUNDED" }),
          },
          { transaction },
        );
      }
      if (!current.paymentId && !current.disputeId) {
        const intent = await Intent.findByPk(current.intentId, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const allocated = ["HELD", "CONFIRMED"].includes(intent.status)
          ? Money.cents(intent.amount)
          : 0;
        const done = await Refund.findAll({
          where: { intentId: intent.id, paymentId: null, status: "COMPLETED" },
          transaction,
        });
        const free =
          Money.cents(intent.receivedAmount) -
          allocated -
          done.reduce((n, r) => n + Money.cents(r.amount), 0);
        if (Money.cents(current.amount) > free)
          fail("REFUND_EXCEEDS_AVAILABLE", "Tiền hoàn vượt khoản dư thực nhận");
      }
      if (current.disputeId) {
        const dispute = await require("../models").Dispute.findByPk(
          current.disputeId,
          { transaction, lock: transaction.LOCK.UPDATE },
        );
        if (
          !dispute ||
          dispute.status !== "RESOLVED" ||
          Money.cents(dispute.refundAmount) !== Money.cents(current.amount)
        )
          fail("DISPUTE_REFUND_INVALID", "Phán quyết hoàn tiền không khớp");
      }
      await require("../models").BankTransferProof.create(
        {
          externalReference,
          purpose: "REFUND",
          referenceId: current.id,
          recipientId: bill.userId,
          amount: current.amount,
          confirmedBy: actor.userId,
        },
        { transaction },
      );
      await current.update(
        {
          status: "COMPLETED",
          externalReference,
          completedAt: new Date(),
          completedBy: actor.userId,
        },
        { transaction },
      );
      await Bills.event(
        bill.id,
        "REFUND_COMPLETED",
        current.id,
        { amount: current.amount, externalReference },
        transaction,
        actor.userId,
      );
      await Notice.enqueue(
        [bill.userId],
        "REFUND_COMPLETED",
        { billId: bill.id, refundId: current.id, amount: current.amount },
        transaction,
      );
      if (current.disputeId)
        await require("./dispute.service").event(
          current.disputeId,
          actor.userId,
          "REFUND_COMPLETED",
          { refundId: current.id, amount: current.amount, externalReference },
          transaction,
        );
      return current;
    });
  }
}
module.exports = Payments;
