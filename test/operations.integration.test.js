const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
if (process.env.RUN_DB_TESTS !== "1")
  test(
    "Operational safeguards integration (RUN_DB_TESTS=1)",
    { skip: true },
    () => {},
  );
else {
  const suffix = randomUUID().replaceAll("-", "");
  Object.assign(process.env, {
    NODE_ENV: "test",
    PAYMENT_GATEWAY_MODE: "live",
    DB_SCHEMA: `ops_test_${suffix}`,
    AUTH_REDIS_PREFIX: `test:${suffix}:auth:`,
    PROVIDER_REDIS_PREFIX: `test:${suffix}:provider:`,
    JWT_SECRET: randomUUID() + randomUUID(),
    ALLOWED_CLIENT_URL_1: "http://localhost:5173",
    SEPAY_WEBHOOK_TOKEN: "operations-webhook-secret-at-least-32bytes",
    SEPAY_ACCOUNT_NUMBER: "0123456789",
    SEPAY_BANK_CODE: "MBBank",
    SEPAY_GATEWAY_NAME: "MBBank",
    CASH_DEBT_GRACE_HOURS: "24",
    CASH_MAX_UNPAID_COMPLETED_REQUESTS: "2",
  });
  require("./s3.fixture");
  const { app } = require("../index");
  const db = require("../src/config/postgres.config");
  const redis = require("../src/config/redis.config");
  const { Op } = require("sequelize");
  const M = require("../src/models");
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
    ShopIntakeReservation: Reservation,
    DispatchSupportCase: Case,
    ChatRoom,
    DispatchEvent: Event,
  } = M;
  const Liveness = require("../src/services/dispatch_liveness.service");
  const Availability = require("../src/services/provider_availability.service");
  const Intake = require("../src/services/shop_intake.service");
  const Cash = require("../src/services/cash_eligibility.service");
  const Sepay = require("../src/services/sepay.service");
  const config = require("../src/config/app.config");
  const point = { latitude: 10.77, longitude: 106.69 },
    elsewhere = { latitude: 10.79, longitude: 106.69 },
    destination2 = { latitude: 10.78, longitude: 106.7 };
  let server,
    base,
    rider,
    other,
    shopper,
    shopper2,
    tower,
    tower2,
    mobber,
    mobber2,
    admin,
    shop,
    shop2,
    tow,
    tow2,
    mobile,
    mobile2,
    counter = 0,
    receiptNo = 2000;
  const gps = (p = point) => ({
    ...p,
    accuracy: 5,
    recordedAt: new Date().toISOString(),
  });
  async function account(n) {
    const user = await User.create({
      name: `Ops ${n}`,
      email: `ops-${n}@example.com`,
      phone: `09080000${String(n).padStart(2, "0")}`,
      password: "Operations-strong-password!",
      emailVerifiedAt: new Date(),
      role: n === 9 ? "admin" : "guest",
    });
    const session = await require("../src/services/auth.service").completeLogin(
      { userId: user.userId, ipAddress: "127.0.0.1" },
    );
    return { userId: user.userId, token: session.token };
  }
  async function vehicle(actor = rider, type = "BIKE") {
    const row = await Vehicle.create({
      userId: actor.userId,
      type,
      plateNumber: `OPS-${++counter}`,
      brand: "Fixture",
      modelName: "Ops vehicle",
      length: type === "BIKE" ? 2 : 5,
      weightKg: type === "BIKE" ? 150 : 2000,
    });
    await Ride.create({
      vehicleProfileId: row.id,
      mode: "SOLO",
      width: row.baseWidth,
      height: row.baseHeight,
    });
    return row;
  }
  async function provider(actor, kind, p = point) {
    const car =
      kind === "SHOP"
        ? null
        : await vehicle(actor, kind === "TOW" ? "CAR" : "BIKE");
    return Provider.create({
      userId: actor.userId,
      name: `Ops ${kind}`,
      phone: "0901234567",
      address: "Ops location",
      kind,
      ...p,
      status: "ACTIVE",
      accepting: true,
      requiresApproval: false,
      maxConcurrentJobs: 1,
      capabilities:
        kind === "TOW" ? ["TOWING"] : ["TYRE_REPAIR", "ENGINE_REPAIR"],
      supportedVehicleTypes: ["BIKE", "CAR"],
      serviceSegments: ["SOLO_BIKE", "CAR"],
      ...(car && {
        vehicleProfileId: car.id,
        plateNumber: car.plateNumber,
        licenseNumber: "LICENSE",
      }),
      ...(kind === "TOW" && {
        towMaxWeightKg: 3500,
        towMaxWidth: 2.5,
        towMaxHeight: 3,
        towMaxLength: 6,
        towMethods: ["FLATBED"],
      }),
      locationQuality: "GOOD",
      lastAccuracy: 5,
      lastTrustedLocationAt: new Date(),
      lastTrustedRecordedAt: new Date(),
    });
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
    const cookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith("road_as_token="));
    if (actor && cookie)
      actor.token = cookie.split(";")[0].slice("road_as_token=".length);
    const json = await response.json();
    assert.equal(response.status, status, JSON.stringify(json));
    return json.data === undefined ? json : json.data;
  }
  async function receiveCash(ticket) {
    const items = await Item.findAll({where:{ticketId:ticket.id}});
    const payments = await Pay.findAll({where:{billItemId:{[Op.in]:items.map(i=>i.id)},method:'CASH',status:'PENDING'}});
    for (const payment of payments) await require('../src/services/payment.service').confirmCash({userId:payment.providerUserId},payment.id);
  }
  const act = async (actor, ticket, action, body = {}, status = 200) => {
    if (["start", "resolve"].includes(action))
      await require("./handover.fixture")(
        ticket.id,
        action === "start" ? "PICKUP" : "DELIVERY",
      );
    if (action === 'resolve' && status === 200) await receiveCash(ticket);
    return request(
      actor,
      "POST",
      `/dispatch/${ticket.id}/${action}`,
      body,
      status,
    );
  };
  async function move(p, value = point) {
    await p.update({
      ...value,
      locationQuality: "GOOD",
      lastAccuracy: 5,
      lastTrustedLocationAt: new Date(),
      lastTrustedRecordedAt: new Date(),
    });
  }
  async function sos(actor = rider) {
    const v = await vehicle(actor);
    return request(
      actor,
      "POST",
      "/dispatch/sos",
      {
        vehicleProfileId: v.id,
        pickupLatitude: point.latitude,
        pickupLongitude: point.longitude,
      },
      201,
    );
  }
  async function towScene(actor = rider, dropoffShop = shop) {
    const v = await vehicle(actor);
    return request(
      actor,
      "POST",
      "/dispatch/tow",
      {
        vehicleProfileId: v.id,
        pickupLatitude: point.latitude,
        pickupLongitude: point.longitude,
        ...(dropoffShop
          ? { dropoffShopId: dropoffShop.id }
          : {
              dropoffLatitude: destination2.latitude,
              dropoffLongitude: destination2.longitude,
            }),
      },
      201,
    );
  }
  async function match(t, p = tow, actor = tower) {
    // Public dispatch scenarios start after the selected partner declines first refusal.
    const held=await Ticket.findByPk(t.id);
    if (held.offeredProviderId && held.offeredProviderId!==p.id && !held.offerPublicAt) {
      const selected=await Provider.findByPk(held.offeredProviderId);
      await require('../src/services/dispatch_offer.service').release({userId:selected.userId},t.id);
    }
    return act(actor, t, "accept", { providerId: p.id });
  }
  async function book(t, actor = shopper) {
    return act(actor, t, "intake/accept", {
      reservationId: (await Ticket.findByPk(t.id)).intakeReservationId,
    });
  }
  async function cashFor(t, actor = rider) {
    const bill = await Bill.findOne({ where: { journeyId: t.journeyId } });
    const intent = await request(
      actor,
      "POST",
      "/payments/choose-cash",
      { billId: bill.id },
      201,
    );
    return { bill, intent };
  }
  async function start(t, actor = rider, pActor = tower) {
    await act(pActor, t, "arrive");
    const funding = await cashFor(t, actor);
    const started = await act(actor, t, "start");
    return { ...funding, started };
  }
  async function cashDebt(actor = rider) {
    const v = await vehicle(actor);
    const t = await request(
      actor,
      "POST",
      "/dispatch/walk-in",
      { vehicleProfileId: v.id, providerId: shop.id, location: gps() },
      201,
    );
    await match(t, shop, shopper);
    await act(shopper, t, "quote", { amount: "100000" });
    const funding = await cashFor(t, actor);
    await act(actor, t, "approve-quote");
    await act(shopper, t, "ready");
    // Persisted unpaid completions from the previous contract remain collectible.
    await Ticket.update({status:'4', resolvedAt:new Date()}, {where:{id:t.id}});
    await require('../src/services/finance_lock.service').journey(t.journeyId,null,transaction => require('../src/services/bill.service').syncJourney(t.journeyId,transaction));
    return { ticket: t, ...funding };
  }
  async function newQuoted(actor = rider) {
    const v = await vehicle(actor);
    const t = await request(
      actor,
      "POST",
      "/dispatch/walk-in",
      { vehicleProfileId: v.id, providerId: shop.id, location: gps() },
      201,
    );
    await match(t, shop, shopper);
    await act(shopper, t, "quote", { amount: "50000" });
    return {
      ticket: t,
      bill: await Bill.findOne({ where: { journeyId: t.journeyId } }),
    };
  }
  async function payOnline(intent) {
    await request(
      null,
      "POST",
      "/payments/sepay/webhook",
      {
        id: ++receiptNo,
        gateway: "MBBank",
        accountNumber: "0123456789",
        content: intent.code,
        transferType: "in",
        transferAmount: Number(intent.amount),
        referenceCode: `OPS-REF-${receiptNo}`,
      },
      200,
      { Authorization: `Apikey ${config.sepay.webhookToken}` },
    );
    await Sepay.processInbox();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (
        (await Intent.findByPk(intent.id)).status === "HELD" ||
        (await Intent.findByPk(intent.id)).status === "CONFIRMED"
      )
        return;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail("Payment did not process");
  }
  before(async () => {
    await db.authenticate();
    await db.createSchema(process.env.DB_SCHEMA);
    await db.sync();
    await redis.connect();
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    [rider, other, shopper, shopper2, tower, tower2, mobber, mobber2, admin] =
      await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9].map(account));
    shop = await provider(shopper, "SHOP");
    shop2 = await provider(shopper2, "SHOP", destination2);
    tow = await provider(tower, "TOW");
    tow2 = await provider(tower2, "TOW");
    mobile = await provider(mobber, "MOBILE_SHOP", elsewhere);
    mobile2 = await provider(mobber2, "MOBILE_SHOP");
  });
  afterEach(async () => {
    await Sepay.processInbox();
    config.sepay.holdDays = 7;
    const names = [
      "Handover",
      "Dispute",
      "DisputeEvent",
      "ProviderRecovery",
      "RecoveryOffset",
      "ShopIntakeReservation",
      "DispatchSupportCase",
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
    for (const p of [shop, shop2, tow, tow2, mobile, mobile2]) {
      await p.reload();
      await p.update({
        status: "ACTIVE",
        suspended: false,
        accepting: true,
        maxConcurrentJobs: 1,
      });
      await move(
        p,
        p.id === shop2.id
          ? destination2
          : p.id === mobile.id
            ? elsewhere
            : point,
      );
    }
  });
  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
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
  test("overdue cash blocks new cash promises but permits online rescue and requires actual debt payment to clear", async () => {
    const old = await cashDebt();
    await Ticket.update(
      { resolvedAt: new Date(Date.now() - 25 * 3600000) },
      { where: { id: old.ticket.id } },
    );
    const fresh = await newQuoted();
    const eligibility = await request(
      rider,
      "GET",
      "/payments/cash-eligibility",
    );
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.overdueAmount, "100000.00");
    assert.equal(eligibility.onlineAllowed, true);
    await request(
      rider,
      "POST",
      "/payments/choose-cash",
      { billId: fresh.bill.id },
      409,
    );
    const newQr = await request(
      rider,
      "POST",
      "/payments/create-sepay-qr",
      { billId: fresh.bill.id },
      201,
    );
    await request(rider, "POST", `/payments/${newQr.id}/cancel`, {});
    const key = randomUUID();
    const conversion = await request(
      rider,
      "POST",
      "/payments/switch-cash-to-sepay",
      { billId: old.bill.id, clientRequestId: key },
      201,
    );
    assert.equal(
      (
        await request(
          rider,
          "POST",
          "/payments/switch-cash-to-sepay",
          { billId: old.bill.id, clientRequestId: key },
          201,
        )
      ).id,
      conversion.id,
    );
    assert.equal(
      (await request(rider, "GET", "/payments/cash-eligibility")).eligible,
      false,
    );
    await request(
      rider,
      "POST",
      "/payments/choose-cash",
      { billId: fresh.bill.id },
      409,
    );
    await payOnline(conversion);
    assert.equal(
      (await request(rider, "GET", "/payments/cash-eligibility")).eligible,
      true,
    );
    await request(
      rider,
      "POST",
      "/payments/choose-cash",
      { billId: fresh.bill.id },
      201,
    );
  });
  test("two recently completed unpaid cash requests hit the cap even before the grace deadline", async () => {
    await cashDebt();
    await cashDebt();
    const result = await Cash.describe(rider.userId);
    assert.equal(result.unpaidCompletedRequests, 2);
    assert.equal(result.overdueAmount, "0.00");
    assert.equal(result.eligible, false);
    const fresh = await newQuoted();
    await request(
      rider,
      "POST",
      "/payments/choose-cash",
      { billId: fresh.bill.id },
      409,
    );
    assert.equal(
      (await request(other, "GET", "/payments/cash-eligibility")).eligible,
      true,
    );
  });
  test("cash conversion failure is atomic and legacy cash obligations backfill without disappearing", async () => {
    const old = await cashDebt();
    await Ticket.update(
      { resolvedAt: new Date(Date.now() - 25 * 3600000) },
      { where: { id: old.ticket.id } },
    );
    const account = config.sepay.accountNumber;
    config.sepay.accountNumber = "";
    try {
      await request(
        rider,
        "POST",
        "/payments/switch-cash-to-sepay",
        { billId: old.bill.id },
        503,
      );
    } finally {
      config.sepay.accountNumber = account;
    }
    assert.equal((await Intent.findByPk(old.intent.id)).status, "PENDING");
    await request(
      other,
      "POST",
      "/payments/switch-cash-to-sepay",
      { billId: old.bill.id },
      404,
    );
    await Item.update(
      { cashCommittedAt: null },
      { where: { billId: old.bill.id } },
    );
    await require("../src/config/operations.migrations")(db);
    assert.equal((await Cash.describe(rider.userId)).eligible, false);
  });
  test("unassigned requests expire, disappear from feeds and release the vehicle only after an audited transition", async () => {
    const t = await sos();
    await Ticket.update(
      { queueExpiresAt: new Date(Date.now() - 1000) },
      { where: { id: t.id } },
    );
    await act(mobber, t, "accept", { providerId: mobile.id }, 409);
    const feed = await request(
      mobber,
      "GET",
      `/dispatch/provider-feed?providerId=${mobile.id}`,
    );
    assert.ok(!feed.some((r) => r.id === t.id));
    await Liveness.run();
    const ended = await Ticket.findByPk(t.id);
    assert.equal(ended.status, "5");
    assert.equal(ended.cancelReason, "NO_PROVIDER_TIMEOUT");
    assert.equal(
      (await Bill.findOne({ where: { journeyId: t.journeyId } })).status,
      "VOID",
    );
    await request(
      rider,
      "POST",
      "/dispatch/sos",
      {
        vehicleProfileId: t.vehicleProfileId,
        pickupLatitude: point.latitude,
        pickupLongitude: point.longitude,
      },
      201,
    );
  });
  test("stalled requests can rematch once due, exclude the old owner, refund old allocations and rotate chat", async () => {
    const t = await sos();
    await match(t, mobile, mobber);
    const funding = await cashFor(t);
    const previous = await Ticket.findByPk(t.id);
    await Ticket.update(
      {
        acceptedAt: new Date(Date.now() - 12 * 60000),
        lastProgressAt: new Date(Date.now() - 11 * 60000),
      },
      { where: { id: t.id } },
    );
    await act(other, t, "request-rematch", { reason: "NO_PROGRESS" }, 404);
    await Liveness.run();
    assert.ok((await Ticket.findByPk(t.id)).noShowDetectedAt);
    const rematched = await act(rider, t, "request-rematch", {
      reason: "NO_PROGRESS",
    });
    assert.equal(rematched.status, "1");
    assert.equal(rematched.providerId, null);
    assert.equal(rematched.rematchCount, 1);
    assert.ok(rematched.chatVersion > previous.chatVersion);
    assert.equal(
      (await Intent.findByPk(funding.intent.id)).status,
      "CANCELLED",
    );
    await match(t, mobile, mobber)
      .then(() => assert.fail("Excluded owner"))
      .catch((e) => assert.match(e.message, /409/));
    await match(t, mobile2, mobber2);
  });
  test("GPS progress requires meaningful approach, while stationary heartbeats do not postpone no-show checks", async () => {
    const t = await sos();
    await match(t, mobile, mobber);
    await Ticket.update(
      {
        acceptedAt: new Date(Date.now() - 12 * 60000),
        lastProgressAt: new Date(Date.now() - 11 * 60000),
      },
      { where: { id: t.id } },
    );
    await mobile.update({
      lastTrustedRecordedAt: new Date(Date.now() - 60000),
    });
    await request(mobber, "POST", "/providers/location", {
      providerId: mobile.id,
      latitude: 10.788,
      longitude: point.longitude,
      accuracy: 5,
      recordedAt: new Date().toISOString(),
    });
    let current = await Ticket.findByPk(t.id);
    assert.ok(Date.now() - current.lastProgressAt < 3000);
    await act(rider, t, "request-rematch", { reason: "NO_PROGRESS" }, 409);
    const stalled = new Date(Date.now() - 11 * 60000);
    await Ticket.update({ lastProgressAt: stalled }, { where: { id: t.id } });
    await request(mobber, "POST", "/providers/location", {
      providerId: mobile.id,
      latitude: 10.788,
      longitude: point.longitude,
      accuracy: 5,
      recordedAt: new Date(Date.now() + 10).toISOString(),
    });
    current = await Ticket.findByPk(t.id);
    assert.equal(+current.lastProgressAt, +stalled);
    await act(rider, t, "request-rematch", { reason: "NO_PROGRESS" });
  });
  test("providers already near pickup cannot be falsely replaced, and rematch limits lead to support", async () => {
    const near = await sos();
    await match(near, mobile2, mobber2);
    await Ticket.update(
      {
        acceptedAt: new Date(Date.now() - 40 * 60000),
        lastProgressAt: new Date(Date.now() - 40 * 60000),
        arrivalDueAt: new Date(Date.now() - 60000),
      },
      { where: { id: near.id } },
    );
    await act(rider, near, "request-rematch", { reason: "MISSED_ETA" }, 409);
    await act(rider, near, "arrive");
    const far = await sos();
    await match(far, mobile, mobber);
    await Ticket.update(
      { rematchCount: 3, lastProgressAt: new Date(Date.now() - 11 * 60000) },
      { where: { id: far.id } },
    );
    await act(rider, far, "request-rematch", { reason: "NO_PROGRESS" }, 409);
    const support = await act(rider, far, "request-assistance", {
      reason: "NO_PROGRESS",
    });
    const again = await act(rider, far, "request-assistance", {
      reason: "NO_PROGRESS",
    });
    assert.equal(support.id, again.id);
    await request(
      other,
      "GET",
      `/admin/dispatch/support-cases/${support.id}`,
      undefined,
      403,
    );
    assert.ok(
      (
        await request(
          admin,
          "GET",
          `/admin/dispatch/support-cases/${support.id}`,
        )
      ).rider.phone,
    );
    await request(
      admin,
      "POST",
      `/admin/dispatch/support-cases/${support.id}/resolve`,
      { resolution: "Đã liên hệ các bên" },
    );
    assert.equal((await Ticket.findByPk(far.id)).status, "2");
  });
  test("lost GPS during transport opens one support case without cancelling, releasing capacity or changing money", async () => {
    const t = await towScene(rider, null);
    await match(t);
    const { started } = await start(t);
    await tow.update({
      lastTrustedLocationAt: new Date(Date.now() - 11 * 60000),
      lastTrustedRecordedAt: new Date(Date.now() - 11 * 60000),
    });
    await Liveness.run();
    await Liveness.run();
    const current = await Ticket.findByPk(t.id);
    assert.equal(current.status, "6");
    assert.equal(current.totalAmount, started.totalAmount);
    assert.equal(await Availability.activeJobs(tow), 1);
    assert.equal(
      await Case.count({ where: { ticketId: t.id, status: "OPEN" } }),
      1,
    );
    await act(rider, t, "request-rematch", { reason: "NO_PROGRESS" }, 409);
    await act(
      rider,
      t,
      "cancel",
      { reason: "Không được tự nhả xe đang chở" },
      409,
    );
  });
  test("departure requires explicit shop acceptance and the reservation participates in live capacity/search", async () => {
    const t = await towScene();
    await match(t);
    await act(tower, t, "arrive");
    await cashFor(t);
    await act(rider, t, "start", {}, 409);
    await act(
      other,
      t,
      "intake/accept",
      { reservationId: t.intakeReservationId },
      404,
    );
    await book(t);
    assert.equal(await Availability.activeJobs(shop), 1);
    const v = await vehicle(other);
    await request(
      other,
      "POST",
      "/dispatch/walk-in",
      { vehicleProfileId: v.id, providerId: shop.id, location: gps() },
      409,
    );
    const search = await request(null, "POST", "/providers/search", {
      ...point,
      kinds: ["SHOP"],
      availableOnly: true,
    });
    assert.ok(!search.some((p) => p.id === shop.id));
    await request(shopper, "POST", `/providers/${shop.id}/revoke`, {}, 409);
    await act(rider, t, "start");
    assert.equal(
      (await Reservation.findByPk(t.intakeReservationId)).status,
      "IN_TRANSIT",
    );
  });
  test("two concurrent acceptance promises cannot overbook a one-bay shop", async () => {
    const a = await towScene();
    const b = await towScene(other);
    const results = await Promise.all(
      [a, b].map((t) =>
        fetch(base + `/api/v1/dispatch/${t.id}/intake/accept`, {
          method: "POST",
          headers: {
            Cookie: `road_as_token=${shopper.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ reservationId: t.intakeReservationId }),
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await Availability.activeJobs(shop), 1);
  });
  test("expired reply/hold cannot be reused, and a new request version invalidates stale confirmations", async () => {
    const t = await towScene();
    await Reservation.update(
      { requestExpiresAt: new Date(Date.now() - 1) },
      { where: { id: t.intakeReservationId } },
    );
    await book(t)
      .then(() => assert.fail("Expired request"))
      .catch((e) => assert.match(e.message, /409/));
    await Liveness.run();
    const renewed = await act(rider, t, "intake/request");
    assert.notEqual(renewed.id, t.intakeReservationId);
    await act(
      shopper,
      t,
      "intake/accept",
      { reservationId: t.intakeReservationId },
      409,
    );
    await act(shopper, t, "intake/accept", { reservationId: renewed.id });
    await Reservation.update(
      { holdUntil: new Date(Date.now() - 1) },
      { where: { id: renewed.id } },
    );
    assert.equal(await Availability.activeJobs(shop), 0);
    await match(t);
    await act(tower, t, "arrive");
    await cashFor(t);
    await act(rider, t, "start", {}, 409);
    assert.equal((await Ticket.findByPk(t.id)).status, "3");
  });
  test("transport/delivery holds do not expire and consumed intake uses exactly one bay even off duty", async () => {
    const t = await towScene();
    await book(t);
    await match(t);
    await start(t);
    await Reservation.update(
      { holdUntil: new Date(Date.now() - 1000) },
      { where: { id: t.intakeReservationId } },
    );
    await act(
      shopper,
      t,
      "intake/decline",
      { reservationId: t.intakeReservationId, reason: "Không thể bỏ cam kết" },
      409,
    );
    await Liveness.run();
    assert.equal(
      (await Reservation.findByPk(t.intakeReservationId)).status,
      "IN_TRANSIT",
    );
    await act(rider, t, "resolve");
    const parent = await Ticket.findByPk(t.id);
    const child = await Ticket.findByPk(parent.childTicketId);
    assert.equal(
      (await Reservation.findByPk(t.intakeReservationId)).status,
      "DELIVERED",
    );
    assert.equal(await Availability.activeJobs(shop), 1);
    await act(
      shopper,
      child,
      "decline",
      { reason: "Không được bỏ xe đã giao" },
      409,
    );
    await shop.update({ accepting: false });
    await match(child, shop, shopper);
    assert.equal(
      (await Reservation.findByPk(t.intakeReservationId)).status,
      "CONSUMED",
    );
    assert.equal(await Availability.activeJobs(shop), 1);
    await act(
      shopper,
      child,
      "cancel",
      { reason: "Cũng không được hủy cam kết" },
      409,
    );
  });
  test("a delivered vehicle awaiting intake escalates instead of silently expiring and releasing the vehicle", async () => {
    const t = await towScene();
    await book(t);
    await match(t);
    await start(t);
    await act(rider, t, "resolve");
    const parent = await Ticket.findByPk(t.id);
    const child = await Ticket.findByPk(parent.childTicketId);
    await Ticket.update(
      { queueExpiresAt: new Date(Date.now() - 1) },
      { where: { id: child.id } },
    );
    await Liveness.run();
    assert.equal((await Ticket.findByPk(child.id)).status, "1");
    assert.equal(
      (await Reservation.findByPk(t.intakeReservationId)).status,
      "DELIVERED",
    );
    assert.equal(
      await Case.count({
        where: { ticketId: child.id, reason: "INTAKE_TIMEOUT", status: "OPEN" },
      }),
      1,
    );
    await request(
      rider,
      "POST",
      "/dispatch/sos",
      {
        vehicleProfileId: child.vehicleProfileId,
        pickupLatitude: point.latitude,
        pickupLongitude: point.longitude,
      },
      409,
    );
  });
  test("an in-transit destination change requires support, staff proposal, new-shop capacity and rider consent", async () => {
    const t = await towScene();
    await book(t);
    await match(t);
    const { started } = await start(t);
    await request(
      admin,
      "POST",
      `/admin/dispatch/${t.id}/propose-destination`,
      { dropoffShopId: shop2.id, reason: "Đổi tiệm an toàn" },
      409,
    );
    await act(shopper, t, "request-assistance", {
      reason: "DESTINATION_UNAVAILABLE",
      note: "Sự cố tại tiệm đích",
    });
    await request(
      other,
      "POST",
      `/admin/dispatch/${t.id}/propose-destination`,
      { dropoffShopId: shop2.id, reason: "Không có quyền" },
      403,
    );
    const proposal = await request(
      admin,
      "POST",
      `/admin/dispatch/${t.id}/propose-destination`,
      { dropoffShopId: shop2.id, reason: "Đã phối hợp các bên" },
    );
    await act(
      rider,
      t,
      "confirm-destination",
      { reservationId: proposal.id },
      409,
    );
    const preview = await request(shopper2, "GET", `/dispatch/${t.id}`);
    assert.equal(preview.intakes.length, 1);
    assert.equal(preview.intakes[0].id, proposal.id);
    assert.equal(preview.intakes[0].isCandidate, true);
    const staff = await request(admin, "GET", `/admin/dispatch/tickets/${t.id}`);
    assert.equal(staff.intakes.length, 2);
    assert.equal(staff.intakes.filter(row => row.isCandidate).length, 1);
    assert.ok(staff.supportCases.some(row => row.status === "OPEN"));

    assert.equal(preview.providerLocation, undefined);
    await act(shopper2, t, "intake/accept", { reservationId: proposal.id });
    assert.equal(await Availability.activeJobs(shop), 1);
    assert.equal(await Availability.activeJobs(shop2), 1);
    await act(
      other,
      t,
      "confirm-destination",
      { reservationId: proposal.id },
      404,
    );
    const moved = await act(rider, t, "confirm-destination", {
      reservationId: proposal.id,
    });
    assert.equal(moved.dropoffShopId, shop2.id);
    assert.equal(moved.totalAmount, started.totalAmount);
    assert.equal(moved.waitingFee, started.waitingFee);
    assert.equal(await Availability.activeJobs(shop), 0);
    await request(shopper, "GET", `/dispatch/${t.id}`, undefined, 404);
    await act(rider, t, "resolve", {}, 409);
    await move(tow, destination2);
    await act(rider, t, "resolve");
    const delivered = await Ticket.findByPk(t.id);
    assert.equal(
      (await Ticket.findByPk(delivered.childTicketId)).targetProviderId,
      shop2.id,
    );
  });
  test("rejecting an alternative releases only the proposed slot and keeps the original transport commitment", async () => {
    const t = await towScene();
    await book(t);
    await match(t);
    await start(t);
    await act(rider, t, "request-assistance", {
      reason: "DESTINATION_UNAVAILABLE",
    });
    const proposal = await request(
      admin,
      "POST",
      `/admin/dispatch/${t.id}/propose-destination`,
      { dropoffShopId: shop2.id, reason: "Đề nghị phương án dự phòng" },
    );
    await act(shopper2, t, "intake/accept", { reservationId: proposal.id });
    await act(rider, t, "reject-destination", { reservationId: proposal.id });
    assert.equal((await Ticket.findByPk(t.id)).dropoffShopId, shop.id);
    assert.equal(
      (await Reservation.findByPk(t.intakeReservationId)).status,
      "IN_TRANSIT",
    );
    assert.equal((await Reservation.findByPk(proposal.id)).status, "RELEASED");
    assert.equal(await Availability.activeJobs(shop2), 0);
  });
  test("legacy delivered vehicles recover their committed bay and cannot be abandoned", async () => {
    const t = await towScene();
    await book(t);
    await match(t);
    await start(t);
    await act(rider, t, "resolve");
    const parent = await Ticket.findByPk(t.id);
    const child = await Ticket.findByPk(parent.childTicketId);
    await Reservation.destroy({ where: { ticketId: t.id } });
    await parent.update({ intakeReservationId: null, intakeVersion: 0 });
    await Liveness.run();
    await Liveness.run();
    const restored = await Reservation.findOne({
      where: { childTicketId: child.id },
    });
    assert.equal(restored.status, "DELIVERED");
    assert.equal(restored.reason, "LEGACY_DELIVERY_AWAITING_INTAKE");
    assert.equal(restored.acceptedAt, null);
    assert.equal(await Availability.activeJobs(shop), 1);
    await act(
      shopper,
      child,
      "decline",
      { reason: "Không bỏ xe đang giữ" },
      409,
    );
  });
  test("worker scans past 200 unchanged requests to process later expired requests", async () => {
    const t = await sos();
    const template = (await Ticket.findByPk(t.id)).toJSON();
    await Ticket.destroy({ where: { id: t.id } });
    const rows = Array.from({ length: 201 }, (_, i) => ({
      ...template,
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      code: `SCAN${i}`,
      journeyId: randomUUID(),
      vehicleProfileId: randomUUID(),
      queueExpiresAt: new Date(Date.now() + (i === 200 ? -60000 : 3600000)),
    }));
    await Ticket.bulkCreate(rows);
    await Liveness.run();
    assert.equal((await Ticket.findByPk(rows[200].id)).status, "5");
    assert.equal((await Ticket.findByPk(rows[0].id)).status, "1");
  });
  test("audit failure rolls back slot acceptance and legacy transport backfill is safe and idempotent", async () => {
    const t = await towScene();
    const original = Event.create;
    Event.create = async () => {
      throw new Error("Audit failed");
    };
    try {
      await assert.rejects(
        () =>
          Intake.decide(shopper, t.id, "accept", {
            reservationId: t.intakeReservationId,
          }),
        /Audit failed/,
      );
    } finally {
      Event.create = original;
    }
    assert.equal(
      (await Reservation.findByPk(t.intakeReservationId)).status,
      "REQUESTED",
    );
    assert.equal(await Availability.activeJobs(shop), 0);
    await book(t);
    await match(t);
    await start(t);
    await Reservation.destroy({ where: { ticketId: t.id } });
    await Ticket.update(
      { intakeReservationId: null, intakeVersion: 0 },
      { where: { id: t.id } },
    );
    assert.equal(await Liveness.backfillIntakes(), 1);
    assert.equal(await Liveness.backfillIntakes(), 0);
    const legacy = await Reservation.findOne({ where: { ticketId: t.id } });
    assert.equal(legacy.status, "IN_TRANSIT");
    assert.equal(legacy.acceptedAt, null);
    assert.equal(legacy.reason, "LEGACY_TRANSPORT_IN_PROGRESS");
  });
  async function evidenceAssets(actor = rider, count = 2) {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const key = randomUUID();
      const row = await M.S3Asset.create({
        userId: actor.userId,
        s3Key: `roadassist/${key}.jpg`,
        s3Url: `https://s3.test/roadassist/${key}.jpg`,
        s3Bucket: "picare-s3",
        s3Region: "ap-southeast-1",
        originalName: "vehicle.jpg",
        mimeType: "image/jpeg",
        fileSize: 100,
      });
      ids.push(row.id);
    }
    return ids;
  }
  async function proposeProof(t, phase = "PICKUP", actor = tower, extra = {}) {
    return request(
      actor,
      "POST",
      `/dispatch/${t.id}/handovers`,
      {
        phase,
        condition: "Đã kiểm tra ngoại thất và đồ đi kèm",
        damages: [
          {
            part: "Cản trước",
            description: "Vết xước có sẵn trước khi nhận xe",
          },
        ],
        assetIds: await evidenceAssets(actor),
        ...extra,
      },
      201,
    );
  }
  const confirmProof = (actor, t, h, status = 200) =>
    request(
      actor,
      "POST",
      `/dispatch/${t.id}/handovers/confirm`,
      { handoverId: h.id },
      status,
    );
  async function disputeFor(t, actor = rider, extra = {}) {
    return request(
      actor,
      "POST",
      "/disputes",
      {
        ticketId: t.id,
        reason: "VEHICLE_DAMAGE",
        note: "Cần xem xét trách nhiệm và bằng chứng tình trạng xe",
        ...extra,
      },
      201,
    );
  }
  const replyCase = (d, actor = shopper) =>
    request(actor, "POST", `/disputes/${d.id}/evidence`, {
      note: "Tôi đã xem hồ sơ và gửi phản hồi để admin xem xét",
    });
  const ruleCase = (d, data, status = 200) =>
    request(
      admin,
      "PUT",
      `/admin/disputes/${d.id}/resolve`,
      { note: "Đã đối chiếu bằng chứng và phản hồi của hai bên", ...data },
      status,
    );
  async function onlineCompleted() {
    const s = await cashDebt();
    const qr = await request(
      rider,
      "POST",
      "/payments/switch-cash-to-sepay",
      { billId: s.bill.id },
      201,
    );
    await payOnline(qr);
    return s;
  }
  test("pickup requires photographs, recorded existing damage and independent confirmation before departure", async () => {
    const t = await towScene(rider, null);
    await match(t);
    await act(tower, t, "arrive");
    await cashFor(t);
    await request(rider, "POST", `/dispatch/${t.id}/start`, {}, 409);
    await request(
      tower,
      "POST",
      `/dispatch/${t.id}/handovers`,
      {
        phase: "PICKUP",
        condition: "Ảnh chưa đầy đủ",
        damages: [],
        assetIds: await evidenceAssets(tower, 1),
      },
      400,
    );
    const h = await proposeProof(t);
    assert.equal(h.damages[0].part, "Cản trước");
    assert.equal(h.images.length, 2);
    await confirmProof(tower, t, h, 404);
    await confirmProof(other, t, h, 404);
    await request(rider, "POST", `/dispatch/${t.id}/start`, {}, 409);
    await confirmProof(rider, t, h);
    await confirmProof(rider, t, h);
    await request(rider, "POST", `/dispatch/${t.id}/start`, {});
    assert.equal(
      (await request(rider, "GET", `/dispatch/${t.id}/handovers`))[0].status,
      "CONFIRMED",
    );
    await request(other, "GET", `/dispatch/${t.id}/handovers`, undefined, 404);
  });
  test("rejected handover can be replaced, but foreign/reused photos and stale confirmations are rejected", async () => {
    const t = await towScene(rider, null);
    await match(t);
    await act(tower, t, "arrive");
    const foreign = await evidenceAssets(other);
    await request(
      tower,
      "POST",
      `/dispatch/${t.id}/handovers`,
      {
        phase: "PICKUP",
        condition: "Không được mượn ảnh",
        damages: [],
        assetIds: foreign,
      },
      400,
    );
    assert.equal((await M.S3Asset.findByPk(foreign[0])).attachedTo, null);
    const old = await proposeProof(t);
    await request(rider, "POST", `/dispatch/${t.id}/handovers/reject`, {
      handoverId: old.id,
      note: "Thiếu ảnh phần đuôi xe",
    });
    const next = await proposeProof(t);
    assert.equal(next.version, 2);
    await confirmProof(rider, t, old, 409);
    await confirmProof(rider, t, next);
    await request(
      tower,
      "POST",
      `/dispatch/${t.id}/handovers`,
      {
        phase: "PICKUP",
        condition: "Cố thay nội dung đã chốt",
        damages: [],
        assetIds: await evidenceAssets(tower),
      },
      409,
    );
  });
  test("delivery requires destination recipient confirmation and preserves pickup evidence for damage comparison", async () => {
    const t = await towScene();
    await book(t);
    await match(t);
    await start(t);
    await request(rider, "POST", `/dispatch/${t.id}/resolve`, {}, 409);
    const h = await proposeProof(t, "DELIVERY");
    await confirmProof(rider, t, h, 404);
    await confirmProof(shopper2, t, h, 404);
    await confirmProof(shopper, t, h);
    await receiveCash(t);
    await request(rider, "POST", `/dispatch/${t.id}/resolve`, {});
    const rows = await request(rider, "GET", `/dispatch/${t.id}/handovers`);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === "CONFIRMED"));
    const parent = await Ticket.findByPk(t.id);
    assert.ok(parent.childTicketId);
  });
  test("confirmed delivery to an old destination cannot be used after supported rerouting", async () => {
    const t = await towScene();
    await book(t);
    await match(t);
    await start(t);
    const old = await proposeProof(t, "DELIVERY");
    await confirmProof(shopper, t, old);
    await act(rider, t, "request-assistance", {
      reason: "DESTINATION_UNAVAILABLE",
    });
    const alt = await request(
      admin,
      "POST",
      `/admin/dispatch/${t.id}/propose-destination`,
      {
        dropoffShopId: shop2.id,
        reason: "Đổi nơi tiếp nhận theo yêu cầu các bên",
      },
    );
    await act(shopper2, t, "intake/accept", { reservationId: alt.id });
    await act(rider, t, "confirm-destination", { reservationId: alt.id });
    await confirmProof(shopper, t, old, 409);
    await request(rider, "POST", `/dispatch/${t.id}/resolve`, {}, 409);
    await move(tow, destination2);
    const next = await proposeProof(t, "DELIVERY");
    assert.equal(next.version, 2);
    await confirmProof(shopper2, t, next);
    await receiveCash(t);
    await request(rider, "POST", `/dispatch/${t.id}/resolve`, {});
    assert.equal((await M.Handover.findByPk(old.id)).status, "SUPERSEDED");
  });
  test("handover audit failure rolls back image claims and consent atomically", async () => {
    const t = await towScene(rider, null);
    await match(t);
    await act(tower, t, "arrive");
    const ids = await evidenceAssets(tower);
    const original = Event.create;
    Event.create = async () => {
      throw new Error("Audit unavailable");
    };
    try {
      await assert.rejects(
        () =>
          require("../src/services/handover.service").propose(tower, t.id, {
            phase: "PICKUP",
            condition: "Tình trạng xe có ảnh",
            damages: [],
            assetIds: ids,
          }),
        /Audit unavailable/,
      );
    } finally {
      Event.create = original;
    }
    assert.equal(await M.Handover.count({ where: { ticketId: t.id } }), 0);
    assert.equal((await M.S3Asset.findByPk(ids[0])).attachedTo, null);
  });
  test("dispute filing enforces ownership, seven day window, one case and immediate payout hold", async () => {
    const s = await cashDebt();
    await disputeFor(s.ticket, other)
      .then(() => assert.fail("Outsider"))
      .catch((e) => assert.match(e.message, /404/));
    const d = await disputeFor(s.ticket);
    assert.equal((await Ticket.findByPk(s.ticket.id)).disputeHold, true);
    assert.equal((await disputeFor(s.ticket)).id, d.id);
    await disputeFor(s.ticket, shopper)
      .then(() => assert.fail("Duplicate case"))
      .catch((e) => assert.match(e.message, /409/));
    await request(other, "GET", `/disputes/${d.id}`, undefined, 404);
    await request(shopper, "GET", `/disputes/${d.id}`);
    assert.equal(
      (await request(shopper, "GET", "/disputes/my-disputes")).total,
      1,
    );
    assert.equal((await request(admin, "GET", "/admin/disputes")).total, 1);
    const expired = await cashDebt(other);
    await Ticket.update(
      { resolvedAt: new Date(Date.now() - 7 * 86400000) },
      { where: { id: expired.ticket.id } },
    );
    await disputeFor(expired.ticket, other)
      .then(() => assert.fail("Expired window"))
      .catch((e) => assert.match(e.message, /409/));
  });
  test("response deadlines lead to review with hold intact; silence never decides the money", async () => {
    const s = await cashDebt();
    const d = await disputeFor(s.ticket);
    await ruleCase(d, { resolution: "NO_ACTION" }, 409);
    await M.Dispute.update(
      { responseDueAt: new Date(Date.now() - 1) },
      { where: { id: d.id } },
    );
    await require("../src/services/dispute.service").expireResponses();
    await require("../src/services/dispute.service").expireResponses();
    assert.equal((await M.Dispute.findByPk(d.id)).status, "REVIEW");
    assert.equal((await Ticket.findByPk(s.ticket.id)).disputeHold, true);
    await request(
      shopper,
      "POST",
      `/disputes/${d.id}/evidence`,
      { note: "Gửi quá hạn" },
      409,
    );
    const resolved = await ruleCase(d, { resolution: "NO_ACTION" });
    assert.equal(resolved.status, "REJECTED");
    assert.equal((await Ticket.findByPk(s.ticket.id)).disputeHold, false);
    assert.equal(
      resolved.events.filter((e) => e.action === "RESPONSE_DEADLINE_EXPIRED")
        .length,
      1,
    );
  });
  test("both parties can attach owned evidence and case history is append-only", async () => {
    const s = await cashDebt();
    const d = await disputeFor(s.ticket, rider, {
      assetIds: await evidenceAssets(rider),
    });
    await request(
      other,
      "POST",
      `/disputes/${d.id}/evidence`,
      { note: "Không được tham gia" },
      404,
    );
    await request(
      shopper,
      "POST",
      `/disputes/${d.id}/evidence`,
      {
        note: "Không được lấy ảnh của khách",
        assetIds: await evidenceAssets(rider),
      },
      400,
    );
    const reply = await request(shopper, "POST", `/disputes/${d.id}/evidence`, {
      note: "Ảnh đối chiếu tình trạng xe trước lúc sửa",
      assetIds: await evidenceAssets(shopper),
    });
    assert.ok(reply.respondedAt);
    assert.equal(reply.events.length, 2);
    await assert.rejects(
      () =>
        M.DisputeEvent.update(
          { note: "Ghi đè" },
          { where: { disputeId: d.id } },
        ),
      /append-only/,
    );
    await ruleCase(d, { resolution: "FAVOR_PROVIDER" });
    await request(
      rider,
      "POST",
      `/disputes/${d.id}/evidence`,
      { note: "Không ghi thêm sau phán quyết" },
      409,
    );
  });
  test("failed dispute audit rolls back hold, case and evidence attachment", async () => {
    const s = await cashDebt();
    const ids = await evidenceAssets(rider);
    const original = M.DisputeEvent.create;
    M.DisputeEvent.create = async () => {
      throw new Error("Dispute audit unavailable");
    };
    try {
      await assert.rejects(
        () =>
          require("../src/services/dispute.service").open(rider, {
            ticketId: s.ticket.id,
            reason: "OTHER",
            note: "Khiếu nại có bằng chứng",
            assetIds: ids,
          }),
        /Dispute audit unavailable/,
      );
    } finally {
      M.DisputeEvent.create = original;
    }
    assert.equal(await M.Dispute.count(), 0);
    assert.equal((await Ticket.findByPk(s.ticket.id)).disputeHold, false);
    assert.equal((await M.S3Asset.findByPk(ids[0])).attachedTo, null);
  });
  test("partial unpaid awards reduce debt persistently without pretending cash was received or refunded", async () => {
    const s = await cashDebt();
    const d = await disputeFor(s.ticket);
    await replyCase(d);
    await ruleCase(d, { resolution: "PARTIAL_REFUND", amount: "100000" }, 409);
    const result = await ruleCase(d, {
      resolution: "PARTIAL_REFUND",
      amount: "30000",
    });
    assert.equal(result.debtCreditAmount, "30000.00");
    assert.equal(result.refundAmount, "0.00");
    assert.equal(result.refund, null);
    assert.equal(result.recovery, null);
    assert.equal((await Ticket.findByPk(s.ticket.id)).quoteAmount, "100000.00");
    await require("../src/services/finance_lock.service").journey(
      s.ticket.journeyId,
      rider,
      (txn) =>
        require("../src/services/bill.service").syncJourney(
          s.ticket.journeyId,
          txn,
        ),
    );
    const bill = await Bill.findByPk(s.bill.id);
    assert.equal(bill.totalAmount, "70000.00");
    assert.equal(bill.dueAmount, "70000.00");
    assert.equal((await Cash.describe(rider.userId)).unpaidAmount, "70000.00");
    const repeat = await ruleCase(d, {
      resolution: "PARTIAL_REFUND",
      amount: "30000",
    });
    assert.equal(repeat.awardAmount, "30000.00");
    await ruleCase(d, { resolution: "FAVOR_RIDER" }, 409);
    await request(
      shopper,
      "POST",
      "/payments/confirm-cash",
      {
        paymentId: (await Pay.findOne({ where: { intentId: s.intent.id } })).id,
      },
      409,
    );
  });
  test("paid awards create one refund and recovery; payout deducts liability and proof is mandatory to mark refunded", async () => {
    const s = await onlineCompleted();
    const d = await disputeFor(s.ticket);
    await replyCase(d);
    const result = await ruleCase(d, {
      resolution: "PARTIAL_REFUND",
      amount: "30000",
    });
    assert.equal(result.debtCreditAmount, "0.00");
    assert.equal(result.refundAmount, "30000.00");
    assert.equal(result.refund.status, "PENDING");
    assert.equal((await Bill.findByPk(s.bill.id)).status, "PAID");
    assert.equal(
      (await ruleCase(d, { resolution: "PARTIAL_REFUND", amount: "30000" }))
        .refund.id,
      result.refund.id,
    );
    assert.equal(await M.ProviderRecovery.count(), 1);
    await request(
      other,
      "POST",
      `/admin/finance/refunds/${result.refund.id}/complete`,
      { externalReference: "NOT-ALLOWED" },
      403,
    );
    const proof = "DISPUTE-REFUND-001";
    await request(
      admin,
      "POST",
      `/admin/finance/refunds/${result.refund.id}/complete`,
      { externalReference: proof },
    );
    await request(
      admin,
      "POST",
      `/admin/finance/refunds/${result.refund.id}/complete`,
      { externalReference: proof },
    );
    await request(
      admin,
      "POST",
      `/admin/finance/refunds/${result.refund.id}/complete`,
      { externalReference: "DIFFERENT" },
      409,
    );
    assert.equal(await M.BankTransferProof.count(), 1);
    assert.equal(
      (await request(rider, "GET", `/disputes/${d.id}`)).events.filter(
        (e) => e.action === "REFUND_COMPLETED",
      ).length,
      1,
    );
    config.sepay.holdDays = 0;
    const batch = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    assert.equal(batch.entries[0].recoveryOffset, "30000.00");
    assert.equal(batch.net, "60000.00");
    assert.equal(
      (await request(shopper, "GET", "/payments/provider-earnings"))
        .disputeRecoveries[0].outstanding,
      "30000.00",
    );
    await request(admin, "PUT", `/admin/payouts/${batch.id}/settle`, {
      transfers: [
        {
          entryId: batch.entries[0].id,
          amount: "60000",
          reference: "DISPUTE-PAYOUT-001",
        },
      ],
    });
    assert.equal(
      (await request(shopper, "GET", "/payments/provider-earnings"))
        .disputeRecoveries[0].outstanding,
      "0.00",
    );
  });
  test("an existing payout cannot settle while disputed, and a monetary ruling rebuilds stale batches", async () => {
    const s = await onlineCompleted();
    config.sepay.holdDays = 0;
    const pending = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    const d = await disputeFor(s.ticket);
    await request(
      admin,
      "PUT",
      `/admin/payouts/${pending.id}/settle`,
      {
        transfers: [
          {
            entryId: pending.entries[0].id,
            amount: pending.net,
            reference: "BLOCKED-PAYOUT",
          },
        ],
      },
      409,
    );
    await replyCase(d);
    await ruleCase(d, { resolution: "FAVOR_RIDER" });
    assert.equal(
      (await M.PayoutBatch.findByPk(pending.id)).status,
      "CANCELLED",
    );
    const replacement = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    assert.equal(replacement.net, "0.00");
    assert.equal(replacement.recoveryOffsets[0].amount, "90000.00");
    await request(admin, "PUT", `/admin/payouts/${replacement.id}/settle`, {
      transfers: [],
    });
    assert.equal(
      (
        await require("../src/services/provider_recovery.service").balances(
          shopper.userId,
        )
      )[0].outstanding,
      "10000.00",
    );
  });
  test("post-payout awards preserve settled history and recover from future earnings without debt disappearing on cancel", async () => {
    const s = await onlineCompleted();
    config.sepay.holdDays = 0;
    const old = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    await request(admin, "PUT", `/admin/payouts/${old.id}/settle`, {
      transfers: [
        {
          entryId: old.entries[0].id,
          amount: old.net,
          reference: "PRE-DISPUTE-PAID",
        },
      ],
    });
    const d = await disputeFor(s.ticket);
    await replyCase(d);
    await ruleCase(d, { resolution: "PARTIAL_REFUND", amount: "30000" });
    assert.equal((await M.PayoutBatch.findByPk(old.id)).net, "90000.00");
    assert.equal((await M.PayoutBatch.findByPk(old.id)).status, "SETTLED");
    await onlineCompleted();
    let next = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    assert.equal(next.net, "60000.00");
    await request(admin, "POST", `/admin/payouts/${next.id}/cancel`, {
      reason: "Lập lại đúng thông tin đối soát",
    });
    assert.equal(
      (
        await require("../src/services/provider_recovery.service").balances(
          shopper.userId,
        )
      )[0].outstanding,
      "30000.00",
    );
    next = await request(admin, "POST", "/admin/payouts/create-batch", {}, 201);
    assert.equal(next.net, "60000.00");
    await request(admin, "PUT", `/admin/payouts/${next.id}/settle`, {
      transfers: [
        {
          entryId: next.entries[0].id,
          amount: next.net,
          reference: "POST-DISPUTE-PAID",
        },
      ],
    });
    assert.equal(
      (
        await require("../src/services/provider_recovery.service").balances(
          shopper.userId,
        )
      )[0].outstanding,
      "0.00",
    );
  });
  test("ruling audit failure rolls back debt credit, case status and payout hold", async () => {
    const s = await cashDebt();
    const d = await disputeFor(s.ticket);
    await replyCase(d);
    const original = M.DisputeEvent.create;
    M.DisputeEvent.create = async () => {
      throw new Error("Ruling journal unavailable");
    };
    try {
      await assert.rejects(
        () =>
          require("../src/services/dispute.service").resolve(admin, d.id, {
            resolution: "PARTIAL_REFUND",
            amount: "30000",
            note: "Quyết định cần ghi vào lịch sử",
          }),
        /Ruling journal unavailable/,
      );
    } finally {
      M.DisputeEvent.create = original;
    }
    assert.equal((await M.Dispute.findByPk(d.id)).status, "OPEN");
    assert.equal((await Ticket.findByPk(s.ticket.id)).disputeHold, true);
    assert.equal((await Bill.findByPk(s.bill.id)).totalAmount, "100000.00");
    assert.equal(await M.ProviderRecovery.count(), 0);
  });

  test("simultaneous monetary rulings are idempotent and cannot create duplicate refund liabilities", async () => {
    const s = await onlineCompleted();
    const d = await disputeFor(s.ticket);
    await replyCase(d);
    const results = await Promise.all([
      ruleCase(d, { resolution: "PARTIAL_REFUND", amount: "30000" }),
      ruleCase(d, { resolution: "PARTIAL_REFUND", amount: "30000" }),
    ]);
    assert.equal(results[0].refund.id, results[1].refund.id);
    assert.equal(await M.Refund.count({ where: { disputeId: d.id } }), 1);
    assert.equal(
      await M.ProviderRecovery.count({ where: { disputeId: d.id } }),
      1,
    );
    assert.equal(
      await M.DisputeEvent.count({
        where: { disputeId: d.id, action: "ADJUDICATED" },
      }),
      1,
    );
  });
  test("paid ruling failure restores pending batch and removes provisional refund and recovery", async () => {
    const s = await onlineCompleted();
    config.sepay.holdDays = 0;
    const batch = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    const d = await disputeFor(s.ticket);
    await replyCase(d);
    const original = M.DisputeEvent.create;
    M.DisputeEvent.create = async () => {
      throw new Error("Final journal unavailable");
    };
    try {
      await assert.rejects(
        () =>
          require("../src/services/dispute.service").resolve(admin, d.id, {
            resolution: "PARTIAL_REFUND",
            amount: "30000",
            note: "Phải ghi lịch sử đầy đủ",
          }),
        /Final journal unavailable/,
      );
    } finally {
      M.DisputeEvent.create = original;
    }
    assert.equal((await M.PayoutBatch.findByPk(batch.id)).status, "PENDING");
    assert.equal(await M.ProviderRecovery.count(), 0);
    assert.equal(await M.Refund.count({ where: { disputeId: d.id } }), 0);
    assert.equal((await Ticket.findByPk(s.ticket.id)).disputeHold, true);
  });
  test("provider may file and the rider responds within the same shared case", async () => {
    const s = await cashDebt();
    const d = await disputeFor(s.ticket, shopper, {
      reason: "OTHER",
      note: "Cần đối chiếu việc thanh toán của khách",
    });
    assert.equal(d.respondentId, rider.userId);
    await replyCase(d, rider);
    const result = await ruleCase(d, { resolution: "FAVOR_PROVIDER" });
    assert.equal(result.awardAmount, "0.00");
    assert.equal((await Bill.findByPk(s.bill.id)).dueAmount, "100000.00");
  });
  test("startup enables evidence gates for active legacy trips without inventing historical pickup consent", async () => {
    const t = await towScene(rider, null);
    await match(t);
    await act(tower, t, "arrive");
    await cashFor(t);
    await Ticket.update({ handoverRequired: false }, { where: { id: t.id } });
    await request(rider, "POST", `/dispatch/${t.id}/start`, {});
    await require("../src/config/operations.migrations")(db);
    assert.equal((await Ticket.findByPk(t.id)).handoverRequired, true);
    assert.equal(await M.Handover.count({ where: { ticketId: t.id } }), 0);
    await move(tow, destination2);
    await request(rider, "POST", `/dispatch/${t.id}/resolve`, {}, 409);
    const h = await proposeProof(t, "DELIVERY");
    await confirmProof(rider, t, h);
    await receiveCash(t);
    await request(rider, "POST", `/dispatch/${t.id}/resolve`, {});
    await assert.rejects(
      () =>
        M.Handover.update(
          { condition: "Thay tình trạng xe" },
          { where: { id: h.id } },
        ),
      /rewritten/,
    );
  });
  test("confirmed cash compensation and commission remain separate debts across future online payout", async () => {
    const s = await cashDebt();
    const payment = await Pay.findOne({ where: { intentId: s.intent.id } });
    await request(shopper, "POST", "/payments/confirm-cash", {
      paymentId: payment.id,
    });
    const d = await disputeFor(s.ticket);
    await replyCase(d);
    const ruled = await ruleCase(d, {
      resolution: "PARTIAL_REFUND",
      amount: "30000",
    });
    assert.equal(ruled.refundAmount, "30000.00");
    assert.equal(ruled.debtCreditAmount, "0.00");
    assert.equal((await Cash.describe(rider.userId)).unpaidAmount, "0.00");
    config.sepay.holdDays = 0;
    const cashBatch = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    await request(admin, "PUT", `/admin/payouts/${cashBatch.id}/settle`, {
      transfers: [],
    });
    await onlineCompleted();
    const batch = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    assert.equal(batch.entries[0].debtOffset, "10000.00");
    assert.equal(batch.entries[0].recoveryOffset, "30000.00");
    assert.equal(batch.net, "50000.00");
    await request(admin, "PUT", `/admin/payouts/${batch.id}/settle`, {
      transfers: [
        {
          entryId: batch.entries[0].id,
          amount: batch.net,
          reference: "CASH-COMPENSATION-OFFSET",
        },
      ],
    });
    const earnings = await request(
      shopper,
      "GET",
      "/payments/provider-earnings",
    );
    assert.equal(earnings.cashCommissionDebt, "0.00");
    assert.equal(earnings.disputeRecoveries[0].outstanding, "0.00");
    await assert.rejects(
      () =>
        M.ProviderRecovery.update(
          { amount: "0.00" },
          { where: { disputeId: d.id } },
        ),
      /immutable/,
    );
    const history = await request(rider, "GET", `/disputes/${d.id}`);
    assert.ok(history.events.some((e) => e.action === "RECOVERY_SETTLED"));
  });
  test("filing racing with payout settlement serializes hold and never leaves an open case eligible", async () => {
    const s = await onlineCompleted();
    config.sepay.holdDays = 0;
    const batch = await request(
      admin,
      "POST",
      "/admin/payouts/create-batch",
      {},
      201,
    );
    const [opened, settled] = await Promise.all([
      fetch(base + "/api/v1/disputes", {
        method: "POST",
        headers: {
          Cookie: `road_as_token=${rider.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ticketId: s.ticket.id,
          reason: "OTHER",
          note: "Mở hồ sơ trong lúc đối soát để kiểm tra khóa",
        }),
      }),
      fetch(base + `/api/v1/admin/payouts/${batch.id}/settle`, {
        method: "PUT",
        headers: {
          Cookie: `road_as_token=${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transfers: [
            {
              entryId: batch.entries[0].id,
              amount: batch.net,
              reference: "RACE-PAYOUT-SETTLEMENT",
            },
          ],
        }),
      }),
    ]);
    assert.equal(opened.status, 201);
    assert.ok([200, 409].includes(settled.status));
    assert.equal((await Ticket.findByPk(s.ticket.id)).disputeHold, true);
    const p = await Pay.findOne({
      where: { method: "SEPAY", status: "CONFIRMED" },
    });
    assert.equal(
      await require("../src/services/payout.service").eligible(p),
      false,
    );
    assert.equal(
      await M.Dispute.count({ where: { ticketId: s.ticket.id } }),
      1,
    );
  });
}
