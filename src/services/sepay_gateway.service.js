const axios = require("axios");
const { createHmac, createHash, timingSafeEqual } = require("node:crypto");
const config = require("../config/app.config");
const { PaymentIntent: Intent, FinanceEvent } = require("../models");
const Money = require("../utils/money.util");
const fail = require("./dispatch_policy.service").fail;
const SIGNED_FIELDS = [
  "order_amount",
  "merchant",
  "currency",
  "operation",
  "order_description",
  "order_invoice_number",
  "customer_id",
  "payment_method",
  "success_url",
  "error_url",
  "cancel_url",
];
const API = "https://pgapi-sandbox.sepay.vn";
const CHECKOUT = "https://pay-sandbox.sepay.vn/v1/checkout/init";
class Gateway {
  static assertConfigured() {
    const c = config.sepay;
    if (c.mode !== "sandbox" || config.app.isProduction)
      fail(
        "SEPAY_GATEWAY_DISABLED",
        "Cổng thanh toán sandbox chưa được bật",
        503,
      );
    if (!c.merchantId || !c.secretKey || !c.ipnSecret)
      fail(
        "SEPAY_NOT_CONFIGURED",
        "Cần Merchant ID, Secret Key và khóa IPN SePay sandbox",
        503,
      );
    if (c.secretKey.startsWith("spsk_live_"))
      fail(
        "SEPAY_ENVIRONMENT_MISMATCH",
        "Không dùng khóa production trong sandbox",
        503,
      );
    if (c.apiUrl.replace(/\/+$/, "") !== API)
      fail(
        "SEPAY_ENVIRONMENT_MISMATCH",
        "SEPAY_API_URL phải trỏ tới sandbox của cổng thanh toán",
        503,
      );
  }
  static bank() {
    this.assertConfigured();
    return {
      adapter: "checkout",
      environment: "sandbox",
      mock: false,
      merchantId: config.sepay.merchantId,
      accountNumber: config.sepay.merchantId,
      gatewayName: "SEPAY_GATEWAY_SANDBOX",
    };
  }
  static signature(fields, secret = config.sepay.secretKey) {
    const text = SIGNED_FIELDS.filter(
      (key) => fields[key] && String(fields[key]) !== "0",
    )
      .map((key) => `${key}=${fields[key]}`)
      .join(",");
    return createHmac("sha256", secret).update(text).digest("base64");
  }
  static assertIntent(intent) {
    this.assertConfigured();
    if (
      intent.method !== "SEPAY" ||
      intent.bankSnapshot.adapter !== "checkout" ||
      intent.bankSnapshot.environment !== "sandbox" ||
      intent.bankSnapshot.merchantId !== config.sepay.merchantId
    )
      fail(
        "SEPAY_ENVIRONMENT_MISMATCH",
        "Yêu cầu thanh toán không thuộc merchant sandbox hiện tại",
        409,
      );
  }
  static checkout(intent) {
    this.assertIntent(intent);
    const fields = {
      order_amount: String(Money.cents(intent.amount) / 100),
      merchant: config.sepay.merchantId,
      currency: "VND",
      operation: "PURCHASE",
      order_description: `RoadAssist ${intent.code}`,
      order_invoice_number: intent.code,
      payment_method: "BANK_TRANSFER",
    };
    const base = config.sepay.returnBaseUrl;
    if (base) {
      const parsed = new URL(base);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password)
        fail(
          "SEPAY_NOT_CONFIGURED",
          "URL trở về SePay phải là HTTPS công khai",
          503,
        );
      const target = new URL("/dashboard/bills", base);
      target.searchParams.set("bill", intent.billId);
      target.searchParams.set("payment", intent.id);
      for (const [key, result] of [
        ["success_url", "success"],
        ["error_url", "error"],
        ["cancel_url", "cancel"],
      ]) {
        const url = new URL(target);
        url.searchParams.set("checkout", result);
        fields[key] = url.href;
      }
    }
    // Preserve SePay's signed field order in the form, including optional URLs.
    fields.signature = this.signature(fields);
    return { url: CHECKOUT, method: "POST", fields };
  }
  static async retrieve(code) {
    this.assertConfigured();
    try {
      const response = await axios.get(
        `${API}/v1/order/detail/${encodeURIComponent(code)}`,
        {
          auth: {
            username: config.sepay.merchantId,
            password: config.sepay.secretKey,
          },
          timeout: 10000,
          maxRedirects: 0,
          maxContentLength: 1024 * 1024,
          validateStatus: () => true,
        },
      );
      if (response.status === 404) return null;
      if (
        response.status !== 200 ||
        !response.data?.data ||
        Array.isArray(response.data.data)
      )
        fail(
          "SEPAY_GATEWAY_UNAVAILABLE",
          "Không thể xác minh đơn hàng với SePay sandbox",
          503,
        );
      return response.data.data;
    } catch (error) {
      if (error.errorCode) throw error;
      fail("SEPAY_GATEWAY_UNAVAILABLE", "Không thể kết nối SePay sandbox", 503);
    }
  }
  static async verifyAndApply(intent, expectedTransactionId) {
    this.assertIntent(intent);
    const order = await this.retrieve(intent.code);
    if (!order) return { verified: false, reason: "ORDER_NOT_FOUND" };
    if (
      order.order_invoice_number !== intent.code ||
      order.order_currency !== "VND" ||
      Money.cents(order.order_amount) !== Money.cents(intent.amount)
    )
      fail(
        "SEPAY_TRANSACTION_MISMATCH",
        "Đơn hàng SePay không khớp mã, tiền tệ hoặc số tiền",
        409,
      );
    if (order.order_status !== "CAPTURED")
      return {
        verified: false,
        reason: String(order.order_status || "PENDING"),
      };
    const transactions = (
      Array.isArray(order.transactions) ? order.transactions : []
    ).filter(
      (tx) =>
        tx.transaction_type === "PAYMENT" &&
        tx.transaction_status === "APPROVED",
    );
    if (
      !transactions.length ||
      transactions.some(
        (tx) =>
          tx.transaction_currency !== "VND" ||
          !String(tx.id || tx.transaction_id || ""),
      ) ||
      transactions.reduce(
        (sum, tx) => sum + Money.cents(tx.transaction_amount),
        0,
      ) !== Money.cents(intent.amount)
    )
      fail(
        "SEPAY_TRANSACTION_MISMATCH",
        "Giao dịch SePay không khớp khoản phải thu",
        409,
      );
    if (
      expectedTransactionId &&
      !transactions.some(
        (tx) =>
          String(tx.id) === expectedTransactionId ||
          String(tx.transaction_id) === expectedTransactionId,
      )
    )
      fail(
        "SEPAY_TRANSACTION_MISMATCH",
        "Giao dịch IPN không thuộc đơn hàng đã xác minh",
        409,
      );
    const Sepay = require("./sepay.service");
    for (const tx of transactions) {
      const id = String(tx.id || tx.transaction_id);
      const hash = createHash("sha256")
        .update(`sandbox:${config.sepay.merchantId}:${intent.code}:${id}`)
        .digest("hex");
      const receipt = await Sepay.receive({
        id: `PG:${hash}`,
        gateway: intent.bankSnapshot.gatewayName,
        accountNumber: intent.bankSnapshot.accountNumber,
        code: intent.code,
        content: intent.code,
        transferType: "in",
        transferAmount: Number(tx.transaction_amount),
        referenceCode: `PG:${hash}`,
        gatewayVerified: true,
      });
      await Sepay.process(receipt.id);
    }
    return { verified: true };
  }
  static authenticate(req) {
    this.assertConfigured();
    const given = Buffer.from(req.get("X-Secret-Key") || "");
    const expected = Buffer.from(config.sepay.ipnSecret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      fail("SEPAY_WEBHOOK_UNAUTHORIZED", "IPN SePay không hợp lệ", 401);
  }
  static async ipn(data) {
    const code = data?.order?.order_invoice_number;
    if (typeof code !== "string" || !/^RA\d{20}$/.test(code))
      fail("VALIDATION_ERROR", "IPN thiếu mã hóa đơn hợp lệ", 400);
    const intent = await Intent.findOne({ where: { code, method: "SEPAY" } });
    if (!intent)
      fail("PAYMENT_NOT_FOUND", "Không tìm thấy yêu cầu thanh toán", 404);
    this.assertIntent(intent);
    if (data.notification_type === "TRANSACTION_VOID") {
      await FinanceEvent.create({
        action: "SEPAY_GATEWAY_VOID_REVIEW",
        referenceId: intent.id,
        details: { code },
      });
      return { review: true };
    }
    if (
      data.notification_type !== "ORDER_PAID" ||
      !data.transaction ||
      data.order.order_currency !== "VND" ||
      Money.cents(data.order.order_amount) !== Money.cents(intent.amount) ||
      data.transaction.transaction_currency !== "VND"
    )
      fail("SEPAY_TRANSACTION_MISMATCH", "IPN không khớp đơn hàng", 409);
    const verified = await this.verifyAndApply(
      intent,
      String(data.transaction.id || data.transaction.transaction_id || ""),
    );
    if (!verified.verified)
      fail(
        "SEPAY_NOT_VERIFIED",
        "SePay chưa xác nhận đơn hàng đã thanh toán",
        409,
      );
    return verified;
  }
  static async sync(actor, id) {
    const intent = await Intent.findByPk(id);
    if (!intent || intent.userId !== actor.userId)
      fail("PAYMENT_NOT_FOUND", "Không tìm thấy yêu cầu thanh toán", 404);
    const verification = await this.verifyAndApply(intent);
    return {
      ...verification,
      payment: await require("./payment.service").get(actor, id),
    };
  }
}
module.exports = Gateway;
module.exports.SIGNED_FIELDS = SIGNED_FIELDS;
