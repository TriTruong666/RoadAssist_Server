const Money = require('../utils/money.util');
const Policy = require('./dispatch_policy.service');
const { Op } = require('sequelize');
module.exports = {
  async prepareAmendment(ticket, transaction) {
    const { BillItem, BillPayment, PaymentIntent } = require('../models');
    const Bills = require('./bill.service');
    const items = await BillItem.findAll({ where: { ticketId: ticket.id }, transaction });
    const payments = await BillPayment.findAll({ where: { billItemId: { [Op.in]: items.map(i => i.id) } }, transaction });
    if (payments.some(p => ['HELD', 'CONFIRMED'].includes(p.status)))
      Policy.fail('QUOTE_ALREADY_FUNDED', 'Báo giá đã nhận tiền; cần hỗ trợ hoàn tiền trước khi sửa');
    const ids = [...new Set(payments.map(p => p.intentId).filter(Boolean))];
    const intents = await PaymentIntent.findAll({ where: { id: { [Op.in]: ids }, status: 'PENDING' }, transaction });
    for (const intent of intents) await Bills.cancelIntent(intent, 'QUOTE_AMENDED', transaction);
  },
  quote(items, amount) {
    if (!items) return [];
    if (!Array.isArray(items) || !items.length || items.length > 100) Policy.fail('QUOTE_ITEMS_INVALID', 'Hạng mục không hợp lệ', 400);
    const lines = items.map(i => {
      if (typeof i.name !== 'string' || !i.name.trim() || i.name.length > 200 || !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 1000 || Money.cents(i.unitPrice) % 100) Policy.fail('QUOTE_ITEMS_INVALID', 'Hạng mục không hợp lệ', 400);
      return { name: i.name.trim(), qty: i.qty, unitPrice: Money.amount(Money.cents(i.unitPrice)), amount: Money.amount(i.qty * Money.cents(i.unitPrice)) };
    });
    if (lines.reduce((n,i) => n + Money.cents(i.amount),0) !== Money.cents(amount)) Policy.fail('QUOTE_TOTAL_MISMATCH','Tổng hạng mục không bằng báo giá',400);
    return lines;
  },
  tow(ticket, provider, now = new Date()) {
    const km = require('../utils/geo.util').distanceMeters({latitude: ticket.pickupLatitude, longitude: ticket.pickupLongitude}, {latitude: ticket.dropoffLatitude, longitude: ticket.dropoffLongitude}) / 1000;
    const car = ticket.vehicleSnapshot.type === 'CAR';
    const base = provider.towBaseFee ?? (car ? 500000 : Number(ticket.pricingSnapshot.towBaseFee));
    const rate = provider.towPerKmFee ?? (car ? 25000 : Number(ticket.pricingSnapshot.towPerKm));
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Ho_Chi_Minh', hour:'2-digit', hourCycle:'h23' }).format(now));
    const night = hour >= 22 || hour < 6;
    const includedKm = car ? 10 : 3;
    const estimate = Math.round((base + rate * Math.max(0, km - includedKm)) * (night ? 1.5 : 1) / 1000) * 1000;
    return { estimate, ceiling: Math.round(estimate * 1.1 / 1000) * 1000, loadedKm: km, baseFee: base, perKmFee: rate, includedKm, night, nightMultiplier: night ? 1.5 : 1, vehicleClass: car ? 'CAR' : 'BIKE', final: null, distanceSource:'STRAIGHT_LINE' };
  },
  async requireCashReceived(ticket, transaction) {
    const { BillItem, BillPayment } = require('../models');
    const items = await BillItem.findAll({where:{ticketId:ticket.id},transaction});
    if (await BillPayment.count({where:{billItemId:{[Op.in]:items.map(i=>i.id)},method:'CASH',status:'PENDING'},transaction}))
      Policy.fail('CASH_NOT_CONFIRMED','Đối tác cần xác nhận đã nhận tiền mặt trước khi hoàn tất');
  }
};
