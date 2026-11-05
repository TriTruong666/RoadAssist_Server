// Manual command; startup imports the seed module without closing server resources.
const { seed } = require("../src/seeds/demo.seed");
if (require.main === module)
  seed()
    .catch((error) => {
      console.error("Demo seed failed:", error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await require("../src/config/postgres.config").close();
      require("../src/config/redis.config").disconnect();
    });
module.exports = { seed };
