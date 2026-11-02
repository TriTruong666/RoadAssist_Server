const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
if (process.env.RUN_DB_TESTS !== "1")
  test(
    "Phase 5 dispatch integration (RUN_DB_TESTS=1)",
    { skip: true },
    () => {},
  );
else {
  const suffix = randomUUID().replaceAll("-", "");
  Object.assign(process.env, {
    NODE_ENV: "test",
    DB_SCHEMA: `dispatch_test_${suffix}`,
    AUTH_REDIS_PREFIX: `test:${suffix}:auth:`,
    PROVIDER_REDIS_PREFIX: `test:${suffix}:providers:`,
    JWT_SECRET: randomUUID() + randomUUID(),
    ALLOWED_CLIENT_URL_1: "http://localhost:5173",
  });
  const s3 = require("./s3.fixture");
  const { app } = require("../index");
  const db = require("../src/config/postgres.config");
  const redis = require("../src/config/redis.config");
  const { DataTypes: D, Op } = require("sequelize");
  const {
    User,
    VehicleProfile: Vehicle,
    VehicleRideConfig: Ride,
    Provider,
    DispatchTicket: Ticket,
    DispatchEvent: Event,
    DispatchNotification: Notification,
    ChatRoom,
    S3Asset,
  } = require("../src/models");
  const Service = require("../src/services/dispatch.service");
  const Payment = require("../src/services/dispatch_payment.service");
  const Availability = require("../src/services/provider_availability.service");
  const Notify = require("../src/services/dispatch_notification.service");
  const { Bill, BillItem: Item, BillPayment: Pay, PaymentIntent } = require('../src/models');
  let server,
    io,
    base,
    rider,
    other,
    shopper,
    mobileOwner,
    mobileOwner2,
    towOwner,
    towOwner2,
    shop,
    mobile,
    mobile2,
    tow,
    tow2;
  const point = { latitude: 10.77, longitude: 106.69 };
  let vehicleNo = 0;
  const gps = (p = point) => ({
    ...p,
    accuracy: 5,
    recordedAt: new Date().toISOString(),
  });
  async function account(n) {
    const user = await User.create({
      name: `Dispatch ${n}`,
      email: `dispatch-${n}@example.com`,
      phone: `09220000${String(n).padStart(2, "0")}`,
      password: "Dispatch-strong-test-password!",
      emailVerifiedAt: new Date(),
    });
    const session = await require("../src/services/auth.service").completeLogin(
      { userId: user.userId, ipAddress: "127.0.0.1" },
    );
    return { userId: user.userId, token: session.token };
  }
  async function vehicle(actor = rider, type = "BIKE", extra = {}) {
    const v = await Vehicle.create({
      userId: actor.userId,
      type,
      plateNumber: `TEST-${++vehicleNo}`,
      brand: "Test",
      modelName: "Fixture",
      length: type === "BIKE" ? 2 : 4.5,
      weightKg: type === "BIKE" ? 150 : 1800,
      ...extra,
    });
    await Ride.create({
      vehicleProfileId: v.id,
      width: v.baseWidth,
      height: v.baseHeight,
      mode: "SOLO",
    });
    await User.update(
      { activeVehicleId: v.id },
      { where: { userId: actor.userId } },
    );
    return v;
  }
  async function provider(actor, kind) {
    let v;
    if (kind !== "SHOP")
      v = await vehicle(actor, kind === "TOW" ? "CAR" : "BIKE");
    return Provider.create({
      userId: actor.userId,
      name: `Provider ${kind}`,
      phone: "0901234567",
      kind,
      ...point,
      address: "Test shop",
      status: "ACTIVE",
      accepting: true,
      requiresApproval: false,
      reviewedRevision: 1,
      maxConcurrentJobs: kind === "SHOP" ? 20 : 1,
      capabilities:
        kind === "TOW" ? ["TOWING"] : ["TYRE_REPAIR", "ENGINE_REPAIR"],
      supportedVehicleTypes: ["BIKE", "CAR"],
      serviceSegments: ["SOLO_BIKE", "CAR"],
      ...(v && {
        vehicleProfileId: v.id,
        plateNumber: v.plateNumber,
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
  async function request(actor, method, path, body, status = 200) {
    const response = await fetch(base + "/api/v1" + path, {
      method,
      headers: {
        ...(actor && { Cookie: `road_as_token=${actor.token}` }),
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const json = await response.json();
    assert.equal(response.status, status, JSON.stringify(json));
    return json.data;
  }
  async function create(type = "sos", extra = {}) {
    const v = await vehicle();
    return request(
      rider,
      "POST",
      "/dispatch/" + type,
      {
        vehicleProfileId: v.id,
        ...(type === "walk-in"
          ? { providerId: shop.id, location: gps() }
          : {
              pickupLatitude: point.latitude,
              pickupLongitude: point.longitude,
            }),
        ...(type === "tow"
          ? { dropoffLatitude: 10.78, dropoffLongitude: 106.7 }
          : {}),
        ...extra,
      },
      201,
    );
  }
  const action = (actor, ticket, name, body = {}, status = 200) =>
    request(actor, "POST", `/dispatch/${ticket.id}/${name}`, body, status);
  async function accept(ticket, p = mobile, actor = mobileOwner) {
    return action(actor, ticket, "accept", { providerId: p.id });
  }
  async function fund(ticket, method = 'CASH', status = 'PENDING', extra = {}) {
    const t = await Ticket.findByPk(ticket.id);
    const Locks = require('../src/services/finance_lock.service');
    return Locks.journey(t.journeyId, null, async transaction => {
      const bill = await require('../src/services/bill.service').syncJourney(t.journeyId,transaction);
      const items = await Item.findAll({where:{billId:bill.id,ticketId:t.id},transaction});
      const code = require('../src/services/payment.service').code();
      const intent = await PaymentIntent.create({billId:bill.id,userId:t.userId,code,method,amount:extra.amount||t.totalAmount,receivedAmount:method==='SEPAY'&&status!=='PENDING'?(extra.amount||t.totalAmount):'0.00',status:status==='PENDING'?'PENDING':'HELD',expiresAt:new Date(Date.now()+3600000),fingerprint:randomUUID()},{transaction});
      let last;let index=0;
      for (const item of items.filter(i=>Number(i.amount)>0)) {
        last = await Pay.create({billId:bill.id,billItemId:item.id,intentId:intent.id,providerId:t.providerId,providerUserId:item.providerUserId,method,status,amount:item.amount,appliedAmount:item.amount,transactionCode:code+'-'+(++index),...(status==='REFUNDED'&&{refundedAmount:extra.amount||item.amount}),...extra},{transaction});
      }
      return last;
    });
  }
  async function move(p, pointValue = point) {
    await p.update({
      ...pointValue,
      lastAccuracy: 5,
      locationQuality: "GOOD",
      lastTrustedLocationAt: new Date(),
      lastTrustedRecordedAt: new Date(),
    });
  }
  async function evidence(actor = mobileOwner) {
    const item = await S3Asset.create({
      userId: actor.userId,
      s3Key: `roadassist/${randomUUID()}.webp`,
      s3Url: `https://s3.test/roadassist/${randomUUID()}.webp`,
      s3Bucket: "picare-s3",
      s3Region: "ap-southeast-1",
      originalName: "proof.webp",
      mimeType: "image/webp",
      fileSize: 100,
    });
    return item.id;
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
    [rider, other, shopper, mobileOwner, mobileOwner2, towOwner, towOwner2] =
      await Promise.all([1, 2, 3, 4, 5, 6, 7].map(account));
    shop = await provider(shopper, "SHOP");
    mobile = await provider(mobileOwner, "MOBILE_SHOP");
    mobile2 = await provider(mobileOwner2, "MOBILE_SHOP");
    tow = await provider(towOwner, "TOW");
    tow2 = await provider(towOwner2, "TOW");
  });
  afterEach(async () => {
    await Ticket.update(
      { status: "4" },
      { where: { status: { [Op.notIn]: ["4", "5", "8", "12", "15"] } } },
    );
    await Provider.update(
      { accepting: true, suspended: false, status: "ACTIVE" },
      {
        where: {
          id: { [Op.in]: [shop.id, mobile.id, mobile2.id, tow.id, tow2.id] },
        },
      },
    );
    for (const p of [mobile, mobile2, tow, tow2]) {
      await p.reload();
      await move(p);
    }
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
  test("create requires cookies, owned active vehicle, correct GPS/type and server-trusted pricing", async () => {
    await request(null, "POST", "/dispatch/sos", {}, 401);
    const v = await vehicle(other);
    await request(
      rider,
      "POST",
      "/dispatch/sos",
      { vehicleProfileId: v.id, pickupLatitude: 10, pickupLongitude: 106 },
      400,
    );
    await create("walk-in", { location: gps({ latitude: 11, longitude: 106 }) })
      .then(() => assert.fail("Expected out-of-range"))
      .catch((error) => assert.match(error.message, /409/));
    const car = await vehicle(rider, "CAR");
    await request(
      rider,
      "POST",
      "/dispatch/walk-in",
      { vehicleProfileId: car.id, providerId: shop.id, location: gps() },
      400,
    );
    const bike = await vehicle();
    await Ride.update(
      { mode: "PASSENGER" },
      { where: { vehicleProfileId: bike.id } },
    );
    await request(
      rider,
      "POST",
      "/dispatch/walk-in",
      { vehicleProfileId: bike.id, providerId: shop.id, location: gps() },
      400,
    );
    const ticket = await create("sos", {
      providerId: mobile.id,
      status: "4",
      totalAmount: "1",
      pricingSnapshot: { sosCallOutFee: "1" },
    });
    assert.equal(ticket.status, "1");
    assert.equal(ticket.providerId, null);
    assert.equal(ticket.totalAmount, "0.00");
    await request(
      rider,
      "POST",
      "/dispatch/tow",
      { pickupLatitude: 10, pickupLongitude: 106 },
      400,
    );
  });
  test("concurrent creation and request idempotency preserve one active vehicle ticket", async () => {
    const v = await vehicle();
    const payload = {
      vehicleProfileId: v.id,
      pickupLatitude: point.latitude,
      pickupLongitude: point.longitude,
      clientRequestId: randomUUID(),
    };
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        request(rider, "POST", "/dispatch/sos", payload, 201),
      ),
    );
    assert.equal(new Set(results.map((t) => t.id)).size, 1);
    await request(
      rider,
      "POST",
      "/dispatch/sos",
      { ...payload, pickupLatitude: 11 },
      409,
    );
    const responses = await Promise.all(
      [1, 2].map(() =>
        fetch(base + "/api/v1/dispatch/sos", {
          method: "POST",
          headers: {
            Cookie: `road_as_token=${rider.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...payload, clientRequestId: randomUUID() }),
        }),
      ),
    );
    assert.ok(responses.every((r) => r.status === 409));
    assert.equal(
      await Ticket.count({ where: { vehicleProfileId: v.id, status: "1" } }),
      1,
    );
    await request(rider, "PUT", `/vehicles/${v.id}`, { color: "black" }, 409);
  });
  test("walk-in binding quote, cash/SePay funding gate, readiness and rider acceptance are ordered and audited", async () => {
    const t = await create("walk-in");
    await accept(t, shop, shopper);
    await action(shopper, t, "in-shop");
    await action(shopper, t, "quote", { amount: "100000.00" });
    await action(shopper, t, "quote", { amount: "100001" }, 409);
    await action(other, t, "approve-quote", {}, 404);
    await action(rider, t, "approve-quote", {}, 403);
    const payment = await fund(t, "SEPAY", "PENDING");
    await action(rider, t, "approve-quote", {}, 403);
    await payment.update({ status: "HELD" });
    await action(rider, t, "approve-quote");
    await action(rider, t, "resolve", {}, 409);
    await action(shopper, t, "ready");
    await action(rider, t, "resolve");
    const detail = await request(rider, "GET", `/dispatch/${t.id}`);
    assert.equal(detail.status, "4");
    assert.equal(detail.totalAmount, "100000.00");
    assert.ok(detail.events.length >= 6);
    await action(rider, t, "resolve");
    await assert.rejects(
      () =>
        Event.findOne({ where: { ticketId: t.id } }).then((e) =>
          e.update({ action: "FORGED" }),
        ),
      /append-only/,
    );
  });
  test("underfunded, refunded and wrong-provider payments never approve work; client payment fields are ignored", async () => {
    const t = await create("walk-in");
    await accept(t, shop, shopper);
    await action(shopper, t, "quote", { amount: "50000" });
    await fund(t, "CASH", "PENDING", { amount: "49999" });
    await action(
      rider,
      t,
      "approve-quote",
      { fundedForApproval: true, paymentStatus: "HELD" },
      403,
    );
    const payment = await fund(t, "SEPAY", "REFUNDED", { amount: "1" });
    await action(rider, t, "approve-quote", {}, 403);
    await payment.update({
      status: "HELD",
      amount: "1",
      providerId: mobile.id,
    });
    await action(rider, t, "approve-quote", {}, 403);
    await payment.update({
      providerId: shop.id,
      status: "HELD",
      amount: "50000",
    });
    await action(rider, t, "approve-quote");
  });
  test("competing providers cannot steal one ticket or exceed a shared mobile capacity", async () => {
    const t = await create();
    const results = await Promise.all(
      [
        [mobile, mobileOwner],
        [mobile2, mobileOwner2],
      ].map(([p, actor]) =>
        fetch(base + `/api/v1/dispatch/${t.id}/accept`, {
          method: "POST",
          headers: {
            Cookie: `road_as_token=${actor.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ providerId: p.id }),
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const assigned = await Ticket.findByPk(t.id);
    const winner = assigned.providerId === mobile.id ? mobile : mobile2;
    const owner = winner.id === mobile.id ? mobileOwner : mobileOwner2;
    const another = await create();
    await accept(another, winner, owner)
      .then(() => assert.fail("Expected capacity error"))
      .catch((error) => assert.match(error.message, /409/));
    assert.equal(await Availability.activeJobs(winner), 1);
    await request(other, "GET", `/dispatch/${t.id}`, undefined, 404);
  });
  test("SOS arrival uses trusted recent provider GPS and preserves the one-km callout waiver", async () => {
    const t = await create();
    const accepted = await accept(t);
    assert.equal(accepted.callOutFee, "0.00");
    await mobile.update({
      lastTrustedLocationAt: new Date(Date.now() - 180000),
    });
    await action(rider, t, "arrive", {}, 409);
    await move(mobile, { latitude: 10.8, longitude: 106.69 });
    await action(mobileOwner, t, "arrive", {}, 409);
    await move(mobile);
    await action(rider, t, "arrive");
    await action(mobileOwner, t, "quote", { amount: "25000" });
    await fund(t);
    await action(rider, t, "approve-quote");
    await action(mobileOwner, t, "ready");
    await action(rider, t, "resolve");
  });
  test("unfixable SOS cancels repair/travel charges, requires owned evidence, and creates one linked retry", async () => {
    await move(mobile, { latitude: 10.79, longitude: 106.69 });
    const t = await create();
    const accepted = await accept(t);
    assert.equal(accepted.callOutFee, "30000.00");
    await move(mobile);
    await action(mobileOwner, t, "arrive");
    await action(mobileOwner, t, "quote", { amount: "90000" });
    await action(
      mobileOwner,
      t,
      "unfixable",
      { reason: "NO_PARTS", assetIds: [] },
      400,
    );
    const stolen = await evidence(other);
    await action(
      mobileOwner,
      t,
      "unfixable",
      { reason: "NO_PARTS", assetIds: [stolen] },
      400,
    );
    const proof = await evidence();
    const result = await action(mobileOwner, t, "unfixable", {
      reason: "NO_PARTS",
      assetIds: [proof],
    });
    assert.equal(result.status, "15");
    assert.equal(result.travelFee, "0.00");
    assert.equal(result.totalAmount, "30000.00");
    assert.equal(result.quoteAmount, "90000.00");
    assert.equal(result.quoteVoided, true);
    const child = await action(rider, t, "retry-sos", {}, 201);
    assert.equal(child.journeyId, t.journeyId);
    assert.equal(child.parentTicketId, t.id);
    assert.ok(child.formerAssignedShopIds.includes(mobile.id));
    const again = await action(rider, t, "retry-sos", {}, 201);
    assert.equal(again.id, child.id);
    await accept(child, mobile, mobileOwner)
      .then(() => assert.fail("Excluded"))
      .catch((error) => assert.match(error.message, /409/));
  });
  test("TOW driver cancellation requeues, clears waiting fees and rotates private chat; rejected driver cannot return", async () => {
    const t = await create("tow");
    await accept(t, tow, towOwner);
    await action(towOwner, t, "arrive");
    const oldRoom = await ChatRoom.findOne({
      where: { scope: "DISPATCH", referenceId: t.id },
      order: [["version", "DESC"]],
    });
    await action(towOwner, t, "cancel", { reason: "Không thể tiếp tục" });
    const pending = await Ticket.findByPk(t.id);
    assert.equal(pending.status, "1");
    assert.equal(pending.providerId, null);
    assert.equal(pending.waitingFee, "0.00");
    assert.equal(pending.arrivedAt, null);
    assert.ok(pending.formerAssignedShopIds.includes(tow.id));
    await oldRoom.reload();
    assert.equal(oldRoom.isArchived, true);
    await accept(t, tow, towOwner)
      .then(() => assert.fail("Excluded"))
      .catch((error) => assert.match(error.message, /409/));
    await accept(t, tow2, towOwner2);
    await request(towOwner, "GET", `/chat/DISPATCH/${t.id}`, undefined, 404);
  });
  test("waiting fees use ten-minute grace, started-minute rounding, cap and freeze at funded start", async () => {
    const t = await create("tow");
    await accept(t, tow, towOwner);
    await action(towOwner, t, "arrive");
    await Ticket.update(
      { arrivedAt: new Date(Date.now() - 10 * 60000 - 1500) },
      { where: { id: t.id } },
    );
    let detail = await request(rider, "GET", `/dispatch/${t.id}`);
    assert.equal(detail.waitingMinutes, 1);
    assert.equal(detail.waitingFee, "2000.00");
    await Ticket.update(
      { arrivedAt: new Date(Date.now() - 120 * 60000) },
      { where: { id: t.id } },
    );
    detail = await request(rider, "GET", `/dispatch/${t.id}`);
    assert.equal(detail.waitingMinutes, 60);
    assert.equal(detail.waitingFee, "120000.00");
    await action(rider, t, "start", {}, 403);
    await Ticket.update(
      { waitingFee: detail.waitingFee, totalAmount: detail.totalAmount },
      { where: { id: t.id } },
    );
    await fund(t);
    await action(rider, t, "start");
    const frozen = await request(rider, "GET", `/dispatch/${t.id}`);
    assert.equal(frozen.waitingMinutes, 60);
    await action(towOwner, t, "cancel", { reason: "Too late" }, 409);
    await move(tow, { latitude: 10.78, longitude: 106.7 });
    await action(rider, t, "resolve");
  });
  test("TOW requires saved physical dimensions and compatible capacity rather than client filters", async () => {
    const v = await vehicle();
    await v.update({ weightKg: null });
    await request(
      rider,
      "POST",
      "/dispatch/tow",
      {
        vehicleProfileId: v.id,
        pickupLatitude: 10.77,
        pickupLongitude: 106.69,
        dropoffLatitude: 10.78,
        dropoffLongitude: 106.7,
        vehicleWeightKg: 100,
      },
      400,
    );
    const heavy = await vehicle(rider, "CAR", { weightKg: 4500 });
    const t = await request(
      rider,
      "POST",
      "/dispatch/tow",
      {
        vehicleProfileId: heavy.id,
        pickupLatitude: 10.77,
        pickupLongitude: 106.69,
        dropoffLatitude: 10.78,
        dropoffLongitude: 106.7,
      },
      201,
    );
    await action(towOwner, t, "accept", { providerId: tow.id }, 409);
  });
  test("destination estimates expire and retarget clears stale approval without changing travel phase", async () => {
    const t = await create("tow", { dropoffShopId: shop.id });
    let estimate = await action(shopper, t, "estimate", { amount: "50000" });
    assert.equal(estimate.status, "13");
    await action(rider, t, "approve-estimate", { estimateVersion: 99 }, 409);
    await action(rider, t, "approve-estimate", {
      estimateVersion: estimate.estimateVersion,
    });
    await accept(t, tow, towOwner);
    await Ticket.update(
      { estimateExpiresAt: new Date(Date.now() - 1) },
      { where: { id: t.id } },
    );
    await action(
      rider,
      t,
      "approve-estimate",
      { estimateVersion: estimate.estimateVersion },
      409,
    );
    await Service.expireEstimates();
    assert.equal((await Ticket.findByPk(t.id)).status, "2");
    assert.equal((await Ticket.findByPk(t.id)).estimateStatus, "EXPIRED");
    await action(rider, t, "retarget", {
      dropoffLatitude: 10.79,
      dropoffLongitude: 106.71,
    });
    const row = await Ticket.findByPk(t.id);
    assert.equal(row.dropoffShopId, null);
    assert.equal(row.estimateAmount, null);
    assert.equal(row.status, "2");
  });
  test("delivery atomically resolves TOW and creates one linked shop ticket, including CAR and final quote flow", async () => {
    const car = await vehicle(rider, "CAR");
    const t = await request(
      rider,
      "POST",
      "/dispatch/tow",
      {
        vehicleProfileId: car.id,
        pickupLatitude: 10.77,
        pickupLongitude: 106.69,
        dropoffShopId: shop.id,
      },
      201,
    );
    const estimate = await action(shopper, t, "estimate", { amount: "70000" });
    await action(rider, t, "approve-estimate", {
      estimateVersion: estimate.estimateVersion,
    });
    await accept(t, tow, towOwner);
    await action(towOwner, t, "arrive");
    await fund(t);
    await action(rider, t, "start");
    Ticket.addHook("beforeCreate", "delivery-failure", (child) => {
      if (child.handoffKind === "TOW_DELIVERY")
        throw new Error("Child unavailable");
    });
    try {
      await assert.rejects(
        () => Service.action(rider, t.id, "resolve", {}),
        /Child unavailable/,
      );
    } finally {
      Ticket.removeHook("beforeCreate", "delivery-failure");
    }
    assert.equal((await Ticket.findByPk(t.id)).status, "6");
    assert.equal(await Ticket.count({ where: { parentTicketId: t.id } }), 0);
    await action(rider, t, "resolve");
    const parent = await Ticket.findByPk(t.id);
    assert.ok(parent.childTicketId);
    const child = await Ticket.findByPk(parent.childTicketId);
    assert.equal(child.type, "WALK_IN");
    assert.equal(child.vehicleSnapshot.type, "CAR");
    assert.equal(child.journeyId, t.journeyId);
    await action(rider, t, "resolve");
    assert.equal(await Ticket.count({ where: { parentTicketId: t.id } }), 1);
    await accept(child, shop, shopper);
    const quoted = await action(shopper, child, "quote", { amount: "75000" });
    assert.equal(quoted.status, "11");
  });
  test("transaction failures roll back dispatch state, chat versions, evidence claims and notifications", async (t) => {
    const ticket = await create();
    const before = await Notification.count();
    const rooms = await ChatRoom.count({ where: { referenceId: ticket.id } });
    const original = Event.create;
    Event.create = async () => {
      throw new Error("audit failed");
    };
    try {
      await assert.rejects(
        () => Service.accept(mobileOwner, ticket.id, { providerId: mobile.id }),
        /audit failed/,
      );
    } finally {
      Event.create = original;
    }
    const row = await Ticket.findByPk(ticket.id);
    assert.equal(row.status, "1");
    assert.equal(row.providerId, null);
    assert.equal(await Notification.count(), before);
    assert.equal(
      await ChatRoom.count({ where: { referenceId: ticket.id } }),
      rooms,
    );
  });
  test("feeds redact private data, reject stale revisions, and destination shops cannot operate the tow driver state", async () => {
    const ticket = await create("tow", { dropoffShopId: shop.id });
    const feed = await request(
      towOwner,
      "GET",
      `/dispatch/provider-feed?providerId=${tow.id}`,
    );
    const item = feed.find((t) => t.id === ticket.id);
    assert.ok(item);
    assert.equal(item.userId, undefined);
    assert.equal(item.vehicleSnapshot, undefined);
    assert.equal(item.images, undefined);
    await action(shopper, ticket, "arrive", {}, 404);
    await action(
      towOwner,
      ticket,
      "accept",
      { providerId: tow.id, expectedRevision: 999 },
      409,
    );
    await accept(ticket, tow, towOwner);
    await request(other, "GET", `/dispatch/${ticket.id}`, undefined, 404);
    assert.ok(
      (
        await request(rider, "GET", "/dispatch/my-requests?active=true")
      ).items.some((t) => t.id === ticket.id),
    );
  });
  test("shared rescue vehicle capacity and rider vehicle requests cannot overlap", async () => {
    const linked = await Provider.create({
      userId: towOwner.userId,
      name: "Shared mobile",
      phone: "0901234567",
      kind: "MOBILE_SHOP",
      ...point,
      address: "Shared",
      status: "ACTIVE",
      accepting: true,
      requiresApproval: false,
      capabilities: ["TYRE_REPAIR"],
      supportedVehicleTypes: ["BIKE", "CAR"],
      vehicleProfileId: tow.vehicleProfileId,
      plateNumber: tow.plateNumber,
      licenseNumber: "LICENSE",
      locationQuality: "GOOD",
      lastAccuracy: 5,
      lastTrustedLocationAt: new Date(),
      lastTrustedRecordedAt: new Date(),
    });
    const a = await create("sos");
    const b = await create("tow");
    const results = await Promise.all(
      [
        [a, linked],
        [b, tow],
      ].map(([ticket, profile]) =>
        fetch(base + `/api/v1/dispatch/${ticket.id}/accept`, {
          method: "POST",
          headers: {
            Cookie: `road_as_token=${towOwner.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ providerId: profile.id }),
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    await request(
      towOwner,
      "POST",
      "/dispatch/sos",
      {
        vehicleProfileId: tow.vehicleProfileId,
        pickupLatitude: 10.77,
        pickupLongitude: 106.69,
      },
      409,
    );
  });
  test("rider cancellation, shop decline, unfixable acknowledgement and return tow cover terminal branches", async () => {
    const declined = await create("walk-in");
    assert.equal(
      (
        await action(shopper, declined, "decline", {
          reason: "Tiệm không tiếp nhận",
        })
      ).status,
      "8",
    );
    const cancelled = await create();
    assert.equal(
      (
        await action(rider, cancelled, "cancel", {
          reason: "Không cần cứu hộ nữa",
        })
      ).status,
      "5",
    );
    await action(rider, cancelled, "cancel", { reason: "Retry cancellation" });
    const failed = await create("walk-in");
    await accept(failed, shop, shopper);
    const proof = await evidence(shopper);
    await action(shopper, failed, "unfixable", {
      reason: "BEYOND_REPAIR",
      assetIds: [proof],
    });
    assert.equal(
      (await action(rider, failed, "acknowledge-unfixable")).status,
      "12",
    );
    const ready = await create("walk-in");
    await accept(ready, shop, shopper);
    await action(shopper, ready, "quote", { amount: "0" });
    await action(rider, ready, "approve-quote");
    await action(shopper, ready, "ready");
    await action(rider, ready, "return-tow", { location: gps() }, 409);
    const returned = await action(
      rider,
      ready,
      "return-tow",
      { location: gps({ latitude: 10.8, longitude: 106.69 }) },
      201,
    );
    assert.equal(returned.type, "TOW");
    assert.equal(returned.dropoffLatitude, 10.8);
    assert.equal((await Ticket.findByPk(ready.id)).status, "4");
  });
  test("direct tow offers are linked to the same owner and rider consent creates the targeted child", async () => {
    const linked = await Provider.findOne({
      where: { userId: towOwner.userId, kind: "MOBILE_SHOP" },
    });
    await move(linked);
    const t = await create();
    await accept(t, linked, towOwner);
    await action(towOwner, t, "arrive");
    const proof = await evidence(towOwner);
    await action(towOwner, t, "unfixable", {
      reason: "NO_PARTS",
      assetIds: [proof],
    });
    await action(
      towOwner,
      t,
      "tow-offer",
      { mode: "DIRECT", directProviderId: tow2.id },
      409,
    );
    await action(towOwner, t, "tow-offer", {
      mode: "DIRECT",
      directProviderId: tow.id,
    });
    const child = await action(
      rider,
      t,
      "request-tow",
      { dropoffLatitude: 10.78, dropoffLongitude: 106.7 },
      201,
    );
    assert.equal(child.targetProviderId, tow.id);
    await action(towOwner2, child, "accept", { providerId: tow2.id }, 409);
  });
  test("audit failure releases evidence claims; cache outage after commit cannot turn acceptance into an error", async () => {
    const t = await create();
    await accept(t);
    await action(mobileOwner, t, "arrive");
    const proof = await evidence();
    const original = Event.create;
    Event.create = async () => {
      throw new Error("audit unavailable");
    };
    try {
      await assert.rejects(
        () =>
          Service.action(mobileOwner, t.id, "unfixable", {
            reason: "SAFETY",
            assetIds: [proof],
          }),
        /audit unavailable/,
      );
    } finally {
      Event.create = original;
    }
    assert.equal((await S3Asset.findByPk(proof)).attachedTo, null);
    assert.equal((await Ticket.findByPk(t.id)).status, "3");
    const another = await create();
    const Location = require("../src/services/location.service");
    const sync = Location.syncProvider;
    Location.syncProvider = async () => {
      throw new Error("Redis unavailable");
    };
    try {
      const accepted = await Service.accept(mobileOwner2, another.id, {
        providerId: mobile2.id,
      });
      assert.equal(accepted.status, "2");
    } finally {
      Location.syncProvider = sync;
    }
  });

  test("code collisions retry safely and durable notifications do not fail ticket creation when no provider is online", async () => {
    const first = await create();
    let injected = false;
    Ticket.addHook("beforeCreate", "code-collision", (record) => {
      if (!injected) {
        record.code = first.code;
        injected = true;
      }
    });
    let second;
    try {
      second = await create();
    } finally {
      Ticket.removeHook("beforeCreate", "code-collision");
    }
    assert.notEqual(first.code, second.code);
    assert.ok(
      await Notification.count({
        where: { ticketId: second.id, deliveredAt: null },
      }),
    );
    assert.equal(
      await Event.count({ where: { ticketId: second.id, action: "CREATED" } }),
      1,
    );
  });
  test("provider notification sockets receive urgent work and system chat messages only after commit", async () => {
    const socket = require("socket.io-client").io(base, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: {
        Origin: "http://localhost:5173",
        Cookie: `road_as_token=${mobileOwner.token}`,
      },
    });
    try {
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("connect_error", reject);
      });
      // Complete membership registration before creating the next job.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const urgent = new Promise((resolve) =>
        socket.on("dispatch-urgent", (data) => resolve(data)),
      );
      const t = await create();
      const message = await urgent;
      assert.ok(message.notificationId);
      assert.equal(message.type, "SOS");
      assert.equal(message.vehicleSnapshot, undefined);
      await accept(t);
      await new Promise((resolve) =>
        socket.emit(
          "chat:join",
          { scope: "DISPATCH", referenceId: t.id },
          resolve,
        ),
      );
      const system = new Promise((resolve) =>
        socket.once("chat:message", resolve),
      );
      await action(rider, t, "arrive");
      assert.equal((await system).senderRole, "SYSTEM");
    } finally {
      socket.close();
    }
  });

  test("a cancelled driver cannot evade exclusion by revoking and recreating the same kind of provider", async () => {
    const t = await create("tow");
    await accept(t, tow, towOwner);
    await action(towOwner, t, "cancel", { reason: "Driver cannot continue" });
    await tow.update({ status: "REVOKED", accepting: false });
    let replacement;
    try {
      const data = {
        ...tow.get(),
        id: randomUUID(),
        status: "ACTIVE",
        accepting: true,
      };
      delete data.createdAt;
      delete data.updatedAt;
      replacement = await Provider.create(data);
      await action(towOwner, t, "accept", { providerId: replacement.id }, 409);
      const feed = await request(
        towOwner,
        "GET",
        `/dispatch/provider-feed?providerId=${replacement.id}`,
      );
      assert.ok(!feed.some((job) => job.id === t.id));
    } finally {
      if (replacement) await replacement.destroy();
    }
  });
  test("a busy destination shop still receives and can decline its pending delivered intake without private rider data", async () => {
    const occupied = await create("walk-in");
    await accept(occupied, shop, shopper);
    await shop.update({ maxConcurrentJobs: 1 });
    try {
      const t = await create("tow", { dropoffShopId: shop.id });
      await accept(t, tow, towOwner);
      await action(towOwner, t, "arrive");
      await fund(t);
      await action(rider, t, "start");
      await action(rider, t, "resolve");
      const parent = await Ticket.findByPk(t.id);
      const child = await Ticket.findByPk(parent.childTicketId);
      const received = await Notification.findOne({
        where: { ticketId: child.id, recipientId: shopper.userId },
      });
      assert.ok(received);
      const detail = await request(shopper, "GET", `/dispatch/${child.id}`);
      assert.equal(detail.vehicleSnapshot, undefined);
      const list = await request(
        shopper,
        "GET",
        `/dispatch/provider-requests?providerId=${shop.id}&active=true`,
      );
      const intake = list.items.find((item) => item.id === child.id);
      assert.ok(intake);
      assert.equal(intake.userId, undefined);
      const rejected = await action(shopper, child, "decline", {
        reason: "Chưa có chỗ nhận xe",
      });
      assert.equal(rejected.status, "8");
      assert.equal(rejected.vehicleSnapshot, undefined);
    } finally {
      await shop.update({ maxConcurrentJobs: 20 });
    }
  });
}
