const { Op } = require("sequelize");
async function runStartupDatabaseMigrations(sequelize) {
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
