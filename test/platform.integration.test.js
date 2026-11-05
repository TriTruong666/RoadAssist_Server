const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
if (process.env.RUN_DB_TESTS !== "1")
  test(
    "Platform PostgreSQL/Redis integration (RUN_DB_TESTS=1)",
    { skip: true },
    () => {},
  );
else {
  const suffix = randomUUID().replaceAll("-", "");
  Object.assign(process.env, {
    NODE_ENV: "test",
    DB_SCHEMA: `platform_test_${suffix}`,
    PAYMENT_GATEWAY_MODE: "mock",
    JWT_SECRET: randomUUID() + randomUUID(),
    AUTH_REDIS_PREFIX: `test:${suffix}:auth:`,
  });
  const { app } = require("../index");
  const db = require("../src/config/postgres.config");
  const redis = require("../src/config/redis.config");
  const {
    User,
    Provider,
    Rating,
    AnnouncementReceipt,
    BillPayment,
    PaymentIntent,
    SepayReceipt,
  } = require("../src/models");
  const Ticket = require("./dispatch.fixture");
  const Auth = require("../src/services/auth.service");
  let server, base, rider, providerOwner, outsider, admin, profile, completed;
  const actor = async (index, role) => {
    const user = await User.create({
      email: `platform-${index}@example.com`,
      phone: `090123450${index}`,
      password: "Platform-test!123",
      name: `Platform ${index}`,
      role,
      emailVerifiedAt: new Date(),
    });
    const session = await Auth.issueSession(user, {});
    return { ...user.toJSON(), token: session.token };
  };
  async function request(user, method, path, body, status = 200) {
    const response = await fetch(base + "/api/v1" + path, {
      method,
      headers: {
        ...(user && { Cookie: `road_as_token=${user.token}` }),
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result.data;
  }
  before(async () => {
    await db.authenticate();
    await db.createSchema(process.env.DB_SCHEMA);
    await db.sync();
    await redis.connect();
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    rider = await actor(1, "guest");
    providerOwner = await actor(2, "provider");
    outsider = await actor(3, "guest");
    admin = await actor(4, "admin");
    profile = await Provider.create({
      userId: providerOwner.userId,
      kind: "SHOP",
      name: "Platform Shop",
      phone: "0901234567",
      address: "Test road",
      latitude: 10.77,
      longitude: 106.69,
      status: "ACTIVE",
      capabilities: ["TYRE_REPAIR"],
      supportedVehicleTypes: ["BIKE"],
    });
    providerOwner.token = (
      await Auth.issueSession(
        await User.findOne({ where: { userId: providerOwner.userId } }),
        {},
      )
    ).token;
    completed = await Ticket.create({
      userId: rider.userId,
      providerId: profile.id,
      status: "4",
      quoteAmount: "50000.00",
      resolvedAt: new Date(),
    });
  });
  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const keys = await redis.keys(`${process.env.AUTH_REDIS_PREFIX}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
    await db.dropSchema(process.env.DB_SCHEMA, { cascade: true });
    await db.close();
  });
  test("all platform administration endpoints reject guests and anonymous requests", async () => {
    for (const path of [
      "/admin/monitor?latitude=10.77&longitude=106.69",
      "/admin/providers",
      "/admin/flags",
      "/admin/dispatch",
      "/admin/stats",
      "/admin/settings",
      "/admin/announcements",
      "/admin/alerts",
    ]) {
      await request(null, "GET", path, undefined, 401);
      await request(rider, "GET", path, undefined, 403);
    }
    const monitor = await request(
      admin,
      "GET",
      "/admin/monitor?latitude=10.77&longitude=106.69",
    );
    assert.ok(Array.isArray(monitor.providers));
    assert.ok(Array.isArray(monitor.hazards));
    assert.ok(Array.isArray(monitor.dispatches));
    const stats = await request(admin, "GET", "/admin/stats");
    assert.equal(stats.users, 4);
  });
  test("ratings require completed participation, upsert atomically, and only target may reply", async () => {
    await request(
      outsider,
      "POST",
      "/ratings",
      { ticketId: completed.id, stars: 5 },
      403,
    );
    const pending = await Ticket.create({
      userId: rider.userId,
      providerId: profile.id,
      status: "9",
    });
    await request(
      rider,
      "POST",
      "/ratings",
      { ticketId: pending.id, stars: 4 },
      409,
    );
    await request(
      rider,
      "POST",
      "/ratings",
      { ticketId: completed.id, stars: 6 },
      400,
    );
    const reviews = await Promise.all(
      [4, 3].map((stars) =>
        request(rider, "POST", "/ratings", {
          ticketId: completed.id,
          stars,
          content: "Review",
        }),
      ),
    );
    assert.equal(reviews[0].id, reviews[1].id);
    assert.equal(await Rating.count(), 1);
    await request(providerOwner, "POST", "/ratings", {
      ticketId: completed.id,
      stars: 5,
      content: "Rider review",
    });
    assert.equal(await Rating.count(), 2);
    await request(
      outsider,
      "POST",
      `/ratings/${reviews[0].id}/reply`,
      { content: "Not authorized" },
      403,
    );
    await request(providerOwner, "POST", `/ratings/${reviews[0].id}/reply`, {
      content: "Thank you",
    });
    const publicReviews = await request(
      null,
      "GET",
      `/ratings/provider/${profile.id}`,
    );
    assert.equal(publicReviews.total, 1);
    assert.equal(publicReviews.items[0].replyContent, "Thank you");
    assert.equal(publicReviews.items[0].targetUserId, undefined);
    assert.equal(publicReviews.items[0].authorId, undefined);
    assert.equal(Number((await profile.reload()).ratingCount), 1);
  });
  test("broadcast targets snapshot recipients and counts real feed delivery/read without duplicates", async () => {
    const note = await request(
      admin,
      "POST",
      "/admin/announcements",
      {
        title: "Provider notice",
        content: "Safety notice",
        target: "PROVIDER",
        priority: "CRITICAL",
      },
      201,
    );
    assert.equal(note.recipientCount, 1);
    assert.equal((await request(rider, "GET", "/notifications")).total, 0);
    assert.equal(
      (await request(providerOwner, "GET", "/notifications")).items[0].id,
      note.id,
    );
    await request(providerOwner, "GET", "/notifications");
    await request(rider, "POST", `/notifications/${note.id}/read`, {}, 404);
    await request(providerOwner, "POST", `/notifications/${note.id}/read`, {});
    const history = await request(admin, "GET", "/admin/announcements");
    assert.equal(history.items[0].deliveredCount, 1);
    assert.equal(history.items[0].readCount, 1);
    assert.equal(await AnnouncementReceipt.count(), 1);
  });
  test("settings whitelist bounds, revisions, persistence and effective runtime values", async () => {
    const initial = await request(admin, "GET", "/admin/settings");
    assert.equal(initial.paymentMode, "mock");
    await request(
      admin,
      "PUT",
      "/admin/settings",
      {
        revision: initial.revision,
        values: { sepay: { webhookToken: "must-not-change" } },
      },
      400,
    );
    await request(
      admin,
      "PUT",
      "/admin/settings",
      {
        revision: initial.revision,
        values: { operations: { maxRematches: -1 } },
      },
      400,
    );
    const updated = await request(admin, "PUT", "/admin/settings", {
      revision: initial.revision,
      values: { operations: { maxRematches: 4 } },
    });
    assert.equal(updated.values.operations.maxRematches, 4);
    assert.equal(
      require("../src/config/app.config").operations.maxRematches,
      4,
    );
    await request(
      admin,
      "PUT",
      "/admin/settings",
      {
        revision: initial.revision,
        values: { operations: { maxRematches: 5 } },
      },
      409,
    );
    assert.equal(
      (await request(admin, "GET", "/admin/settings")).revision,
      updated.revision,
    );
  });
  test("mock SePay uses the actual receipt/escrow ledger; concurrent replay cannot duplicate funding", async () => {
    const bill = await db.transaction((transaction) =>
      require("../src/services/bill.service").syncJourney(
        completed.journeyId,
        transaction,
      ),
    );
    const intent = await request(
      rider,
      "POST",
      "/payments/create-sepay-qr",
      { billId: bill.id, clientRequestId: randomUUID() },
      201,
    );
    assert.equal(intent.mode, "mock");
    assert.equal(intent.bank.qrUrl, null);
    await request(
      outsider,
      "POST",
      `/payments/${intent.id}/mock-transfer`,
      {},
      404,
    );
    await Promise.all(
      [1, 2].map(() =>
        request(rider, "POST", `/payments/${intent.id}/mock-transfer`, {}),
      ),
    );
    assert.equal(await SepayReceipt.count(), 1);
    const payments = await BillPayment.findAll({
      where: { intentId: intent.id },
    });
    assert.equal(
      payments.reduce((sum, p) => sum + Number(p.appliedAmount), 0),
      Number(intent.amount),
    );
    assert.equal(
      Number((await PaymentIntent.findByPk(intent.id)).receivedAmount),
      Number(intent.amount),
    );
    assert.ok(
      ["HELD", "CONFIRMED"].includes(
        (await PaymentIntent.findByPk(intent.id)).status,
      ),
    );
    const config = require("../src/config/app.config");
    config.sepay.mode = "live";
    try {
      await request(
        rider,
        "POST",
        `/payments/${intent.id}/mock-transfer`,
        {},
        403,
      );
    } finally {
      config.sepay.mode = "mock";
    }
  });
  test("device delivery is owner-scoped and idempotent per registered browser", async () => {
    const first = randomUUID(),
      second = randomUUID();
    await request(
      null,
      "POST",
      "/users/devices",
      { clientDeviceId: first, name: "Browser" },
      401,
    );
    await request(
      rider,
      "POST",
      "/users/devices",
      { clientDeviceId: "bad", name: "Browser" },
      400,
    );
    const device = await request(rider, "POST", "/users/devices", {
      clientDeviceId: first,
      name: "Browser A",
    });
    const repeat = await request(rider, "POST", "/users/devices", {
      clientDeviceId: first,
      name: "Browser A renamed",
    });
    assert.equal(device.id, repeat.id);
    await request(rider, "POST", "/users/devices", {
      clientDeviceId: second,
      name: "Browser B",
    });
    assert.equal((await request(rider, "GET", "/users/devices")).length, 2);
    assert.equal((await request(outsider, "GET", "/users/devices")).length, 0);
    const note = await request(
      admin,
      "POST",
      "/admin/announcements",
      {
        title: "Device notice",
        content: "Delivery test",
        target: "RIDER",
        priority: "NORMAL",
      },
      201,
    );
    await request(outsider, "GET", `/notifications?deviceId=${first}`);
    await Promise.all(
      [1, 2].map(() =>
        request(rider, "GET", `/notifications?deviceId=${first}`),
      ),
    );
    await request(rider, "GET", `/notifications?deviceId=${second}`);
    const history = await request(admin, "GET", "/admin/announcements");
    const item = history.items.find((row) => row.id === note.id);
    assert.equal(item.deliveredCount, 2);
    assert.equal(item.deliveredDeviceCount, 2);
  });
  test("payout bank preferences validate input, isolate owners and append an audit event", async () => {
    const account = {
      bankCode: "VCB",
      accountNumber: "001234567890",
      accountName: "NGUYEN VAN AN",
    };
    await request(null, "PUT", "/users/payout-account", account, 401);
    await request(
      rider,
      "PUT",
      "/users/payout-account",
      { ...account, accountNumber: "invalid" },
      400,
    );
    await request(rider, "PUT", "/users/payout-account", {
      ...account,
      userId: outsider.userId,
    });
    assert.equal(
      (await request(rider, "GET", "/users/payout-account")).account
        .accountNumber,
      account.accountNumber,
    );
    assert.equal(
      (await request(outsider, "GET", "/users/payout-account")).account,
      null,
    );
    await request(rider, "PUT", "/users/payout-account", {
      ...account,
      accountNumber: "009876543210",
    });
    const events = await require("../src/models").FinanceEvent.findAll({
      where: { actorId: rider.userId, action: "PAYOUT_ACCOUNT_UPDATED" },
      order: [["createdAt", "ASC"]],
    });
    assert.equal(events.length, 2);
    assert.equal(events[1].details.before.accountNumber, account.accountNumber);
    assert.equal(events[1].details.after.accountNumber, "009876543210");
  });
  test("dispute transcript requires admin and exposes only the disputed rescue room versions", async () => {
    const { Dispute, ChatRoom, ChatMessage } = require("../src/models");
    const dispute = await Dispute.create({
      ticketId: completed.id,
      journeyId: completed.journeyId,
      claimantId: rider.userId,
      respondentId: providerOwner.userId,
      providerUserId: providerOwner.userId,
      reason: "OTHER",
      note: "Inspect chat",
      fingerprint: "a".repeat(64),
      responseDueAt: new Date(Date.now() + 86400000),
    });
    const old = await ChatRoom.create({
      scope: "DISPATCH",
      referenceId: completed.id,
      version: 1,
      isArchived: true,
    });
    const current = await ChatRoom.create({
      scope: "DISPATCH",
      referenceId: completed.id,
      version: 2,
    });
    const foreign = await ChatRoom.create({
      scope: "DISPATCH",
      referenceId: randomUUID(),
      version: 1,
    });
    for (const [room, content] of [
      [old, "Archived evidence"],
      [current, "Current evidence"],
      [foreign, "Private unrelated rescue"],
    ])
      await ChatMessage.create({
        roomId: room.id,
        senderId: rider.userId,
        senderRole: "RIDER",
        content,
      });
    await request(
      null,
      "GET",
      `/admin/disputes/${dispute.id}/chat`,
      undefined,
      401,
    );
    await request(
      rider,
      "GET",
      `/admin/disputes/${dispute.id}/chat`,
      undefined,
      403,
    );
    const latest = await request(
      admin,
      "GET",
      `/admin/disputes/${dispute.id}/chat`,
    );
    assert.equal(latest.rooms.length, 2);
    assert.equal(latest.items[0].content, "Current evidence");
    assert.equal(latest.items[0].senderId, undefined);
    const archived = await request(
      admin,
      "GET",
      `/admin/disputes/${dispute.id}/chat?version=1&limit=1&offset=0`,
    );
    assert.equal(archived.total, 1);
    assert.equal(archived.items[0].content, "Archived evidence");
    assert.equal(
      (
        await request(
          admin,
          "GET",
          `/admin/disputes/${dispute.id}/chat?version=99`,
        )
      ).total,
      0,
    );
  });
  test("admin alerts snapshot recipients, survive reconnect, deduplicate and isolate read acknowledgements", async () => {
    const Alerts = require("../src/services/admin_alert.service");
    const { AdminAlert, FinanceNotice } = require("../src/models");
    const secondAdmin = await actor(6, "admin");
    const referenceId = randomUUID();
    await db.transaction(async (transaction) => {
      await Alerts.enqueue(
        "HAZARD_CONFIRMED",
        referenceId,
        referenceId,
        "Community confirmation",
        transaction,
      );
      await Alerts.enqueue(
        "HAZARD_CONFIRMED",
        referenceId,
        referenceId,
        "Duplicate must not replace content",
        transaction,
      );
    });
    assert.equal(await AdminAlert.count({ where: { referenceId } }), 2);
    assert.equal(
      await FinanceNotice.count({
        where: { event: "operations-alert", payload: { referenceId } },
      }),
      2,
    );
    const mine = await request(admin, "GET", "/admin/alerts?limit=100");
    const alert = mine.items.find((item) => item.referenceId === referenceId);
    assert.ok(alert);
    assert.equal(alert.userId, undefined);
    assert.equal(alert.occurrenceKey, undefined);
    assert.equal(alert.href, `/dashboard/hazards?id=${referenceId}`);
    assert.equal(alert.message, "Community confirmation");
    await request(rider, "POST", `/admin/alerts/${alert.id}/read`, {}, 403);
    await request(
      secondAdmin,
      "POST",
      `/admin/alerts/${alert.id}/read`,
      {},
      404,
    );
    await request(admin, "POST", "/admin/alerts/invalid/read", {}, 400);
    const acknowledged = await request(
      admin,
      "POST",
      `/admin/alerts/${alert.id}/read`,
      {},
    );
    assert.ok(acknowledged.readAt);
    assert.equal(
      (await request(admin, "POST", `/admin/alerts/${alert.id}/read`, {}))
        .readAt,
      acknowledged.readAt,
    );
    const reconnected = await request(admin, "GET", "/admin/alerts?limit=100");
    assert.equal(reconnected.unreadCount, mine.unreadCount - 1);
    assert.equal(
      reconnected.items.find((item) => item.id === alert.id).readAt,
      acknowledged.readAt,
    );
    assert.equal(
      (await request(secondAdmin, "GET", "/admin/alerts?limit=100")).items.find(
        (item) => item.referenceId === referenceId,
      ).readAt,
      null,
    );
    const rollbackReference = randomUUID();
    await assert.rejects(
      db.transaction(async (transaction) => {
        await Alerts.enqueue(
          "DISPUTE_OPENED",
          rollbackReference,
          rollbackReference,
          "Rollback",
          transaction,
        );
        throw new Error("Intentional rollback");
      }),
      /Intentional rollback/,
    );
    assert.equal(
      await AdminAlert.count({ where: { referenceId: rollbackReference } }),
      0,
    );
    assert.equal(
      await FinanceNotice.count({
        where: {
          event: "operations-alert",
          payload: { referenceId: rollbackReference },
        },
      }),
      0,
    );
  });
  test("denied or revoked applications preserve completed setup without granting provider privileges", async () => {
    const applicant = await actor(5, "guest");
    const user = await User.findOne({ where: { userId: applicant.userId } });
    await user.update({
      onboarded: true,
      requestedServices: ["RIDER", "SHOP"],
    });
    assert.equal(
      (await request(applicant, "GET", "/users/me")).setup.required,
      false,
    );
    const application = await Provider.create({
      userId: applicant.userId,
      kind: "SHOP",
      name: "Denied application",
      phone: "0901234505",
      address: "Test road",
      latitude: 10.77,
      longitude: 106.69,
      status: "DENIED",
      denialReason: "Missing evidence",
      capabilities: ["TYRE_REPAIR"],
      supportedVehicleTypes: ["BIKE"],
    });
    for (const status of ["DENIED", "REVOKED"]) {
      if (status !== application.status) await application.update({ status });
      const session = await request(applicant, "GET", "/users/me");
      assert.equal(session.setup.required, false);
      assert.deepEqual(session.setup.providerKinds, []);
      assert.equal(session.role, "guest");
      await request(
        applicant,
        "POST",
        `/providers/${application.id}/toggle-duty`,
        { accepting: true },
        403,
      );
    }
    await user.update({ requestedServices: ["RIDER", "SHOP", "TOW"] });
    assert.equal(
      (await request(applicant, "GET", "/users/me")).setup.required,
      false,
    );
    await user.update({
      onboarded: false,
      requestedServices: ["RIDER", "SHOP"],
    });
    assert.equal(
      (await request(applicant, "GET", "/users/me")).setup.required,
      true,
    );
  });
}
