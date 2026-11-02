const { Op } = require("sequelize");
const {
  Bill,
  BillItem: Item,
  BillPayment: Pay,
  DispatchTicket: Ticket,
  User,
} = require("../models");
const Money = require("../utils/money.util");
const config = require("../config/app.config").operations;
const Policy = require("./dispatch_policy.service");
class CashEligibility {
  static async describe(userId, transaction) {
    const bills = await Bill.findAll({
      where: { userId },
      attributes: ["id"],
      transaction,
    });
    const items = await Item.findAll({
      where: {
        billId: { [Op.in]: bills.map((b) => b.id) },
        cashCommittedAt: { [Op.ne]: null },
        amount: { [Op.gt]: 0 },
      },
      transaction,
    });
    const tickets = await Ticket.findAll({
      where: {
        id: { [Op.in]: items.map((i) => i.ticketId) },
        status: { [Op.in]: ["4", "12"] },
        resolvedAt: { [Op.ne]: null },
      },
      transaction,
    });
    const amounts = [];
    for (const ticket of tickets) {
      let due = 0;
      let billId;
      for (const item of items.filter((i) => i.ticketId === ticket.id)) {
        billId = item.billId;
        const payments = await Pay.findAll({
          where: {
            billItemId: item.id,
            providerId: item.providerId,
            status: { [Op.in]: ["HELD", "CONFIRMED"] },
          },
          transaction,
        });
        due += Math.max(
          0,
          Money.cents(item.amount) -
            payments.reduce((n, p) => n + Money.cents(p.appliedAmount), 0),
        );
      }
      if (due)
        amounts.push({
          ticketId: ticket.id,
          billId,
          amount: Money.amount(due),
          dueAt: new Date(+ticket.resolvedAt + config.cashGraceHours * 3600000),
          overdue:
            Date.now() >= +ticket.resolvedAt + config.cashGraceHours * 3600000,
        });
    }
    const overdue = amounts.filter((a) => a.overdue);
    return {
      eligible:
        overdue.length === 0 && amounts.length < config.cashMaxUnpaidTickets,
      onlineAllowed: true,
      graceHours: config.cashGraceHours,
      maxUnpaidCompletedRequests: config.cashMaxUnpaidTickets,
      unpaidCompletedRequests: amounts.length,
      unpaidAmount: Money.amount(
        amounts.reduce((n, a) => n + Money.cents(a.amount), 0),
      ),
      overdueAmount: Money.amount(
        overdue.reduce((n, a) => n + Money.cents(a.amount), 0),
      ),
      tickets: amounts,
    };
  }
  static async assert(userId, transaction) {
    const result = await this.describe(userId, transaction);
    if (!result.eligible)
      Policy.fail(
        "CASH_OVERDUE_BALANCE",
        "Cần thanh toán nợ cũ trước khi cam kết tiền mặt cho cuốc mới; vẫn có thể thanh toán online",
        409,
        result,
      );
    return result;
  }
  static async read(userId) {
    return require("./finance_lock.service").transaction(
      async (transaction) => {
        await User.findOne({
          where: { userId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        return this.describe(userId, transaction);
      },
    );
  }
}
module.exports = CashEligibility;
