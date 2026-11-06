const { DataTypes: D } = require("sequelize");
const db = require("../config/postgres.config");
const id = () => ({ type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 });
const money = (field, extra = {}) => ({
  type: D.DECIMAL(12, 2),
  allowNull: false,
  defaultValue: 0,
  field,
  ...extra,
});
const Bill = db.define(
  "Bill",
  {
    id: id(),
    code: { type: D.STRING(24), unique: true, allowNull: false },
    ticketId: { type: D.UUID, unique: true, field: "ticket_id" },
    journeyId: {
      type: D.UUID,
      allowNull: false,
      field: "journey_id",
    },
    userId: { type: D.UUID, allowNull: false, field: "user_id" },
    totalAmount: money("total_amount"),
    paidAmount: money("paid_amount"),
    dueAmount: money("due_amount"),
    status: {
      type: D.ENUM("DRAFT", "PENDING", "PARTIAL", "PAID", "VOID"),
      defaultValue: "DRAFT",
      allowNull: false,
    },
  },
  { tableName: "bills", indexes: [{ fields: ["user_id", "createdAt"] }] },
);
const BillItem = db.define(
  "BillItem",
  {
    id: id(),
    billId: { type: D.UUID, allowNull: false, field: "bill_id" },
    ticketId: { type: D.UUID, allowNull: false, field: "ticket_id" },
    providerId: { type: D.UUID, field: "provider_id" },
    providerUserId: { type: D.UUID, field: "provider_user_id" },
    type: {
      type: D.ENUM(
        "SOS_CALLOUT",
        "SOS_TRAVEL",
        "TOW_FARE",
        "WAITING_FEE",
        "SHOP_REPAIR",
      ),
      allowNull: false,
    },
    title: { type: D.STRING(150), allowNull: false },
    amount: money("amount"),
    disputeCredit: money("dispute_credit"),
    cashCommittedAt: { type: D.DATE, field: "cash_committed_at" },
    ticketRevision: {
      type: D.INTEGER,
      allowNull: false,
      defaultValue: 1,
      field: "ticket_revision",
    },
  },
  {
    tableName: "bill_items",
    indexes: [
      { unique: true, fields: ["ticket_id", "type"] },
      { fields: ["bill_id"] },
    ],
  },
);
const BillPayment = db.define(
  "BillPayment",
  {
    id: id(),
    billId: { type: D.UUID, allowNull: false, field: "bill_id" },
    billItemId: { type: D.UUID, allowNull: false, field: "bill_item_id" },
    intentId: { type: D.UUID, field: "intent_id" },
    providerId: { type: D.UUID, allowNull: false, field: "provider_id" },
    providerUserId: {
      type: D.UUID,
      allowNull: false,
      field: "provider_user_id",
    },
    amount: money("amount"),
    appliedAmount: money("applied_amount"),
    refundedAmount: money("refunded_amount"),
    method: { type: D.ENUM("SEPAY", "CASH"), allowNull: false },
    status: {
      type: D.ENUM("PENDING", "HELD", "CONFIRMED", "REFUNDED", "CANCELLED"),
      defaultValue: "PENDING",
      allowNull: false,
    },
    transactionCode: {
      type: D.STRING(50),
      allowNull: false,
      unique: true,
      field: "transaction_code",
    },
    sepayReference: { type: D.STRING(100), field: "sepay_reference" },
    commissionRate: {
      type: D.DECIMAL(7, 6),
      allowNull: false,
      defaultValue: 0.1,
      field: "commission_rate",
    },
    commissionBps: {
      type: D.INTEGER,
      allowNull: false,
      defaultValue: 1000,
      field: "commission_bps",
    },
    commissionAmount: money("commission_amount"),
    payoutAmount: money("payout_amount"),
    cashCommissionOutstanding: money("cash_commission_outstanding"),
    payoutBatchId: { type: D.UUID, field: "payout_batch_id" },
    paidAt: { type: D.DATE, field: "paid_at" },
    confirmedAt: { type: D.DATE, field: "confirmed_at" },
  },
  {
    tableName: "bill_payments",
    indexes: [
      { fields: ["bill_id", "status"] },
      { fields: ["provider_user_id", "status", "payout_batch_id"] },
    ],
  },
);
module.exports = { Bill, BillItem, BillPayment };
