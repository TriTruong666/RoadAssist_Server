const { createHash } = require("node:crypto");
const { PaymentIntent } = require("../models");
const config = require("../config/app.config");
const Payments = require("./payment.service");
const Sepay = require("./sepay.service");
const Policy = require("./dispatch_policy.service");
module.exports = {
  async transfer(actor, id) {
    if (config.sepay.mode !== "mock" || config.app.isProduction)
      Policy.fail("MOCK_PAYMENT_DISABLED", "Mô phỏng thanh toán đang tắt", 403);
    const intent = await PaymentIntent.findByPk(id);
    if (!intent || intent.userId !== actor.userId)
      Policy.fail(
        "PAYMENT_NOT_FOUND",
        "Không tìm thấy yêu cầu thanh toán",
        404,
      );
    if (intent.method !== "SEPAY" || !intent.bankSnapshot.mock)
      Policy.fail(
        "MOCK_PAYMENT_REQUIRED",
        "Chỉ mô phỏng yêu cầu được tạo ở chế độ mock",
        409,
      );
    if (
      !["PENDING", "HELD", "CONFIRMED"].includes(intent.status) ||
      intent.expiresAt <= new Date()
    )
      Policy.fail(
        "PAYMENT_EXPIRED",
        "Yêu cầu thanh toán đã hết hạn hoặc bị hủy",
        409,
      );
    // A deterministic reference makes repeated clicks and concurrent requests idempotent.
    const idNumber = BigInt(
      "0x" + createHash("sha256").update(intent.id).digest("hex").slice(0, 20),
    ).toString();
    const receipt = await Sepay.receive({
      id: idNumber,
      gateway: intent.bankSnapshot.gatewayName,
      accountNumber: intent.bankSnapshot.accountNumber,
      content: intent.code,
      transferType: "in",
      transferAmount: Number(intent.amount),
      referenceCode: `MOCK-${intent.id}`,
    });
    await Sepay.process(receipt.id);
    return { mock: true, payment: await Payments.get(actor, id) };
  },
};
