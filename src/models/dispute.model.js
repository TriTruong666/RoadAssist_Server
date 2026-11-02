const { DataTypes: D } = require("sequelize");
const db = require("../config/postgres.config");
const uuid = () => ({ type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 });
const money = (field) => ({
  type: D.DECIMAL(12, 2),
  allowNull: false,
  defaultValue: 0,
  field,
});
const Dispute = db.define(
  "Dispute",
  {
    id: uuid(),
    ticketId: {
      type: D.UUID,
      allowNull: false,
      unique: true,
      field: "ticket_id",
    },
    journeyId: { type: D.UUID, allowNull: false, field: "journey_id" },
    claimantId: { type: D.UUID, allowNull: false, field: "claimant_id" },
    respondentId: { type: D.UUID, allowNull: false, field: "respondent_id" },
    providerUserId: {
      type: D.UUID,
      allowNull: false,
      field: "provider_user_id",
    },
    reason: { type: D.STRING(50), allowNull: false },
    note: { type: D.STRING(2000), allowNull: false },
    fingerprint: { type: D.STRING(64), allowNull: false },
    status: {
      type: D.ENUM("OPEN", "REVIEW", "RESOLVED", "REJECTED"),
      allowNull: false,
      defaultValue: "OPEN",
    },
    responseDueAt: { type: D.DATE, allowNull: false, field: "response_due_at" },
    respondedAt: { type: D.DATE, field: "responded_at" },
    adminResolution: {
      type: D.ENUM(
        "FAVOR_RIDER",
        "FAVOR_PROVIDER",
        "PARTIAL_REFUND",
        "NO_ACTION",
      ),
      field: "admin_resolution",
    },
    adminNote: { type: D.STRING(2000), field: "admin_note" },
    awardAmount: money("award_amount"),
    debtCreditAmount: money("debt_credit_amount"),
    refundAmount: money("refund_amount"),
    resolvedAt: { type: D.DATE, field: "resolved_at" },
    resolvedBy: { type: D.UUID, field: "resolved_by" },
    resolutionFingerprint: {
      type: D.STRING(64),
      field: "resolution_fingerprint",
    },
  },
  {
    tableName: "disputes",
    indexes: [
      { fields: ["status", "response_due_at"] },
      { fields: ["claimant_id", "createdAt"] },
      { fields: ["respondent_id", "createdAt"] },
    ],
  },
);
const DisputeEvent = db.define(
  "DisputeEvent",
  {
    id: uuid(),
    disputeId: { type: D.UUID, allowNull: false, field: "dispute_id" },
    actorId: { type: D.UUID, field: "actor_id" },
    action: { type: D.STRING(60), allowNull: false },
    note: { type: D.STRING(2000) },
    images: {
      type: D.ARRAY(D.STRING(2048)),
      allowNull: false,
      defaultValue: [],
    },
    details: { type: D.JSONB, allowNull: false, defaultValue: {} },
  },
  {
    tableName: "dispute_events",
    updatedAt: false,
    indexes: [{ fields: ["dispute_id", "createdAt"] }],
  },
);
for (const hook of [
  "beforeUpdate",
  "beforeDestroy",
  "beforeBulkUpdate",
  "beforeBulkDestroy",
])
  DisputeEvent.addHook(hook, () => {
    throw new Error("Dispute events are append-only");
  });
const ProviderRecovery = db.define(
  "ProviderRecovery",
  {
    id: uuid(),
    disputeId: {
      type: D.UUID,
      allowNull: false,
      unique: true,
      field: "dispute_id",
    },
    userId: { type: D.UUID, allowNull: false, field: "user_id" },
    amount: money("amount"),
  },
  { tableName: "provider_recoveries", indexes: [{ fields: ["user_id"] }] },
);
const RecoveryOffset = db.define(
  "RecoveryOffset",
  {
    id: uuid(),
    batchId: { type: D.UUID, allowNull: false, field: "batch_id" },
    recoveryId: { type: D.UUID, allowNull: false, field: "recovery_id" },
    amount: money("amount"),
    status: {
      type: D.ENUM("RESERVED", "SETTLED", "CANCELLED"),
      allowNull: false,
      defaultValue: "RESERVED",
    },
  },
  {
    tableName: "recovery_offsets",
    indexes: [{ unique: true, fields: ["batch_id", "recovery_id"] }],
  },
);
for (const hook of [
  "beforeUpdate",
  "beforeDestroy",
  "beforeBulkUpdate",
  "beforeBulkDestroy",
])
  ProviderRecovery.addHook(hook, () => {
    throw new Error("Recovery obligations are immutable");
  });
module.exports = { Dispute, DisputeEvent, ProviderRecovery, RecoveryOffset };
