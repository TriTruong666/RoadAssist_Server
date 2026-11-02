const { DataTypes: D } = require("sequelize");
const Proof = require("../config/postgres.config").define(
  "BankTransferProof",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    referenceKey: {
      type: D.STRING(150),
      allowNull: false,
      unique: true,
      field: "reference_key",
    },
    externalReference: {
      type: D.STRING(150),
      allowNull: false,
      unique: true,
      field: "external_reference",
    },
    purpose: { type: D.ENUM("REFUND", "PAYOUT"), allowNull: false },
    referenceId: { type: D.UUID, allowNull: false, field: "reference_id" },
    recipientId: { type: D.UUID, allowNull: true, field: "recipient_id" },
    amount: { type: D.DECIMAL(12, 2), allowNull: false },
    confirmedBy: { type: D.UUID, allowNull: false, field: "confirmed_by" },
  },
  { tableName: "bank_transfer_proofs", updatedAt: false },
);
Proof.addHook("beforeValidate", (proof) => {
  proof.referenceKey = String(proof.externalReference || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toUpperCase();
});
for (const hook of [
  "beforeUpdate",
  "beforeDestroy",
  "beforeBulkUpdate",
  "beforeBulkDestroy",
])
  Proof.addHook(hook, () => {
    throw new Error("Bank transfer proofs are append-only");
  });
module.exports = Proof;
