const express = require("express");
const http = require("node:http");
const config = require("./src/config/app.config");
const sequelize = require("./src/config/postgres.config");
const redis = require("./src/config/redis.config");
const {
  runStartupDatabaseMigrations,
} = require("./src/config/database.migrations");
const { initJobs } = require("./src/jobs");
const { initCronJobs } = require("./src/jobs/cron");
const { NotFoundException } = require("./src/common/exceptions/BaseException");
require("./src/models");
const app = express();
const server = http.createServer(app);
let hazardIO;
app.set("trust proxy", config.app.trustProxy);
app.use(require("morgan")("dev"));
app.use(require("cors")({ origin: config.cors, credentials: true }));
app.use(
  "/api/v1/payments/sepay/webhook",
  express.json({
    limit: "64kb",
    verify(req, res, buffer) {
      req.rawBody = Buffer.from(buffer);
    },
  }),
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(require("cookie-parser")());
app.use(require("./src/middlewares/cookie_origin.middleware"));
app.get("/health", async (req, res) => {
  const [database, cache] = await Promise.allSettled([
    sequelize.authenticate(),
    redis.status === "ready"
      ? redis.ping()
      : Promise.reject(new Error("Redis not ready")),
  ]);
  const healthy =
    database.status === "fulfilled" && cache.status === "fulfilled";
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "Running" : "Degraded",
    app: config.app.name,
    version: config.app.version,
    env: config.app.env,
    database: database.status === "fulfilled" ? "Connected" : "Disconnected",
    redis: cache.status === "fulfilled" ? "Connected" : "Disconnected",
    uptime: process.uptime(),
  });
});
app.use("/api", require("./src/routes"));
const swaggerUi = require("swagger-ui-express");
app.use(
  "/api-docs",
  require("./src/middlewares/localhostOnly.middleware"),
  swaggerUi.serve,
  swaggerUi.setup(require("./src/swagger"), {
    swaggerOptions: { withCredentials: true },
  }),
);
app.use((req, res, next) => next(new NotFoundException()));
app.use(require("./src/middlewares/error.handler"));
async function startServer() {
  try {
    if (config.db.reset && config.db.force_reset)
      throw new Error("DB_RESET and DB_FORCE_RESET cannot both be enabled");
    if (config.db.reset)
      throw new Error(
        "DB_RESET is unsupported; use DB_FORCE_RESET for an explicit full reset",
      );
    require("./src/services/jwt.service").assertConfigured();
    require("./src/utils/auth_cookie.util").assertCookieConfig();
    require("./src/services/dispatch_policy.service").pricing();
    require("./src/services/sepay.service").assertConfig();
    require("./src/services/operations_config.service").assertConfigured();
    await sequelize.authenticate();
    await redis.connect();
    await redis.ping();
    await require("./src/config/provider.migrations").prepareProviderSchema(
      sequelize,
    );
    await sequelize.sync(
      config.db.force_reset ? { force: true } : { alter: true },
    );
    // Clear only this configured Redis database when an explicit full reset is requested.
    if (config.db.force_reset) await redis.flushdb();
    await runStartupDatabaseMigrations(sequelize);
    await require("./src/seeds/user.seed").seedUsers();
    await initJobs();
    await initCronJobs();
    hazardIO = require("./src/realtime/chat.socket")(server, app);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.app.port, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    console.log(
      `[SERVER]: ${config.app.name} (${config.app.version}) - ${config.app.env}`,
    );
    console.log(`[SERVER]: http://localhost:${config.app.port}/health`);
    return server;
  } catch (error) {
    await stopServer();
    throw error;
  }
}
async function stopServer() {
  await require("./src/jobs/cron").stopCronJobs();
  if (hazardIO) {
    await new Promise((resolve) => hazardIO.close(resolve));
    hazardIO = null;
  }
  const closing = server.listening
    ? new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    : Promise.resolve();
  server.closeIdleConnections();
  await closing;
  redis.disconnect();
  await sequelize.close();
}
if (require.main === module) {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () =>
      stopServer()
        .then(() => process.exit(0))
        .catch((error) => {
          console.error(error);
          process.exit(1);
        }),
    );
  }
  startServer().catch((error) => {
    console.error("Không thể khởi động Server:", error.message);
    process.exitCode = 1;
  });
}
module.exports = { app, server, startServer, stopServer };
