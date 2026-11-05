const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHmac } = require("node:crypto");
if (process.env.RUN_DB_TESTS !== "1")
  test("SePay gateway integration (RUN_DB_TESTS=1)", { skip: true }, () => {});
else {
  const suffix = randomUUID().replaceAll("-", "");
  Object.assign(process.env, {
    NODE_ENV: "test",
    DB_SCHEMA: `gateway_test_${suffix}`,
    PAYMENT_GATEWAY_MODE: "sandbox",
    SEPAY_API_URL: "https://pgapi-sandbox.sepay.vn",
    SEPAY_MERCHANT_ID: "TEST_MERCHANT",
    SEPAY_SECRET_KEY: "spsk_test_gateway_fixture",
    SEPAY_IPN_SECRET: "independent-ipn-fixture-key",
    JWT_SECRET: randomUUID() + randomUUID(),
    AUTH_REDIS_PREFIX: `gateway-test:${suffix}:auth:`,
    PROVIDER_REDIS_PREFIX: `gateway-test:${suffix}:providers:`,
    DB_FORCE_RESET: "false",
    DB_RESET: "false",
  });
  const { app } = require("../index");
  const db = require("../src/config/postgres.config");
  const redis = require("../src/config/redis.config");
  const {
    User,
    Bill,
    DispatchTicket,
    PaymentIntent,
    BillPayment,
    SepayReceipt,
  } = require("../src/models");
  const Gateway = require("../src/services/sepay_gateway.service");
  const Payments = require("../src/services/payment.service");
  const config = require("../src/config/app.config");
  test("sandbox checkout signs server amounts; authenticated IPN verifies upstream state and credits the ledger exactly once", async (t) => {
    let server;
    try {
      await db.authenticate();
      await db.createSchema(process.env.DB_SCHEMA);
      await db.sync();
      await redis.connect();
      await require("../src/config/database.migrations").runStartupDatabaseMigrations(
        db,
      );
      await require("../src/seeds/demo.seed").seed();
      const rider = await User.findOne({
        where: { email: "rider@demo.roadassist.test" },
      });
      const ticket = await DispatchTicket.findOne({
        where: { userId: rider.userId, type: "WALK_IN", status: "9" },
      });
      const bill = await Bill.findOne({
        where: { journeyId: ticket.journeyId },
      });
      const payment = await Payments.create(rider, "SEPAY", {
        billId: bill.id,
        ticketId: ticket.id,
        clientRequestId: randomUUID(),
      });
      assert.equal(payment.mode, "sandbox");
      assert.equal(
        payment.checkout.url,
        "https://pay-sandbox.sepay.vn/v1/checkout/init",
      );
      assert.equal(payment.checkout.fields.order_amount, "220000");
      const fields = payment.checkout.fields;
      const text = Gateway.SIGNED_FIELDS.filter(
        (k) => fields[k] && fields[k] !== "0",
      )
        .map((k) => `${k}=${fields[k]}`)
        .join(",");
      assert.equal(
        fields.signature,
        createHmac("sha256", config.sepay.secretKey)
          .update(text)
          .digest("base64"),
      );
      assert.ok(!JSON.stringify(payment).includes(config.sepay.secretKey));
      assert.ok(!JSON.stringify(payment).includes(config.sepay.ipnSecret));
      let upstream = {
        order_invoice_number: payment.code,
        order_status: "AUTHENTICATION_NOT_NEEDED",
        order_amount: "220000.00",
        order_currency: "VND",
        transactions: [],
      };
      t.mock.method(require("axios"), "get", async (url, options) => {
        assert.ok(url.startsWith("https://pgapi-sandbox.sepay.vn/"));
        assert.equal(options.auth.username, "TEST_MERCHANT");
        assert.equal(options.maxRedirects, 0);
        return { status: 200, data: { data: upstream } };
      });
      server = require("node:http").createServer(app);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}/api/v1`;
      const session =
        await require("../src/services/auth.service").issueSession(rider, {});
      const ipn = {
        notification_type: "ORDER_PAID",
        order: {
          order_invoice_number: payment.code,
          order_currency: "VND",
          order_amount: "220000.00",
        },
        transaction: {
          id: "gateway-transaction-1",
          transaction_currency: "VND",
        },
      };
      const send = async (secret, body = ipn) =>
        fetch(base + "/payments/sepay/ipn", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Secret-Key": secret,
          },
          body: JSON.stringify(body),
        });
      assert.equal((await send("wrong-key")).status, 401);
      assert.equal(
        (await send(config.sepay.ipnSecret)).status,
        409,
        "An IPN cannot override unpaid upstream state",
      );
      assert.equal(
        (await PaymentIntent.findByPk(payment.id)).status,
        "PENDING",
      );
      upstream = {
        ...upstream,
        order_status: "CAPTURED",
        transactions: [
          {
            id: "gateway-transaction-1",
            transaction_type: "PAYMENT",
            transaction_status: "APPROVED",
            transaction_amount: "220000",
            transaction_currency: "VND",
          },
        ],
      };
      assert.equal(
        (
          await send(config.sepay.ipnSecret, {
            ...ipn,
            order: { ...ipn.order, order_amount: "1" },
          })
        ).status,
        409,
      );
      const originalAmount = upstream.order_amount;
      upstream.order_amount = "1";
      assert.equal((await send(config.sepay.ipnSecret)).status, 409);
      upstream.order_amount = originalAmount;
      assert.equal((await send(config.sepay.ipnSecret)).status, 200);
      assert.equal((await send(config.sepay.ipnSecret)).status, 200);
      const sync = await fetch(base + `/payments/${payment.id}/gateway-sync`, {
        method: "POST",
        headers: { Cookie: `road_as_token=${session.token}` },
      });
      assert.equal(sync.status, 200);
      const data = (await sync.json()).data;
      assert.equal(data.verified, true);
      assert.equal(data.payment.status, "HELD");
      assert.equal(data.payment.checkout, undefined);
      const intent = await PaymentIntent.findByPk(payment.id);
      assert.equal(intent.receivedAmount, "220000.00");
      assert.equal(
        await SepayReceipt.count({ where: { intentId: intent.id } }),
        1,
      );
      assert.equal(
        (await BillPayment.findOne({ where: { intentId: intent.id } })).status,
        "HELD",
      );
      assert.equal(
        (
          await fetch(base + `/payments/${payment.id}/mock-transfer`, {
            method: "POST",
            headers: { Cookie: `road_as_token=${session.token}` },
          })
        ).status,
        403,
      );
      const outsider = await User.findOne({
        where: { email: "mobile@demo.roadassist.test" },
      });
      const otherSession =
        await require("../src/services/auth.service").issueSession(
          outsider,
          {},
        );
      assert.equal(
        (
          await fetch(base + `/payments/${payment.id}/gateway-sync`, {
            method: "POST",
            headers: { Cookie: `road_as_token=${otherSession.token}` },
          })
        ).status,
        404,
      );
      config.sepay.secretKey = "spsk_live_wrong_environment";
      assert.throws(() => Gateway.bank(), /production/);
    } finally {
      if (server?.listening)
        await new Promise((resolve) => server.close(resolve));
      await db
        .dropSchema(process.env.DB_SCHEMA, { cascade: true })
        .catch(() => {});
      let cursor = "0";
      do {
        const result = await redis.scan(
          cursor,
          "MATCH",
          `gateway-test:${suffix}:*`,
          "COUNT",
          1000,
        );
        cursor = result[0];
        if (result[1].length) await redis.del(...result[1]);
      } while (cursor !== "0");
      redis.disconnect();
      await db.close();
    }
  });
}
