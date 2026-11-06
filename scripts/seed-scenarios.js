const { seed } = require('../src/seeds/scenario.seed');
if (require.main === module) seed().catch(error => {
  console.error('Scenario seed failed:', error.message);
  process.exitCode = 1;
}).finally(async () => {
  await require('../src/config/postgres.config').close();
  require('../src/config/redis.config').disconnect();
});
module.exports = { seed };
