const { Op } = require("sequelize");
const db = require("../config/postgres.config");
const Money = require("../utils/money.util");
const Policy = require("./dispatch_policy.service");
module.exports = {
  async fundedForApproval(ticket, transaction) {
    await require("./bill.service").syncJourney(ticket.journeyId, transaction, { ticketOverride: ticket });
    const due = Money.cents(ticket.totalAmount);
    if (!due) return;
    const { Bill, BillItem, BillPayment } = db.models;
    if (!Bill || !BillItem || !BillPayment)
      Policy.fail(
        "PAYMENT_UNFUNDED_FOR_APPROVAL",
        "Chưa có dữ liệu thanh toán bảo đảm cho báo giá",
        403,
      );
    const bills = await Bill.findAll({
      where: {
        journeyId: ticket.journeyId,
        userId: ticket.userId,
        status: { [Op.ne]: "VOID" },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const bill of bills) {
      const allItems = await BillItem.findAll({
        where: { billId: bill.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const items = allItems.filter((i) => i.ticketId === ticket.id);
      if (!items.length) continue;
      const ids = items.map((i) => i.id);
      const oneTicket = allItems.every((i) => i.ticketId === ticket.id);
      const payments = await BillPayment.findAll({
        where: {
          billId: bill.id,
          providerId: ticket.providerId,
          [Op.or]: [
            { billItemId: { [Op.in]: ids } },
            ...(oneTicket ? [{ billItemId: null }] : []),
          ],
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const eligible = payments.filter((p) =>
        p.method === "SEPAY"
          ? ["HELD", "CONFIRMED"].includes(p.status)
          : p.method === "CASH" && ["PENDING", "CONFIRMED"].includes(p.status),
      );
      const covered = eligible.reduce(
        (sum, p) => sum + Money.cents(p.appliedAmount),
        0,
      );
      const scoped = items.reduce((sum, i) => sum + Money.cents(i.amount), 0);
      if (covered >= due && scoped >= due) return;
    }
    Policy.fail(
      "PAYMENT_UNFUNDED_FOR_APPROVAL",
      "Thanh toán chưa đủ hoặc không thuộc báo giá và đối tác hiện tại",
      403,
    );
  },
};
