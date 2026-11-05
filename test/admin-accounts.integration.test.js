const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
if (process.env.RUN_DB_TESTS !== "1")
  test("Admin accounts integration (RUN_DB_TESTS=1)", { skip: true }, () => {});
else {
  const suffix = randomUUID().replaceAll("-", "");
  Object.assign(process.env, {
    NODE_ENV: "test",
    DB_SCHEMA: `accounts_test_${suffix}`,
    AUTH_REDIS_PREFIX: `accounts-test:${suffix}:auth:`,
    PROVIDER_REDIS_PREFIX: `accounts-test:${suffix}:providers:`,
    JWT_SECRET: randomUUID() + randomUUID(),
    DB_FORCE_RESET: "false",
    DB_RESET: "false",
  });
  const { app } = require("../index");
  const db = require("../src/config/postgres.config");
  const redis = require("../src/config/redis.config");
  const { User } = require("../src/models");
  const Auth = require("../src/services/auth.service");
  test("admin accounts enforce access, safe DTOs, global sorting/pagination, disabled creation and session invalidation on suspension", async () => {
    let server;
    try {
      await db.authenticate();
      await db.createSchema(process.env.DB_SCHEMA);
      await db.sync();
      await redis.connect();
      const password = "Account-test-password!";
      const admin = await User.create({
        name: "Admin",
        email: "admin@accounts.test",
        phone: "0900000001",
        password,
        role: "admin",
        onboarded: true,
        emailVerifiedAt: new Date(),
      });
      const session = await Auth.issueSession(admin, {});
      server = require("node:http").createServer(app);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}/api/v1`;
      async function request(
        path,
        method = "GET",
        body,
        token = session.token,
      ) {
        const response = await fetch(base + path, {
          method,
          headers: {
            ...(token && { Cookie: `road_as_token=${token}` }),
            ...(body && { "Content-Type": "application/json" }),
          },
          ...(body && { body: JSON.stringify(body) }),
        });
        return { status: response.status, json: await response.json() };
      }
      assert.equal(
        (await request("/admin/accounts", "GET", undefined, null)).status,
        401,
      );
      const users = [];
      for (let i = 0; i < 12; i++) {
        const created = await User.create({ name: `Customer ${i}`, email: `customer-${i}@accounts.test`, phone: `09100000${String(i).padStart(2, "0")}`, password, role: "guest", onboarded: false, emailVerifiedAt: new Date() });
        users.push(created.toJSON());
      }
      const customer = await User.findOne({
        where: { userId: users[0].userId },
      });
      assert.deepEqual(customer.services, ["RIDER"]);
      assert.equal(await customer.comparePassword(password), true);
      const customerSession = await Auth.issueSession(customer, {});
      assert.equal(customerSession.user.approved, false);
      assert.equal((await request(`/admin/accounts/${customer.userId}`, "PUT", { approved: true })).status, 409);
      await customer.update({ onboarded: true });
      const approvedAccount = await request(`/admin/accounts/${customer.userId}`, "PUT", { approved: true });
      assert.equal(approvedAccount.status, 200);
      assert.equal(approvedAccount.json.data.approved, true);
      assert.equal((await request("/users/me", "GET", undefined, customerSession.token)).json.data.approved, true);
      for (const [path, method, body] of [
        ["/admin/accounts", "GET"],
        [`/admin/accounts/${admin.userId}`, "GET"],
        [`/admin/accounts/${admin.userId}`, "PUT", { name: "Unauthorized" }],
      ])
        assert.equal(
          (await request(path, method, body, customerSession.token)).status,
          403,
        );
      assert.equal((await request("/admin/accounts", "POST", { name: "Not allowed" })).status, 404);
      const first = (await request("/admin/accounts?limit=10&page=1")).json
        .data;
      const second = (await request("/admin/accounts?limit=10&page=2")).json
        .data;
      assert.equal(first.total, 13);
      assert.equal(first.items.length, 10);
      assert.equal(second.items.length, 3);
      assert.equal(
        new Set([...first.items, ...second.items].map((user) => user.userId))
          .size,
        13,
      );
      assert.equal(
        (await request("/admin/accounts?role=admin")).json.data.total,
        1,
      );
      assert.equal(
        (await request("/admin/accounts?search=customer-10")).json.data.total,
        1,
      );
      assert.equal(
        (await request("/admin/accounts?search=%25")).json.data.total,
        0,
      );
      const serialized = JSON.stringify(first);
      for (const key of [
        "password",
        "tokenHash",
        "loginIp",
        "sessionVersion",
        "webPushToken",
      ])
        assert.ok(!serialized.includes(key));
      app.set("chatIO", {
        fetchSockets: async () => [
          { rooms: new Set([`user:${customer.userId}`]) },
        ],
      });
      const online = (await request("/admin/accounts?sort=by_status&limit=1"))
        .json.data.items[0];
      assert.equal(online.userId, customer.userId);
      assert.equal(online.isOnline, true);
      assert.equal(
        (await request(`/admin/accounts/${randomUUID()}`)).status,
        404,
      );
      assert.equal(
        (
          await request(`/admin/accounts/${admin.userId}`, "PUT", {
            status: "BANNED",
          })
        ).status,
        403,
      );
      const updated = await request(
        `/admin/accounts/${customer.userId}`,
        "PUT",
        {
          name: "Renamed",
          status: "INACTIVE",
          role: "admin",
          services: ["TOW"],
        },
      );
      assert.equal(updated.status, 200);
      assert.equal(updated.json.data.role, "guest");
      assert.equal(updated.json.data.name, "Renamed");
      assert.equal(
        (await request("/users/me", "GET", undefined, customerSession.token))
          .status,
        401,
      );
      assert.equal(
        (
          await request(`/admin/accounts/${customer.userId}`, "PUT", {
            status: "ACTIVE",
          })
        ).status,
        200,
      );
      assert.equal(
        (await request("/users/me", "GET", undefined, customerSession.token))
          .status,
        401,
      );
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
          `accounts-test:${suffix}:*`,
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
