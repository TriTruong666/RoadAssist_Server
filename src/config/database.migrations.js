// RoadAssist-only migrations. Legacy WMS migrations must never run here.
const migrations = [];
async function runStartupDatabaseMigrations(sequelize) {
  for (const migration of migrations) await migration.up(sequelize);
}
module.exports = { runStartupDatabaseMigrations };
