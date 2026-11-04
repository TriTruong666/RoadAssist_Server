const User = require("./user.model");
const Provider = require("./provider.model");
const ProviderDocument = require("./provider_document.model");
const ProviderAuditLog = require("./provider_audit_log.model");
const ProviderLocationHistory = require("./provider_location_history.model");
const PendingRegistration = require("./pending_registration.model");
const AuthSession = require("./auth_session.model");
const VehicleProfile = require("./vehicle_profile.model");
const VehicleRideConfig = require("./vehicle_ride_config.model");
User.hasMany(VehicleProfile, {
  as: "vehicles",
  foreignKey: "userId",
  sourceKey: "userId",
  onDelete: "CASCADE",
});
VehicleProfile.belongsTo(User, {
  as: "owner",
  foreignKey: "userId",
  targetKey: "userId",
});
// Active vehicle ownership is checked under the user row lock. Avoid a circular FK during sync.
User.belongsTo(VehicleProfile, {
  as: "activeVehicle",
  foreignKey: "activeVehicleId",
  constraints: false,
});
VehicleProfile.hasOne(VehicleRideConfig, {
  as: "rideConfig",
  foreignKey: "vehicleProfileId",
  onDelete: "CASCADE",
});
VehicleRideConfig.belongsTo(VehicleProfile, { foreignKey: "vehicleProfileId" });
User.hasMany(AuthSession, {
  foreignKey: "userId",
  sourceKey: "userId",
  onDelete: "CASCADE",
});
AuthSession.belongsTo(User, { foreignKey: "userId", targetKey: "userId" });
User.hasMany(Provider, {
  as: "providers",
  foreignKey: "userId",
  sourceKey: "userId",
  onDelete: "CASCADE",
});
Provider.belongsTo(User, {
  as: "owner",
  foreignKey: "userId",
  targetKey: "userId",
});
VehicleProfile.hasMany(Provider, {
  as: "providerLinks",
  foreignKey: "vehicleProfileId",
  onDelete: "SET NULL",
});
Provider.belongsTo(VehicleProfile, {
  as: "vehicle",
  foreignKey: "vehicleProfileId",
});
Provider.hasMany(ProviderLocationHistory, {
  as: "locations",
  foreignKey: "providerId",
  onDelete: "CASCADE",
});
ProviderLocationHistory.belongsTo(Provider, { foreignKey: "providerId" });
Provider.hasMany(ProviderDocument, {
  as: "documents",
  foreignKey: "providerId",
  onDelete: "CASCADE",
});
ProviderDocument.belongsTo(Provider, { foreignKey: "providerId" });
Provider.hasMany(ProviderAuditLog, {
  as: "auditHistory",
  foreignKey: "providerId",
  onDelete: "CASCADE",
});
ProviderAuditLog.belongsTo(Provider, { foreignKey: "providerId" });
const HazardFlag = require("./hazard_flag.model");
const HazardVote = require("./hazard_vote.model");
const HazardImage = require("./hazard_image.model");
const HazardMessage = require("./hazard_message.model");
const SavedPlace = require("./saved_place.model");
const SavedRoute = require("./saved_route.model");
for (const Model of [
  HazardFlag,
  HazardVote,
  HazardMessage,
  SavedPlace,
  SavedRoute,
]) {
  User.hasMany(Model, {
    foreignKey: "userId",
    sourceKey: "userId",
    onDelete: "CASCADE",
  });
  Model.belongsTo(User, { foreignKey: "userId", targetKey: "userId" });
}
for (const Model of [HazardVote, HazardImage, HazardMessage]) {
  HazardFlag.hasMany(Model, { foreignKey: "flagId", onDelete: "CASCADE" });
  Model.belongsTo(HazardFlag, { foreignKey: "flagId" });
}
const { ChatRoom, ChatMessage, ChatParticipant } = require("./chat.model");
const S3Asset = require("./s3_asset.model");
const StorageCleanup = require("./storage_cleanup.model");
for (const Model of [ChatMessage, ChatParticipant]) {
  ChatRoom.hasMany(Model, { foreignKey: "roomId", onDelete: "CASCADE" });
  Model.belongsTo(ChatRoom, { foreignKey: "roomId" });
}
User.hasMany(S3Asset, { foreignKey: "userId", sourceKey: "userId" });
S3Asset.belongsTo(User, { foreignKey: "userId", targetKey: "userId" });
User.hasMany(ChatMessage, { foreignKey: "senderId", sourceKey: "userId" });
ChatMessage.belongsTo(User, { foreignKey: "senderId", targetKey: "userId" });
User.hasMany(ChatParticipant, { foreignKey: "userId", sourceKey: "userId" });
ChatParticipant.belongsTo(User, { foreignKey: "userId", targetKey: "userId" });
const DispatchTicket = require("./dispatch_ticket.model");
const DispatchEvent = require("./dispatch_event.model");
const DispatchNotification = require("./dispatch_notification.model");
// Preserve historical vehicle/provider IDs and snapshots after profile deletion.
User.hasMany(DispatchTicket, {
  foreignKey: "userId",
  sourceKey: "userId",
  constraints: false,
});
DispatchTicket.hasMany(DispatchEvent, {
  foreignKey: "ticketId",
  onDelete: "CASCADE",
});
DispatchEvent.belongsTo(DispatchTicket, { foreignKey: "ticketId" });
const { Bill, BillItem, BillPayment } = require("./bill.model");
const PaymentIntent = require("./payment_intent.model");
const SepayReceipt = require("./sepay_receipt.model");
const Refund = require("./refund.model");
const { PayoutBatch, PayoutEntry, PayoutOffset } = require("./payout.model");
const FinanceEvent = require("./finance_event.model");
const FinanceNotice = require("./finance_notice.model");
const BankTransferProof = require("./bank_transfer_proof.model");
for (const Model of [BillItem, BillPayment, PaymentIntent, Refund]) {
  Bill.hasMany(Model, { foreignKey: "billId", onDelete: "RESTRICT" });
  Model.belongsTo(Bill, { foreignKey: "billId" });
}
PaymentIntent.hasMany(BillPayment, {
  foreignKey: "intentId",
  onDelete: "RESTRICT",
});
BillItem.hasMany(BillPayment, {
  foreignKey: "billItemId",
  onDelete: "RESTRICT",
});
PayoutBatch.hasMany(PayoutEntry, {
  foreignKey: "batchId",
  onDelete: "RESTRICT",
});
PayoutBatch.hasMany(PayoutOffset, {
  foreignKey: "batchId",
  onDelete: "RESTRICT",
});
const ShopIntakeReservation = require("./shop_intake_reservation.model");
const DispatchSupportCase = require("./dispatch_support_case.model");
const Handover = require("./handover.model");
const {
  Dispute,
  DisputeEvent,
  ProviderRecovery,
  RecoveryOffset,
} = require("./dispute.model");
module.exports = {
  AdminAlert: require("./admin_alert.model"),
  Rating: require("./rating.model"),
  ...require("./platform.model"),
  Handover,
  Dispute,
  DisputeEvent,
  ProviderRecovery,
  RecoveryOffset,
  ShopIntakeReservation,
  DispatchSupportCase,
  BankTransferProof,
  FinanceNotice,
  Bill,
  BillItem,
  BillPayment,
  PaymentIntent,
  SepayReceipt,
  Refund,
  PayoutBatch,
  PayoutEntry,
  PayoutOffset,
  FinanceEvent,
  DispatchTicket,
  DispatchEvent,
  DispatchNotification,
  ChatRoom,
  ChatMessage,
  ChatParticipant,
  S3Asset,
  StorageCleanup,
  HazardFlag,
  HazardVote,
  HazardImage,
  HazardMessage,
  SavedPlace,
  SavedRoute,
  ProviderDocument,
  ProviderAuditLog,
  Provider,
  ProviderLocationHistory,
  PendingRegistration,
  User,
  AuthSession,
  VehicleProfile,
  VehicleRideConfig,
};
