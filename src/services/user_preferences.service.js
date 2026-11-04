const db = require("../config/postgres.config");
const { UserDevice, PayoutAccount, FinanceEvent } = require("../models");
const Vehicles = require("./vehicle.service");
const fail = require("./dispatch_policy.service").fail;
module.exports = {
  async device(actor, input, userAgent) {
    return db.transaction(async (transaction) => {
      await Vehicles.lockUser(actor.userId, transaction);
      const where = {
        userId: actor.userId,
        clientDeviceId: input.clientDeviceId,
      };
      const row = await UserDevice.findOne({ where, transaction });
      const data = {
        ...where,
        name: input.name,
        userAgent: (userAgent || "").slice(0, 512),
        lastSeenAt: new Date(),
      };
      if (row) return row.update(data, { transaction });
      if (
        (await UserDevice.count({
          where: { userId: actor.userId },
          transaction,
        })) >= 20
      )
        fail("DEVICE_LIMIT", "Tối đa 20 trình duyệt đã đăng ký", 409);
      return UserDevice.create(data, { transaction });
    });
  },
  devices(actor) {
    return UserDevice.findAll({
      where: { userId: actor.userId },
      attributes: ["id", "name", "lastSeenAt", "createdAt"],
      order: [["lastSeenAt", "DESC"]],
    });
  },
  async account(actor) {
    return { account: await PayoutAccount.findByPk(actor.userId) };
  },
  async saveAccount(actor, data) {
    return db.transaction(async (transaction) => {
      await Vehicles.lockUser(actor.userId, transaction);
      const previous = await PayoutAccount.findByPk(actor.userId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const before = previous?.toJSON() || null;
      const row = previous
        ? await previous.update(data, { transaction })
        : await PayoutAccount.create(
            { ...data, userId: actor.userId },
            { transaction },
          );
      await FinanceEvent.create(
        {
          actorId: actor.userId,
          action: "PAYOUT_ACCOUNT_UPDATED",
          referenceId: actor.userId,
          details: { before, after: row.toJSON() },
        },
        { transaction },
      );
      return { account: row };
    });
  },
};
