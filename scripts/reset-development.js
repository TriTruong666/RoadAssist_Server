// Explicit, one-shot reset. Never leave DB_FORCE_RESET enabled in an env file.
const config = require("../src/config/app.config");
const db = require("../src/config/postgres.config");
const redis = require("../src/config/redis.config");
require("../src/models");

async function reset() {
  if (config.app.env !== "development" || config.app.isProduction)
    throw new Error("Database reset is restricted to development");
  await db.authenticate();
  await redis.connect();
  await require("../src/config/provider.migrations").prepareProviderSchema(db);
  await db.sync({ force: true });
  await redis.flushdb();
  await require("../src/config/database.migrations").runStartupDatabaseMigrations(
    db,
  );
  await require("../src/seeds/user.seed").seedUsers();
  const users = await require("../src/models").User.findAll({
    attributes: ["email", "role", "onboarded"],
  });
  if (users.length !== 1 || users[0].role !== "admin")
    throw new Error("Reset verification failed: expected exactly one admin");
  console.log(
    JSON.stringify({
      reset: true,
      users: users.map((user) => user.toJSON()),
      demoData: false,
    }),
  );
}

reset()
  .catch((error) => {
    console.error("Development reset failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    redis.disconnect();
    await db.close();
  });
