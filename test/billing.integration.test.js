const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHmac } = require("node:crypto");
if (process.env.RUN_DB_TESTS !== "1")
  test(
    "Phase 6 billing integration (RUN_DB_TESTS=1)",
    { skip: true },
    () => {},
  );
else {
  const suffix = randomUUID().replaceAll("-", "");
  Object.assign(process.env, {
    NODE_ENV: "test",
    DB_SCHEMA: `billing_test_${suffix}`,
    AUTH_REDIS_PREFIX: `test:${suffix}:auth:`,
    PROVIDER_REDIS_PREFIX: `test:${suffix}:provider:`,
    JWT_SECRET: randomUUID() + randomUUID(),
    ALLOWED_CLIENT_URL_1: "http://localhost:5173",
    SEPAY_WEBHOOK_TOKEN: "test-webhook-secret-at-least-32-bytes",
    SEPAY_ACCOUNT_NUMBER: "0123456789",
    SEPAY_BANK_CODE: "MBBank",
    SEPAY_GATEWAY_NAME: "MBBank",
    SEPAY_WEBHOOK_SECRET: "test-hmac-secret-at-least-32-bytes",
    PAYOUT_HOLD_DAYS: "0",
  });
  require("./s3.fixture");
  const { app } = require("../index");
  const db = require("../src/config/postgres.config");
  const redis = require("../src/config/redis.config");
  const models = require("../src/models");
  const {
    User,
    Provider,
    VehicleProfile: Vehicle,
    VehicleRideConfig: Ride,
    DispatchTicket: Ticket,
    Bill,
    BillItem: Item,
    BillPayment: Pay,
    PaymentIntent: Intent,
    SepayReceipt: Receipt,
    Refund,
    PayoutBatch: Batch,
    PayoutEntry: Entry,
    PayoutOffset: Offset,
    FinanceEvent,
    FinanceNotice,
  } = models;
  const Bills = require("../src/services/bill.service");
  const Payments = require("../src/services/payment.service");
  const Sepay = require("../src/services/sepay.service");
  const Payouts = require("../src/services/payout.service");
  const Locks = require("../src/services/finance_lock.service");
  const config = require("../src/config/app.config").sepay;
  let server, io, base, rider, other, provider, provider2, admin, shop, shop2;
  let n = 0,
    receiptNo = 1000;
  const point = { latitude: 10.77, longitude: 106.69 };
  const gps = () => ({
    ...point,
    accuracy: 5,
    recordedAt: new Date().toISOString(),
  });
  async function account(i, role = "guest") {
    const user = await User.create({
      name: `Finance ${i}`,
      email: `finance-${i}@example.com`,
      phone: `09110000${String(i).padStart(2, "0")}`,
      password: "Finance-strong-password!",
      emailVerifiedAt: new Date(),
      role,
    });
    const session = await require("../src/services/auth.service").completeLogin(
      { userId: user.userId, ipAddress: "127.0.0.1" },
    );
    return { userId: user.userId, token: session.token, role };
  }
  async function request(
    actor,
    method,
    path,
    body,
    status = 200,
    headers = {},
  ) {
    const response = await fetch(base + "/api/v1" + path, {
      method,
      headers: {
        ...(actor && { Cookie: `road_as_token=${actor.token}` }),
        ...(body !== undefined && { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data.data === undefined ? data : data.data;
  }
  const act = async (actor, t, action, body = {}, status = 200) => {
    if (["start","resolve"].includes(action)) await require('./handover.fixture')(t.id,action === "start" ? "PICKUP" : "DELIVERY");
    return request(actor, "POST", `/dispatch/${t.id}/${action}`, body, status);
  };
  async function quote(
    amount = "100000",
    actor = rider,
    p = shop,
    pActor = provider,
  ) {
    const vehicle = await Vehicle.create({
      userId: actor.userId,
      type: "BIKE",
      plateNumber: `FIN-${++n}`,
      brand: "Honda",
      modelName: "Fixture",
      length: 2,
      weightKg: 150,
    });
    await Ride.create({
      vehicleProfileId: vehicle.id,
      mode: "SOLO",
      width: vehicle.baseWidth,
      height: vehicle.baseHeight,
    });
    const ticket = await request(
      actor,
      "POST",
      "/dispatch/walk-in",
      { vehicleProfileId: vehicle.id, providerId: p.id, location: gps() },
      201,
    );
    await act(pActor, ticket, "accept", { providerId: p.id });
    await act(pActor, ticket, "quote", { amount });
    const bill = await Bill.findOne({ where: { journeyId: ticket.journeyId } });
    return { ticket, bill, actor, provider: p, providerActor: pActor };
  }
  async function choose(s, method = "SEPAY", extra = {}) {
    return request(
      s.actor,
      "POST",
      method === "SEPAY"
        ? "/payments/create-sepay-qr"
        : "/payments/choose-cash",
      { billId: s.bill.id, ...extra },
      201,
    );
  }
  const payload = (intent, amount = Number(intent.amount), extra = {}) => ({
    id: ++receiptNo,
    gateway: "MBBank",
    accountNumber: "0123456789",
    content: intent.code,
    transferType: "in",
    transferAmount: amount,
    referenceCode: `BANK-${receiptNo}`,
    transactionDate: "2026-11-02 10:00:00",
    ...extra,
  });
  async function hook(
    data,
    status = 200,
    headers = { Authorization: "Apikey " + config.webhookToken },
  ) {
    return request(
      null,
      "POST",
      "/payments/sepay/webhook",
      data,
      status,
      headers,
    );
  }
  async function wait(check) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await check();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Timed out waiting for payment processing");
  }
  async function settleCash(s) {
    const intent = await choose(s, "CASH");
    await act(s.actor, s.ticket, "approve-quote");
    await act(s.providerActor, s.ticket, "ready");
    for (const p of intent.payments)
      await request(s.providerActor, "POST", "/payments/confirm-cash", {
        paymentId: p.id,
      });
    await act(s.actor, s.ticket, "resolve");
    return intent;
  }
  async function settleOnline(s) {
    const intent = await choose(s);
    await hook(payload(intent));
    await wait(
      async () => (await Pay.findByPk(intent.payments[0].id)).status === "HELD",
    );
    await act(s.actor, s.ticket, "approve-quote");
    await act(s.providerActor, s.ticket, "ready");
    await act(s.actor, s.ticket, "resolve");
    return intent;
  }
  before(async () => {
    await db.authenticate();
    await db.createSchema(process.env.DB_SCHEMA);
    await db.sync();
    await redis.connect();
    server = require("http").createServer(app);
    io = require("../src/realtime/chat.socket")(server, app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    [rider, other, provider, provider2, admin] = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => account(i, i === 5 ? "admin" : "guest")),
    );
    const createShop = (actor) =>
      Provider.create({
        userId: actor.userId,
        name: "Finance shop",
        phone: "0901234567",
        kind: "SHOP",
        ...point,
        address: "Shop",
        status: "ACTIVE",
        accepting: true,
        maxConcurrentJobs: 20,
        requiresApproval: false,
        capabilities: ["TYRE_REPAIR", "ENGINE_REPAIR"],
        supportedVehicleTypes: ["BIKE", "CAR"],
        serviceSegments: ["SOLO_BIKE", "CAR"],
      });
    shop = await createShop(provider);
    shop2 = await createShop(provider2);
  });
  afterEach(async () => {
    await Sepay.processInbox();
    const names = ["Handover","Dispute","DisputeEvent","ProviderRecovery","RecoveryOffset",
      "BankTransferProof",
      "FinanceNotice",
      "FinanceEvent",
      "PayoutOffset",
      "PayoutEntry",
      "PayoutBatch",
      "Refund",
      "SepayReceipt",
      "BillPayment",
      "PaymentIntent",
      "BillItem",
      "Bill",
      "DispatchTicket",
      "ChatRoom",
    ];
    const q = db.getQueryInterface().queryGenerator;
    await db.query(
      `TRUNCATE ${names.map((name) => q.quoteTable(db.models[name].getTableName())).join(",")} CASCADE`,
    );
    config.webhookAuth = "apikey";
    config.holdDays = 0;
  });
  after(async () => {
    if (io) await new Promise((resolve) => io.close(resolve));
    if (server?.listening)
      await new Promise((resolve) => server.close(resolve));
    for (const prefix of [
      process.env.AUTH_REDIS_PREFIX,
      process.env.PROVIDER_REDIS_PREFIX,
    ]) {
      const keys = await redis.keys(prefix + "*");
      if (keys.length) await redis.del(...keys);
    }
    redis.disconnect();
    await db.dropSchema(process.env.DB_SCHEMA, { cascade: true });
    await db.close();
  });
  test("server creates one journey bill and enforces rider ownership, allocations and payment idempotency", async () => {
    const s = await quote();
    assert.equal(await Bill.count(), 1);
    await request(null, "GET", "/bills/my-bills", undefined, 401);
    await request(other, "GET", `/bills/${s.bill.id}`, undefined, 404);
    const detail = await request(rider, "GET", `/bills/${s.bill.id}`);
    assert.equal(detail.totalAmount, "100000.00");
    assert.equal(detail.items.length, 1);
    const key = randomUUID();
    const intents = await Promise.all(
      [1, 2, 3].map(() =>
        choose(s, "CASH", {
          clientRequestId: key,
          amount: 1,
          providerId: shop2.id,
        }),
      ),
    );
    assert.equal(new Set(intents.map((i) => i.id)).size, 1);
    assert.equal(intents[0].amount, "100000.00");
    assert.equal(await Pay.count(), 1);
    await choose(s, "SEPAY", { clientRequestId: key })
      .then(() => assert.fail("Expected conflict"))
      .catch((e) => assert.match(e.message, /409/));
    const count = await request(rider, "GET", "/bills/my-bills");
    assert.equal(count.unpaidCount, 1);
  });
  test("SePay QR snapshots destination and verified duplicate receipts hold funds exactly once without auto-start", async () => {
    const s = await quote();
    const intent = await choose(s);
    assert.ok(intent.bank.qrUrl.startsWith("https://vietqr.app/img?"));
    assert.match(intent.code, /^RA\d{20}$/);
    const data = payload(intent);
    await Promise.all([hook(data), hook(data), hook(data)]);
    await wait(
      async () => (await Pay.findByPk(intent.payments[0].id)).status === "HELD",
    );
    assert.equal(await Receipt.count(), 1);
    assert.equal((await Bill.findByPk(s.bill.id)).paidAmount, "100000.00");
    assert.equal((await Ticket.findByPk(s.ticket.id)).status, "9");
    await act(rider, s.ticket, "approve-quote");
    await act(provider, s.ticket, "ready");
    await act(rider, s.ticket, "resolve");
    const p = await Pay.findByPk(intent.payments[0].id);
    assert.equal(p.status, "CONFIRMED");
    assert.equal(p.commissionAmount, "10000.00");
    assert.equal(p.payoutAmount, "90000.00");
  });
  test("wrong authentication, account, outgoing, ambiguous codes and altered replay never credit an invoice", async () => {
    const s = await quote();
    const intent = await choose(s);
    await hook(payload(intent), 401, {});
    await hook(payload(intent), 401, { Authorization: "Apikey wrong" });
    await hook(payload(intent, 100000, { accountNumber: "wrong" }));
    await wait(
      async () => await Receipt.count({ where: { status: "REVIEW" } }),
    );
    assert.equal((await Pay.findByPk(intent.payments[0].id)).status, "PENDING");
    await hook(payload(intent, 100000, { transferType: "out" }));
    await hook(
      payload(intent, 100000, {
        content: intent.code + " RA00000000000000000001",
      }),
    );
    await Sepay.processInbox();
    assert.equal((await Bill.findByPk(s.bill.id)).paidAmount, "0.00");
    const good = payload(intent);
    await hook(good);
    await wait(
      async () => (await Pay.findByPk(intent.payments[0].id)).status === "HELD",
    );
    await hook({ ...good, transferAmount: 99999 }, 409);
  });
  test("partial transfers accumulate, overpayment is refundable and extra transfers cannot fund twice", async () => {
    const s = await quote();
    const intent = await choose(s);
    await hook(payload(intent, 30000));
    await wait(
      async () =>
        (await Intent.findByPk(intent.id)).receivedAmount === "30000.00",
    );
    assert.equal((await Pay.findByPk(intent.payments[0].id)).status, "PENDING");
    await act(rider, s.ticket, "approve-quote", {}, 403);
    await hook(payload(intent, 80000));
    await wait(
      async () => (await Pay.findByPk(intent.payments[0].id)).status === "HELD",
    );
    assert.equal((await Bill.findByPk(s.bill.id)).paidAmount, "100000.00");
    assert.equal(
      (
        await Refund.findOne({
          where: { intentId: intent.id, paymentId: null, status: "PENDING" },
        })
      ).amount,
      "10000.00",
    );
    await hook(payload(intent, 5000));
    await wait(
      async () =>
        (await Intent.findByPk(intent.id)).receivedAmount === "115000.00",
    );
    assert.equal(
      (
        await Refund.findOne({
          where: { intentId: intent.id, paymentId: null, status: "PENDING" },
        })
      ).amount,
      "15000.00",
    );
  });
  test("late/cancelled QR funds are quarantined for refund while a cash commitment stays independent", async () => {
    const s = await quote();
    const online = await choose(s);
    await request(rider, "POST", `/payments/${online.id}/cancel`, {});
    const cash = await choose(s, "CASH");
    await hook(payload(online));
    await wait(
      async () => await Refund.count({ where: { intentId: online.id } }),
    );
    assert.equal(
      (await Pay.findByPk(online.payments[0].id)).status,
      "CANCELLED",
    );
    assert.equal((await Pay.findByPk(cash.payments[0].id)).status, "PENDING");
    assert.equal((await Bill.findByPk(s.bill.id)).paidAmount, "0.00");
    const refund = await Refund.findOne({ where: { intentId: online.id } });
    await request(
      other,
      "POST",
      `/admin/finance/refunds/${refund.id}/complete`,
      { externalReference: "REF-1" },
      403,
    );
    await request(
      admin,
      "POST",
      `/admin/finance/refunds/${refund.id}/complete`,
      { externalReference: "REF-1" },
    );
    await request(
      admin,
      "POST",
      `/admin/finance/refunds/${refund.id}/complete`,
      { externalReference: "REF-1" },
    );
    await request(
      admin,
      "POST",
      `/admin/finance/refunds/${refund.id}/complete`,
      { externalReference: "REF-OTHER" },
      409,
    );
  });
  test("cash unlocks approval as a promise, requires the assigned provider at handover and creates commission debt", async () => {
    const s = await quote();
    const intent = await choose(s, "CASH");
    const id = intent.payments[0].id;
    await request(
      provider,
      "POST",
      "/payments/confirm-cash",
      { paymentId: id },
      409,
    );
    await request(
      other,
      "POST",
      "/payments/confirm-cash",
      { paymentId: id },
      404,
    );
    await act(rider, s.ticket, "approve-quote");
    await request(rider, "POST", `/payments/${intent.id}/cancel`, {}, 409);
    await act(provider, s.ticket, "ready");
    await request(provider, "POST", "/payments/confirm-cash", {
      paymentId: id,
    });
    await request(provider, "POST", "/payments/confirm-cash", {
      paymentId: id,
    });
    await act(rider, s.ticket, "resolve");
    const p = await Pay.findByPk(id);
    assert.equal(p.payoutAmount, "0.00");
    assert.equal(p.cashCommissionOutstanding, "10000.00");
    const earnings = await request(
      provider,
      "GET",
      "/payments/provider-earnings",
    );
    assert.equal(earnings.cashCommissionDebt, "10000.00");
  });
  test("cash commission offsets online payout without double paying cash; settle is idempotent and precise", async () => {
    const cash = await settleCash(await quote());
    const online = await settleOnline(await quote());
    await request(rider, "POST", "/admin/payouts/create-batch", {}, 403);
    const batch = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    assert.equal(batch.net, "80000.00");
    assert.equal(batch.entries[0].cashGross, "100000.00");
    assert.equal(batch.entries[0].debtOffset, "10000.00");
    const transfer = {
      entryId: batch.entries[0].id,
      amount: "80000",
      reference: "PAYOUT-BANK-1",
    };
    await request(
      admin,
      "PUT",
      `/admin/payouts/${batch.id}/settle`,
      { transfers: [{ ...transfer, amount: "1" }] },
      409,
    );
    await request(admin, "PUT", `/admin/payouts/${batch.id}/settle`, {
      transfers: [transfer],
    });
    await request(admin, "PUT", `/admin/payouts/${batch.id}/settle`, {
      transfers: [transfer],
    });
    assert.equal(
      (await Pay.findByPk(cash.payments[0].id)).cashCommissionOutstanding,
      "0.00",
    );
    assert.equal((await Batch.findByPk(batch.id)).status, "SETTLED");
    await request(admin, "POST", "/admin/payouts/create-batch", {}, 409);
  });
  test("commission debt carries across cash-only batches and across profiles of the same owner", async () => {
    const cash = await settleCash(await quote("100000"));
    const first = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    assert.equal(first.net, "0.00");
    await request(admin, "PUT", `/admin/payouts/${first.id}/settle`, {
      transfers: [],
    });
    assert.equal(
      (await Pay.findByPk(cash.payments[0].id)).cashCommissionOutstanding,
      "10000.00",
    );
    await shop.update({ status: "REVOKED", accepting: false });
    let replacement;
    try {
      const attrs = {
        ...shop.get(),
        id: randomUUID(),
        status: "ACTIVE",
        accepting: true,
      };
      delete attrs.createdAt;
      delete attrs.updatedAt;
      replacement = await Provider.create(attrs);
      await settleOnline(await quote("5000", rider, replacement, provider));
    } finally {
      if (replacement) await replacement.destroy();
      await shop.update({ status: "ACTIVE", accepting: true });
    }
    const second = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    assert.equal(second.net, "0.00");
    assert.equal(second.entries[0].debtOffset, "4500.00");
    await request(admin, "PUT", `/admin/payouts/${second.id}/settle`, {
      transfers: [],
    });
    assert.equal(
      (await Pay.findByPk(cash.payments[0].id)).cashCommissionOutstanding,
      "5500.00",
    );
  });
  test("payout hold window, open dispute hold and changed eligibility block both reservation and settlement", async () => {
    const s = await quote();
    await settleOnline(s);
    config.holdDays = 7;
    assert.equal(
      (await request(admin, "GET", "/admin/payouts/pending-items")).length,
      0,
    );
    await Ticket.update(
      { resolvedAt: new Date(Date.now() - 8 * 86400000) },
      { where: { id: s.ticket.id } },
    );
    const batch = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    await Ticket.update({ disputeHold: true }, { where: { id: s.ticket.id } });
    await request(
      admin,
      "PUT",
      `/admin/payouts/${batch.id}/settle`,
      {
        transfers: [
          {
            entryId: batch.entries[0].id,
            amount: batch.net,
            reference: "PAYOUT-HELD",
          },
        ],
      },
      409,
    );
    await request(admin, "POST", `/admin/payouts/${batch.id}/cancel`, {
      reason: "Chờ xử lý khiếu nại",
    });
    assert.equal(await Offset.count({ where: { status: "RESERVED" } }), 0);
  });
  test("parallel payout batches never reserve the same payment twice and cancelled batches release it", async () => {
    await settleOnline(await quote());
    const responses = await Promise.all(
      [1, 2].map(() =>
        fetch(base + "/api/v1/admin/payouts/create-batch", {
          method: "POST",
          headers: {
            Cookie: `road_as_token=${admin.token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
      ),
    );
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    const batch = await Batch.findOne();
    await request(admin, "POST", `/admin/payouts/${batch.id}/cancel`, {
      reason: "Tạo lại lô",
    });
    assert.equal(await Pay.count({ where: { payoutBatchId: batch.id } }), 0);
    assert.ok(
      (await request(admin, "POST", "/admin/payouts/create-batch", {}, 201)).id,
    );
  });
  test("cancelled paid work requires an actual refund record and cannot remain payable or enter payout", async () => {
    const s = await quote();
    const intent = await choose(s);
    await hook(payload(intent));
    await wait(
      async () => (await Pay.findByPk(intent.payments[0].id)).status === "HELD",
    );
    await act(rider, s.ticket, "cancel", { reason: "Không tiếp tục sửa" });
    const p = await Pay.findByPk(intent.payments[0].id);
    assert.equal(p.appliedAmount, "0.00");
    const refund = await Refund.findOne({ where: { paymentId: p.id } });
    assert.equal(refund.amount, "100000.00");
    assert.equal((await Bill.findByPk(s.bill.id)).dueAmount, "0.00");
    await request(admin, "POST", "/admin/payouts/create-batch", {}, 409);
    await request(
      admin,
      "POST",
      `/admin/finance/refunds/${refund.id}/complete`,
      { externalReference: "REFUND-CANCELLED-JOB" },
    );
    assert.equal((await Pay.findByPk(p.id)).status, "REFUNDED");
  });
  test("HMAC checks exact raw body and timestamp and cannot fall back to API key in HMAC mode", async () => {
    config.webhookAuth = "hmac";
    const s = await quote();
    const intent = await choose(s);
    const data = payload(intent);
    const raw = JSON.stringify(data);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature =
      "sha256=" +
      createHmac("sha256", config.webhookSecret)
        .update(timestamp + "." + raw)
        .digest("hex");
    await hook(data, 401, { Authorization: "Apikey " + config.webhookToken });
    await hook({ ...data, transferAmount: 1 }, 401, {
      "X-SePay-Timestamp": timestamp,
      "X-SePay-Signature": signature,
    });
    await hook(data, 200, {
      "X-SePay-Timestamp": timestamp,
      "X-SePay-Signature": signature,
    });
    await wait(
      async () => (await Pay.findByPk(intent.payments[0].id)).status === "HELD",
    );
  });
  test("expired partial deposits refund rather than unlock, and zero/decimal rail amounts are rejected", async () => {
    const s = await quote();
    const intent = await choose(s);
    await hook(payload(intent, 10000));
    await wait(
      async () =>
        (await Intent.findByPk(intent.id)).receivedAmount === "10000.00",
    );
    await Intent.update(
      { expiresAt: new Date(Date.now() - 1) },
      { where: { id: intent.id } },
    );
    await require("../src/services/finance_maintenance.service")();
    assert.equal((await Intent.findByPk(intent.id)).status, "EXPIRED");
    assert.equal(
      (await Refund.findOne({ where: { intentId: intent.id } })).amount,
      "10000.00",
    );
    await act(rider, s.ticket, "approve-quote", {}, 403);
    const fractional = await quote("100", other);
    await act(
      fractional.providerActor,
      fractional.ticket,
      "quote",
      { amount: "100.25" },
      400,
    );
    await hook(payload(intent, 0), 400);
  });
  test("financial events are append-only and settlement failures roll back debt, batch and receipts together", async () => {
    await settleCash(await quote());
    await settleOnline(await quote());
    const batch = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    const original = FinanceEvent.create;
    FinanceEvent.create = async () => {
      throw new Error("Audit offline");
    };
    try {
      await assert.rejects(
        () =>
          Payouts.settle(admin, batch.id, {
            transfers: [
              {
                entryId: batch.entries[0].id,
                amount: batch.net,
                reference: "PAYOUT-ROLLBACK",
              },
            ],
          }),
        /Audit offline/,
      );
    } finally {
      FinanceEvent.create = original;
    }
    assert.equal((await Batch.findByPk(batch.id)).status, "PENDING");
    const cash = await Pay.findOne({ where: { method: "CASH" } });
    assert.equal(cash.cashCommissionOutstanding, "10000.00");
    assert.equal(
      (await Entry.findByPk(batch.entries[0].id)).externalReference,
      null,
    );
    const event = await FinanceEvent.findOne();
    await assert.rejects(
      () => event.update({ action: "FORGED" }),
      /append-only/,
    );
  });
  test("VND commission rounds to whole dong so the exact payout can be transferred by bank", async () => {
    const intent = await settleOnline(await quote("5005"));
    const p = await Pay.findByPk(intent.payments[0].id);
    assert.equal(p.commissionAmount, "501.00");
    assert.equal(p.payoutAmount, "4504.00");
    const batch = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    assert.equal(batch.net, "4504.00");
  });
  test("multiple journey tickets share one bill and one QR allocates independently to each provider", async () => {
    const a = await quote("100000");
    const b = await quote("50000", rider, shop2, provider2);
    await Ticket.update(
      { journeyId: a.ticket.journeyId },
      { where: { id: b.ticket.id } },
    );
    const q = db.getQueryInterface().queryGenerator;
    await db.query(
      `DELETE FROM ${q.quoteTable(Item.getTableName())} WHERE bill_id = :bill`,
      { replacements: { bill: b.bill.id } },
    );
    await Bill.destroy({ where: { id: b.bill.id } });
    await Locks.journey(a.ticket.journeyId, null, (transaction) =>
      Bills.syncJourney(a.ticket.journeyId, transaction),
    );
    const detail = await request(rider, "GET", `/bills/${a.bill.id}`);
    assert.equal(detail.totalAmount, "150000.00");
    assert.equal(detail.paidAmount, "0.00");
    const intent = await request(
      rider,
      "POST",
      "/payments/create-sepay-qr",
      { billId: a.bill.id },
      201,
    );
    assert.equal(intent.amount, "150000.00");
    assert.equal(new Set(intent.payments.map((p) => p.providerId)).size, 2);
    await hook(payload(intent));
    await wait(
      async () => (await Bill.findByPk(a.bill.id)).paidAmount === "150000.00",
    );
    await act(rider, a.ticket, "approve-quote");
    await act(rider, b.ticket, "approve-quote");
  });

  test("admin can reconcile a verified wrong memo without mutating the original receipt or bypassing bank checks", async () => {
    const s = await quote();
    const intent = await choose(s);
    const data = payload(intent, 100000, { content: "Chuyen khoan quen ma" });
    await hook(data);
    const row = await wait(async () =>
      Receipt.findOne({ where: { status: "REVIEW" } }),
    );
    await request(
      other,
      "POST",
      `/admin/finance/sepay-receipts/${row.id}/reconcile`,
      { intentId: intent.id, reason: "Đã đối chiếu ngân hàng" },
      403,
    );
    await request(
      admin,
      "POST",
      `/admin/finance/sepay-receipts/${row.id}/reconcile`,
      { intentId: intent.id, reason: "Đã đối chiếu ngân hàng" },
    );
    await wait(
      async () => (await Pay.findByPk(intent.payments[0].id)).status === "HELD",
    );
    await row.reload();
    assert.equal(row.payload.content, "Chuyen khoan quen ma");
    assert.equal(row.resolvedCode, intent.code);
  });
  test("waiting-fee growth requires only a top-up and cash approval freezes the server-derived charge", async () => {
    const car = await Vehicle.create({
      userId: provider2.userId,
      type: "CAR",
      plateNumber: "30A12345",
      brand: "Toyota",
      modelName: "Tow car",
      length: 5,
      weightKg: 2200,
    });
    const tow = await Provider.create({
      userId: provider2.userId,
      kind: "TOW",
      name: "Finance tow",
      address: "Tow test address",
      phone: "0901234567",
      vehicleProfileId: car.id,
      plateNumber: car.plateNumber,
      licenseNumber: "LICENSE",
      status: "ACTIVE",
      requiresApproval: false,
      accepting: true,
      ...point,
      locationQuality: "GOOD",
      lastAccuracy: 5,
      lastTrustedLocationAt: new Date(),
      lastTrustedRecordedAt: new Date(),
      capabilities: ["TOWING"],
      supportedVehicleTypes: ["BIKE", "CAR"],
      towMaxWeightKg: 3500,
      towMaxWidth: 2.5,
      towMaxHeight: 3,
      towMaxLength: 6,
      towMethods: ["FLATBED"],
    });
    const bike = await Vehicle.create({
      userId: rider.userId,
      type: "BIKE",
      plateNumber: "WAIT-BIKE",
      brand: "Honda",
      modelName: "Wait",
      length: 2,
      weightKg: 150,
    });
    const ticket = await request(
      rider,
      "POST",
      "/dispatch/tow",
      {
        vehicleProfileId: bike.id,
        pickupLatitude: point.latitude,
        pickupLongitude: point.longitude,
        dropoffLatitude: 10.78,
        dropoffLongitude: 106.7,
      },
      201,
    );
    await act(provider2, ticket, "accept", { providerId: tow.id });
    await act(provider2, ticket, "arrive");
    await Ticket.update(
      { arrivedAt: new Date(Date.now() - 610000) },
      { where: { id: ticket.id } },
    );
    const bill = await Bill.findOne({ where: { journeyId: ticket.journeyId } });
    const first = await request(
      rider,
      "POST",
      "/payments/choose-cash",
      { billId: bill.id },
      201,
    );
    await Ticket.update(
      { arrivedAt: new Date(Date.now() - 670000) },
      { where: { id: ticket.id } },
    );
    await act(rider, ticket, "start", {}, 403);
    const extra = await request(
      rider,
      "POST",
      "/payments/choose-cash",
      { billId: bill.id },
      201,
    );
    assert.equal(extra.amount, "2000.00");
    const started = await act(rider, ticket, "start");
    assert.equal(started.waitingFee, "4000.00");
    assert.ok(started.waitingEndedAt);
    await tow.destroy();
  });
  test("failed SOS preserves only callout escrow and refunds travel/repair allocations without confirming void money", async () => {
    const rescue = await Vehicle.create({
      userId: provider.userId,
      type: "BIKE",
      plateNumber: "59A12345",
      brand: "Honda",
      modelName: "Mobile",
    });
    const mobile = await Provider.create({
      userId: provider.userId,
      kind: "MOBILE_SHOP",
      name: "Finance mobile",
      address: "Mobile test address",
      phone: "0901234567",
      vehicleProfileId: rescue.id,
      plateNumber: rescue.plateNumber,
      licenseNumber: "LICENSE",
      status: "ACTIVE",
      requiresApproval: false,
      accepting: true,
      latitude: 10.79,
      longitude: point.longitude,
      locationQuality: "GOOD",
      lastAccuracy: 5,
      lastTrustedLocationAt: new Date(),
      lastTrustedRecordedAt: new Date(),
      capabilities: ["TYRE_REPAIR"],
      supportedVehicleTypes: ["BIKE", "CAR"],
    });
    const bike = await Vehicle.create({
      userId: rider.userId,
      type: "BIKE",
      plateNumber: "FAIL-BIKE",
      brand: "Honda",
      modelName: "Failed",
      length: 2,
      weightKg: 150,
    });
    const ticket = await request(
      rider,
      "POST",
      "/dispatch/sos",
      {
        vehicleProfileId: bike.id,
        pickupLatitude: point.latitude,
        pickupLongitude: point.longitude,
      },
      201,
    );
    await act(provider, ticket, "accept", { providerId: mobile.id });
    await mobile.update({
      ...point,
      lastTrustedLocationAt: new Date(),
      lastTrustedRecordedAt: new Date(),
    });
    await act(provider, ticket, "arrive");
    await act(provider, ticket, "quote", { amount: "90000" });
    const bill = await Bill.findOne({ where: { journeyId: ticket.journeyId } });
    const intent = await choose({ actor: rider, bill });
    await hook(payload(intent));
    await wait(
      async () => (await Intent.findByPk(intent.id)).status === "HELD",
    );
    const proof = await models.S3Asset.create({
      userId: provider.userId,
      s3Key: `roadassist/${randomUUID()}.webp`,
      s3Url: "https://s3.test/proof.webp",
      s3Bucket: "picare-s3",
      s3Region: "ap-southeast-1",
      originalName: "proof.webp",
      mimeType: "image/webp",
      fileSize: 100,
    });
    await act(provider, ticket, "unfixable", {
      reason: "NO_PARTS",
      assetIds: [proof.id],
    });
    assert.equal((await Bill.findByPk(bill.id)).totalAmount, "30000.00");
    assert.equal((await Bill.findByPk(bill.id)).paidAmount, "30000.00");
    assert.equal(await Refund.count({ where: { status: "PENDING" } }), 2);
    await act(rider, ticket, "acknowledge-unfixable");
    const lines = await Pay.findAll({ where: { billId: bill.id } });
    assert.equal(lines.filter((p) => p.status === "CONFIRMED").length, 1);
    assert.equal(
      lines.find((p) => p.status === "CONFIRMED").appliedAmount,
      "30000.00",
    );
    await mobile.destroy();
  });
  test("a receipt durably received before expiry can finish processing after the expiry time", async () => {
    const s = await quote();
    const intent = await choose(s);
    const row = await Sepay.receive(payload(intent));
    await Intent.update(
      { expiresAt: new Date(+row.createdAt + 1) },
      { where: { id: intent.id } },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await Sepay.process(row.id);
    assert.equal((await Pay.findByPk(intent.payments[0].id)).status, "HELD");
  });
  test("one external bank reference cannot confirm both a payout and a refund, including case variations", async () => {
    await settleOnline(await quote());
    const batch = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    await request(admin, "PUT", `/admin/payouts/${batch.id}/settle`, {
      transfers: [
        {
          entryId: batch.entries[0].id,
          amount: batch.net,
          reference: "BANK-PROOF-UNIQUE",
        },
      ],
    });
    const s = await quote();
    const intent = await choose(s);
    await hook(payload(intent));
    await wait(
      async () => (await Pay.findByPk(intent.payments[0].id)).status === "HELD",
    );
    await act(rider, s.ticket, "cancel", { reason: "Hủy dịch vụ" });
    const refund = await Refund.findOne({
      where: { paymentId: intent.payments[0].id },
    });
    await request(
      admin,
      "POST",
      `/admin/finance/refunds/${refund.id}/complete`,
      { externalReference: "bank-proof-unique" },
      409,
    );
    assert.equal((await Refund.findByPk(refund.id)).status, "PENDING");
    assert.equal(
      (await Pay.findByPk(intent.payments[0].id)).refundedAmount,
      "0.00",
    );
  });
  test("unmatched verified money can be marked returned without remaining available for later intent reconciliation", async () => {
    const s = await quote();
    const intent = await choose(s);
    const data = payload(intent, 100000, { content: "Sai noi dung" });
    await hook(data);
    const receipt = await wait(async () =>
      Receipt.findOne({ where: { status: "REVIEW" } }),
    );
    const body = {
      externalReference: "REFUND-UNKNOWN-MEMO",
      reason: "Đã trả người gửi theo sao kê",
    };
    await request(
      admin,
      "POST",
      `/admin/finance/sepay-receipts/${receipt.id}/refund`,
      body,
    );
    await request(
      admin,
      "POST",
      `/admin/finance/sepay-receipts/${receipt.id}/refund`,
      body,
    );
    await request(
      admin,
      "POST",
      `/admin/finance/sepay-receipts/${receipt.id}/reconcile`,
      { intentId: intent.id, reason: "Không được cộng lại" },
      409,
    );
    await hook(data);
    assert.equal((await Receipt.findByPk(receipt.id)).status, "REFUNDED");
    assert.equal((await Pay.findByPk(intent.payments[0].id)).status, "PENDING");
  });
  test("cancelling an older cash batch cannot resurrect commission already offset by another settled batch", async () => {
    const cashScene = await quote();
    const cashIntent = await settleCash(cashScene);
    const cashBatch = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    await settleOnline(await quote());
    const onlineBatch = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    assert.equal(onlineBatch.net, "80000.00");
    await request(admin, "PUT", `/admin/payouts/${onlineBatch.id}/settle`, {
      transfers: [
        {
          entryId: onlineBatch.entries[0].id,
          amount: onlineBatch.net,
          reference: "CROSS-BATCH-OFFSET-1",
        },
      ],
    });
    assert.equal(
      (await Pay.findByPk(cashIntent.payments[0].id)).cashCommissionOutstanding,
      "0.00",
    );
    await request(admin, "POST", `/admin/payouts/${cashBatch.id}/cancel`, {
      reason: "Hủy lô ghi nhận tiền mặt cũ",
    });
    await request(rider, "GET", `/bills/${cashScene.bill.id}`);
    assert.equal(
      (await Pay.findByPk(cashIntent.payments[0].id)).cashCommissionOutstanding,
      "0.00",
    );
    const earnings = await request(
      provider,
      "GET",
      "/payments/provider-earnings",
    );
    assert.equal(earnings.cashCommissionDebt, "0.00");
    assert.equal(
      await Offset.count({
        where: { paymentId: cashIntent.payments[0].id, status: "SETTLED" },
      }),
      1,
    );
  });
}
