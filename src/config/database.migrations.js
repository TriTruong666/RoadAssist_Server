const { Op } = require("sequelize");
async function runStartupDatabaseMigrations(sequelize) {
  const q = sequelize.getQueryInterface().queryGenerator;
  const billTable = q.quoteTable(sequelize.models.Bill.getTableName());
  const ticketTable = q.quoteTable(sequelize.models.DispatchTicket.getTableName());
  await sequelize.query(`UPDATE ${billTable} b SET ticket_id = (SELECT MIN(t.id::text)::uuid FROM ${ticketTable} t WHERE t.journey_id=b.journey_id) WHERE b.ticket_id IS NULL AND (SELECT COUNT(*) FROM ${ticketTable} t WHERE t.journey_id=b.journey_id)=1`);
  await require("./operations.migrations")(sequelize);
  while (await require("./chat.migrations").migrateHazardChat()) {
    /* bounded migration batches */
  }
  await require("./provider.migrations").reconcileProviderData(sequelize);
  const User = sequelize.models.User;
  if (!User) return;
  const ProviderAccess = require("../services/provider_access.service");
  const users = await User.findAll({
    where: { services: { [Op.ne]: ["RIDER"] } },
  });
  for (const candidate of users) {
    await sequelize.transaction(async (transaction) => {
      const user = await User.findByPk(candidate.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const requestedServices = [
        ...new Set(["RIDER", ...user.requestedServices, ...user.services]),
      ];
      await user.update({ requestedServices }, { transaction });
      await ProviderAccess.synchronize(user, transaction);
    });
  }
}
module.exports = { runStartupDatabaseMigrations };
