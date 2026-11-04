// Isolated end-to-end fixture. Never imported by the application or production startup.
const { randomUUID } = require("node:crypto");
if (process.env.ROADASSIST_E2E !== "1")
  throw new Error("Explicit ROADASSIST_E2E=1 is required");
const suffix = randomUUID().replaceAll("-", "");
Object.assign(process.env, {
  NODE_ENV: "test",
  DB_SCHEMA: `browser_e2e_${suffix}`,
  PAYMENT_GATEWAY_MODE: "mock",
  PAYOUT_HOLD_DAYS: "0",
  JWT_SECRET: randomUUID() + randomUUID(),
  AUTH_REDIS_PREFIX: `e2e:${suffix}:auth:`,
  PROVIDER_REDIS_PREFIX: `e2e:${suffix}:providers:`,
  ALLOWED_CLIENT_URL_E2E: "http://localhost:5175",
  DB_FORCE_RESET: "false",
  DB_RESET: "false",
});
const { app } = require("../index");
const db = require("../src/config/postgres.config");
const redis = require("../src/config/redis.config");
const { User } = require("../src/models");
const Storage = require("../src/services/s3.service");
const storageConfig = require("../src/config/app.config").s3;
Object.assign(storageConfig, {
  accessKeyId: "browser-test",
  secretAccessKey: "browser-test",
  region: "ap-southeast-1",
  bucketName: "e2e-bucket",
  publicBaseUrl: "http://localhost:9899/__test/assets",
});
const objects = new Map();
Storage.uploadToS3 = async (params) => {
  objects.set(params.Key, {
    body: Buffer.from(params.Body),
    type: params.ContentType,
  });
  return { ETag: "browser-e2e" };
};
require("../src/config/s3.config").send = async (command) => {
  if (command.constructor.name === "DeleteObjectCommand") {
    objects.delete(command.input.Key);
    return {};
  }
  if (command.constructor.name === "DeleteObjectsCommand") {
    for (const item of command.input.Delete.Objects) objects.delete(item.Key);
    return {};
  }
  throw new Error("Unexpected S3 fixture operation");
};
const Mail = require("../src/services/mail.service");
const outbox = new Map();
Mail.sendRegistrationVerificationMail = async ({ to, code }) =>
  outbox.set(to, code);
