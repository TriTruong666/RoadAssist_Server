const { Op, literal } = require("sequelize");
module.exports = async (db) => {
  const { BillItem, BillPayment, DispatchTicket: Ticket } = db.models;
  const q = db.getQueryInterface().queryGenerator;
  const item = q.quoteTable(BillItem.getTableName()),
    pay = q.quoteTable(BillPayment.getTableName());
  await db.query(
    `UPDATE ${item} AS item SET cash_committed_at = (SELECT MIN(p."createdAt") FROM ${pay} AS p WHERE p.bill_item_id=item.id AND p.method='CASH') WHERE item.cash_committed_at IS NULL AND EXISTS (SELECT 1 FROM ${pay} AS p WHERE p.bill_item_id=item.id AND p.method='CASH')`,
  );
  const c = require("./app.config").operations;
  await Ticket.update(
    { handoverRequired: true },
    {
      where: {
        type: "TOW",
        handoverRequired: false,
        status: { [Op.in]: ["1", "13", "14", "2", "3", "6"] },
      },
    },
  );
  await Ticket.update(
    {
      queueExpiresAt: literal(
        `"createdAt" + INTERVAL '${c.queueTtlMinutes} minutes'`,
      ),
    },
    {
      where: {
        queueExpiresAt: null,
        providerId: null,
        status: { [Op.in]: ["1", "13", "14"] },
      },
    },
  );
  await Ticket.update(
    {
      arrivalDueAt: literal(
        `accepted_at + INTERVAL '${c.arrivalTimeoutMinutes} minutes'`,
      ),
      lastProgressAt: literal("accepted_at"),
      lastProgressDistanceMeters: literal("assignment_distance_meters"),
    },
    {
      where: {
        arrivalDueAt: null,
        acceptedAt: { [Op.ne]: null },
        status: "2",
        type: { [Op.in]: ["SOS", "TOW"] },
      },
    },
  );
};
