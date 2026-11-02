const { Op } = require("sequelize");
const { timingSafeEqual, createHmac, createHash } = require("node:crypto");
const db = require("../config/postgres.config");
const {
  SepayReceipt: Receipt,
  PaymentIntent: Intent,
  BillPayment: Pay,
  Bill,
  FinanceEvent,
} = require("../models");
const Locks = require("./finance_lock.service");
const Bills = require("./bill.service");
const Money = require("../utils/money.util");
const Policy = require("./dispatch_policy.service");
const Notices = require("./finance_notification.service");
const config = require("../config/app.config").sepay;
const equal = (a, b) => {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b || "");
  return x.length === y.length && timingSafeEqual(x, y);
};
const normalize = (value) =>
  String(value || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
class Sepay {
  static assertConfig() {
    Bills.bps();
    if (!["apikey", "hmac"].includes(config.webhookAuth))
      throw new Error("SEPAY_WEBHOOK_AUTH must be apikey or hmac");
    if (
      !Number.isInteger(config.holdDays) ||
      config.holdDays < 0 ||
      config.holdDays > 365
    )
      throw new Error("PAYOUT_HOLD_DAYS must be 0..365");
    if (
      !Number.isInteger(config.paymentTtlMinutes) ||
      config.paymentTtlMinutes < 1 ||
      config.paymentTtlMinutes > 1440
    )
      throw new Error("PAYMENT_TTL_MINUTES must be 1..1440");
  }
  static authenticate(req) {
    if (config.webhookAuth === "hmac") {
      if (!config.webhookSecret)
        Policy.fail("SEPAY_NOT_CONFIGURED", "Chưa cấu hình webhook SePay", 503);
      const timestamp = req.get("X-SePay-Timestamp") || "";
      if (
        !/^\d{10}$/.test(timestamp) ||
        Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
        !req.rawBody
      )
        Policy.fail("SEPAY_WEBHOOK_UNAUTHORIZED", "Webhook không hợp lệ", 401);
      const expected =
        "sha256=" +
        createHmac("sha256", config.webhookSecret)
          .update(timestamp + ".")
          .update(req.rawBody)
          .digest("hex");
      if (!equal(req.get("X-SePay-Signature"), expected))
        Policy.fail("SEPAY_WEBHOOK_UNAUTHORIZED", "Webhook không hợp lệ", 401);
      return;
    }
    if (!config.webhookToken)
      Policy.fail("SEPAY_NOT_CONFIGURED", "Chưa cấu hình webhook SePay", 503);
    const authorization = req.get("Authorization") || "";
    const token = /^Apikey (.+)$/i.exec(authorization)?.[1];
    const alternate = req.get("X-Secret-Key");
    if (
      (authorization && !equal(token, config.webhookToken)) ||
      (alternate && !equal(alternate, config.webhookToken)) ||
      (!token && !alternate)
    )
      Policy.fail("SEPAY_WEBHOOK_UNAUTHORIZED", "Webhook không hợp lệ", 401);
  }
  static codes(payload) {
    const content = String(payload.content || "").toUpperCase();
    const matches = [...content.matchAll(/RA\d{20}(?!\d)/g)].map((m) => m[0]);
    const code = payload.code ? String(payload.code).toUpperCase() : null;
    if (code && /^RA\d{20}$/.test(code)) matches.push(code);
    return [...new Set(matches)];
  }
  static async receive(payload) {
    const semantic = {
      bank: normalize(payload.gateway),
      account: payload.accountNumber,
      subAccount: payload.subAccount || "",
      direction: payload.transferType,
      amount: payload.transferAmount,
      codes: this.codes(payload),
      reference: payload.referenceCode || "",
    };
    const hash = createHash("sha256")
      .update(JSON.stringify(semantic))
      .digest("hex");
    const eventId = String(payload.id);
    const reference = payload.referenceCode
      ? `${normalize(payload.gateway)}:${payload.accountNumber}:${payload.referenceCode}`
      : null;
    const codes = this.codes(payload);
    const known =
      codes.length === 1
        ? await Intent.findOne({ where: { code: codes[0] } })
        : null;
    try {
      const row = await Receipt.create({
        eventId,
        bankReference: reference,
        payload,
        payloadHash: hash,
        intentId: known?.id,
      });
      return row;
    } catch (error) {
      if (error.name !== "SequelizeUniqueConstraintError") throw error;
      const row = await Receipt.findOne({
        where: {
          [Op.or]: [
            { eventId },
            ...(reference ? [{ bankReference: reference }] : []),
          ],
        },
      });
      if (!row || row.payloadHash !== hash) {
        await FinanceEvent.create({
          action: "SEPAY_REPLAY_REJECTED",
          referenceId: row?.id,
          details: { eventId, payload },
        });
        Policy.fail(
          "SEPAY_REPLAY_MISMATCH",
          "Dữ liệu phát lại không khớp giao dịch đã nhận",
        );
      }
      return row;
    }
  }
  static async process(id) {
    const snapshot = await Receipt.findByPk(id);
    if (!snapshot || snapshot.status !== "RECEIVED") return;
    const codes = snapshot.resolvedCode
      ? [snapshot.resolvedCode]
      : this.codes(snapshot.payload);
    if (snapshot.payload.transferType !== "in") {
      await snapshot.update({
        status: "IGNORED",
        reason: "OUTGOING",
        processedAt: new Date(),
      });
      return;
    }
    if (codes.length !== 1) {
      await snapshot.update({
        status: "REVIEW",
        reason: codes.length
          ? "AMBIGUOUS_PAYMENT_CODE"
          : "PAYMENT_CODE_MISSING",
        processedAt: new Date(),
      });
      return;
    }
    const intent = await Intent.findOne({
      where: { code: codes[0], method: "SEPAY" },
    });
    if (!intent) {
      await snapshot.update({
        status: "REVIEW",
        reason: "UNKNOWN_PAYMENT_CODE",
        processedAt: new Date(),
      });
      return;
    }
    const bill = await Bill.findByPk(intent.billId);
    await Locks.journey(bill.journeyId, null, async (transaction) => {
      await Bills.syncJourney(bill.journeyId, transaction);
      const order = await Intent.findByPk(intent.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const receipt = await Receipt.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (receipt.status !== "RECEIVED") return;
      const first = await Receipt.findOne({
        where: { intentId: order.id, status: "RECEIVED" },
        order: [
          ["createdAt", "ASC"],
          ["id", "ASC"],
        ],
        transaction,
      });
      if (first && first.id !== receipt.id) return;
      const data = receipt.payload;
      const bank = order.bankSnapshot;
      if (
        String(data.accountNumber) !== String(bank.accountNumber) ||
        normalize(data.gateway) !== normalize(bank.gatewayName) ||
        (bank.subAccount && data.subAccount !== bank.subAccount)
      ) {
        await receipt.update(
          {
            status: "REVIEW",
            reason: "BANK_ACCOUNT_MISMATCH",
            intentId: order.id,
            processedAt: new Date(),
          },
          { transaction },
        );
        return;
      }
      const received =
        Money.cents(order.receivedAmount) + Money.cents(data.transferAmount);
      if (received > 999999999999) {
        await receipt.update(
          {
            status: "REVIEW",
            reason: "RECEIPT_BALANCE_LIMIT",
            processedAt: new Date(),
          },
          { transaction },
        );
        return;
      }
      await order.update(
        { receivedAmount: Money.amount(received) },
        { transaction },
      );
      const active =
        order.status === "PENDING" && receipt.createdAt <= order.expiresAt;
      if (active && received >= Money.cents(order.amount)) {
        await order.update({ status: "HELD" }, { transaction });
        await Pay.update(
          {
            status: "HELD",
            paidAt: new Date(),
            sepayReference: String(data.referenceCode || data.id),
          },
          { where: { intentId: order.id, status: "PENDING" }, transaction },
        );
        await Bills.event(
          bill.id,
          "SEPAY_FUNDS_HELD",
          order.id,
          { amount: order.amount, receiptId: receipt.id },
          transaction,
        );
        await Notices.enqueue(
          [
            bill.userId,
            ...(
              await Pay.findAll({
                where: { intentId: order.id },
                attributes: ["providerUserId"],
                transaction,
              })
            ).map((p) => p.providerUserId),
          ],
          "PAYMENT_HELD",
          { billId: bill.id, intentId: order.id },
          transaction,
        );
      }
      const allocated = ["HELD", "CONFIRMED"].includes(order.status)
        ? Money.cents(order.amount)
        : 0;
      if (!active || received > Money.cents(order.amount))
        await Bills.refundDue(
          {
            billId: bill.id,
            intentId: order.id,
            due: Math.max(0, received - allocated),
            reason: allocated
              ? "EXCESS_TRANSFER"
              : "LATE_OR_CANCELLED_TRANSFER",
          },
          transaction,
        );
      await receipt.update(
        {
          status: "APPLIED",
          intentId: order.id,
          processedAt: new Date(),
          attempts: receipt.attempts + 1,
        },
        { transaction },
      );
      await Bills.syncJourney(bill.journeyId, transaction);
    });
  }
  static async reconcile(actor, id, { intentId, reason }) {
    const target = await Intent.findByPk(intentId);
    if (!target || target.method !== "SEPAY")
      Policy.fail("PAYMENT_NOT_FOUND", "Không tìm thấy mã SePay", 404);
    const bill = await Bill.findByPk(target.billId);
    return Locks.transaction(async (transaction) => {
      await Locks.lockJourneys([bill.journeyId], transaction, actor);
      await Locks.admin(actor, transaction);
      const receipt = await Receipt.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!receipt)
        Policy.fail("RECEIPT_NOT_FOUND", "Không tìm thấy giao dịch", 404);
      if (receipt.status !== "REVIEW")
        Policy.fail("RECEIPT_NOT_REVIEWABLE", "Giao dịch không chờ đối soát");
      const data = receipt.payload,
        bank = target.bankSnapshot;
      if (
        data.transferType !== "in" ||
        data.accountNumber !== bank.accountNumber ||
        normalize(data.gateway) !== normalize(bank.gatewayName) ||
        (bank.subAccount && data.subAccount !== bank.subAccount)
      )
        Policy.fail(
          "SEPAY_TRANSACTION_MISMATCH",
          "Tài khoản thực nhận không khớp mã thanh toán",
          400,
        );
      await receipt.update(
        {
          intentId: target.id,
          resolvedCode: target.code,
          status: "RECEIVED",
          reason: "ADMIN_RECONCILED",
          processedAt: null,
        },
        { transaction },
      );
      await Bills.event(
        bill.id,
        "RECEIPT_RECONCILED",
        receipt.id,
        { intentId, reason },
        transaction,
        actor.userId,
      );
      return receipt;
    });
  }
  static async refundReviewed(actor, id, { externalReference, reason }) {
    return Locks.transaction(async (transaction) => {
      await Locks.admin(actor, transaction);
      const receipt = await Receipt.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!receipt)
        Policy.fail("RECEIPT_NOT_FOUND", "Không tìm thấy giao dịch", 404);
      if (receipt.status === "REFUNDED") {
        const proof = await require("../models").BankTransferProof.findOne({
          where: { referenceId: id, purpose: "REFUND" },
          transaction,
        });
        if (proof?.externalReference !== externalReference)
          Policy.fail(
            "REFUND_ALREADY_COMPLETED",
            "Giao dịch đã ghi nhận hoàn với biên nhận khác",
          );
        return receipt;
      }
      if (receipt.status !== "REVIEW" || receipt.payload.transferType !== "in")
        Policy.fail(
          "RECEIPT_NOT_REVIEWABLE",
          "Chỉ hoàn giao dịch vào đang chờ đối soát",
        );
      const data = receipt.payload;
      const historical = await Intent.findAll({
        where: { "bankSnapshot.accountNumber": data.accountNumber },
        attributes: ["bankSnapshot"],
        transaction,
      });
      const banks = [
        {
          accountNumber: config.accountNumber,
          gatewayName: config.gatewayName,
          subAccount: config.subAccount,
        },
        ...historical.map((i) => i.bankSnapshot),
      ];
      if (
        !banks.some(
          (bank) =>
            bank.accountNumber === data.accountNumber &&
            normalize(bank.gatewayName) === normalize(data.gateway) &&
            (!bank.subAccount || bank.subAccount === data.subAccount),
        )
      )
        Policy.fail(
          "SEPAY_TRANSACTION_MISMATCH",
          "Không xác định được tài khoản doanh nghiệp thực nhận",
          400,
        );
      await require("../models").BankTransferProof.create(
        {
          externalReference,
          purpose: "REFUND",
          referenceId: id,
          recipientId: null,
          amount: Money.amount(Money.cents(data.transferAmount)),
          confirmedBy: actor.userId,
        },
        { transaction },
      );
      await receipt.update(
        {
          status: "REFUNDED",
          reason: "MANUALLY_REFUNDED",
          processedAt: new Date(),
        },
        { transaction },
      );
      await Bills.event(
        null,
        "RECEIPT_REFUNDED",
        id,
        { externalReference, reason, amount: data.transferAmount },
        transaction,
        actor.userId,
      );
      return receipt;
    });
  }
  static async processInbox() {
    const rows = await Receipt.findAll({
      where: { status: "RECEIVED" },
      order: [
        ["createdAt", "ASC"],
        ["id", "ASC"],
      ],
      limit: 100,
    });
    for (const row of rows) {
      try {
        await this.process(row.id);
      } catch (e) {
        await row.increment("attempts");
        console.error("[SePay inbox]", e.errorCode || e.name);
      }
    }
  }
}
module.exports = Sepay;