Mail.sendPasswordResetMail = async ({ to, code }) => outbox.set(to, code);
const fixtureStart = app.router.stack.length;
app.get("/__test/mail", (req, res) =>
  res.json({ code: outbox.get(String(req.query.email)) || null }),
);
app.get("/__test/assets/*asset", (req, res) => {
  const value = objects.get(
    Array.isArray(req.params.asset)
      ? req.params.asset.join("/")
      : req.params.asset,
  );
  if (!value) return res.sendStatus(404);
  res.type(value.type || "image/webp").send(value.body);
});
// Fixture dataset for cursor pagination/reconnect tests. This file cannot run
// without ROADASSIST_E2E=1; writes are limited to this isolated DB schema.
const { protect, restrictTo } = require("../src/middlewares/auth.middleware");
app.post(
  "/__test/chat-history",
  protect,
  restrictTo("admin"),
  async (req, res) => {
    const { ChatRoom, ChatMessage } = require("../src/models");
    if (
      typeof req.body.roomId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(req.body.roomId)
    )
      return res.sendStatus(400);
    const room = await ChatRoom.findByPk(req.body.roomId);
    if (!room) return res.sendStatus(404);
    const now = Date.now();
    const messages = await ChatMessage.bulkCreate(
      Array.from({ length: 61 }, (_, index) => ({
        roomId: room.id,
        senderRole: "SYSTEM",
        content: `E2E pagination fixture ${now}-${index}`,
        createdAt: new Date(now + index),
        updatedAt: new Date(now + index),
      })),
    );
    const Chat = require("../src/services/chat.service");
    Chat.broadcast(
      app,
      room.scope,
      room.referenceId,
      Chat.dto(messages.at(-1)),
    );
    res.json({ count: messages.length });
  },
);
// Age an actual assignment for timer-driven rematch tests without a ten-minute wait.
// Only the isolated fixture imports this handler; domain reads/mutations stay real.
app.post(
  "/__test/dispatch-stall",
  protect,
  restrictTo("admin"),
  async (req, res) => {
    if (
      typeof req.body.ticketId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(req.body.ticketId)
    )
      return res.sendStatus(400);
    const { DispatchTicket } = require("../src/models");
    const ticket = await DispatchTicket.findByPk(req.body.ticketId);
    if (!ticket || ticket.status !== "2" || ticket.type === "WALK_IN")
      return res.sendStatus(409);
    await ticket.update({
      acceptedAt: new Date(Date.now() - 12 * 60000),
      lastProgressAt: new Date(Date.now() - 11 * 60000),
    });
    res.json({ aged: true });
  },
);
// Fixed-size PostgreSQL population for map limits/clustering tests. No fake API DTOs.
app.post("/__test/map-population", protect, restrictTo("admin"), async (req, res) => {
  const { Provider } = require("../src/models");
  const prefix = "map-load-";
  const existing = await User.count({ where: { email: { [require("sequelize").Op.like]: `${prefix}%@roadassist.test` } } });
  if (existing) return res.json({ count: existing });
  const password = (await User.unscoped().findOne({ where: { email: "admin@roadassist.test" }, attributes: ["password"] })).password;
  await db.transaction(async (transaction) => {
    const accounts = Array.from({ length: 1000 }, (_, index) => ({
      userId: randomUUID(), name: `Map Load Owner ${index}`, email: `${prefix}${index}@roadassist.test`,
      phone: `095${String(index).padStart(7, "0")}`, password,
      role: "provider", services: ["RIDER", "SHOP"], requestedServices: ["RIDER", "SHOP"],
      emailVerifiedAt: new Date(), onboarded: true,
    }));
    await User.bulkCreate(accounts, { transaction, hooks: false });
    await Provider.bulkCreate(accounts.map((account, index) => ({
      userId: account.userId, kind: "SHOP", name: `Map Load Shop ${index}`,
      phone: account.phone, address: "Nguyễn Huệ, TP.HCM", latitude: 10.7769 + (index % 25) * 0.0001,
      longitude: 106.7009 + Math.floor(index / 25) * 0.0001,
      status: "ACTIVE", accepting: true, capabilities: ["TYRE_REPAIR"], supportedVehicleTypes: ["BIKE"],
      serviceSegments: ["SOLO_BIKE"],
    })), { transaction, hooks: false });
  });
  res.json({ count: 1000 });
});
// index.js has a terminal 404 middleware. Mount fixture-only HTTP handlers before it.
const stack = app.router.stack;
const fixtureLayers = stack.splice(fixtureStart);
stack.splice(stack.length - 2, 0, ...fixtureLayers);
let server;
let io;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  if (io) await new Promise((resolve) => io.close(resolve));
  else if (server) await new Promise((resolve) => server.close(resolve));
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
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => close().then(() => process.exit(0)));
(async () => {
  await db.authenticate();
  await db.createSchema(process.env.DB_SCHEMA);
  await db.sync();
  await redis.connect();
  const password = "RoadAssist-e2e-123!";
  for (const [index, kind, role] of [
    [1, "admin", "admin"],
    [2, "rider", "guest"],
    [3, "provider", "guest"],
    [4, "tow", "guest"],
    [5, "voter1", "guest"],
    [6, "voter2", "guest"],
    [7, "voter3", "guest"],
    [8, "mobile", "guest"],
    [9, "altshop", "guest"],
  ]) {
    await User.create({
      name: `E2E ${kind}`,
      email: `${kind}@roadassist.test`,
      phone: `090700000${index}`,
      password,
      role,
      services: ["RIDER"],
      requestedServices: ["RIDER"],
      onboarded: role === "admin" || kind.startsWith("voter"),
      emailVerifiedAt: new Date(),
    });
  }
  server = require("node:http").createServer(app);
  io = require("../src/realtime/chat.socket")(server, app);
  server.listen(9899, "127.0.0.1", () =>
    console.log(
      `E2E backend ready on 9899; isolated schema ${process.env.DB_SCHEMA}`,
    ),
  );
})().catch(async (error) => {
  console.error(error);
  await close();
  process.exitCode = 1;
});
