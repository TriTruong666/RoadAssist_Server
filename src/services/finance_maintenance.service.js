const { Op } = require("sequelize");
const { PaymentIntent: Intent, Bill } = require("../models");
const Bills = require("./bill.service");
const Locks = require("./finance_lock.service");
module.exports = async () => {
  await Bills.backfill();
  const intents = await Intent.findAll({
    where: {
      method: "SEPAY",
      status: "PENDING",
      expiresAt: { [Op.lte]: new Date() },
    },
    attributes: ["billId"],
    limit: 100,
  });
  const ids = [...new Set(intents.map((i) => i.billId))];
  for (const id of ids) {
    const bill = await Bill.findByPk(id);
    if (bill)
      await Locks.journey(bill.journeyId, null, (transaction) =>
        Bills.syncJourney(bill.journeyId, transaction),
      );
  }
};
