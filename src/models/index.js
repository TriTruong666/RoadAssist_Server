const User = require('./user.model');
const Provider = require('./provider.model');
const ProviderDocument = require('./provider_document.model');
const ProviderAuditLog = require('./provider_audit_log.model');
const ProviderLocationHistory = require('./provider_location_history.model');
const PendingRegistration = require('./pending_registration.model');
const AuthSession = require('./auth_session.model');
const VehicleProfile = require('./vehicle_profile.model');
const VehicleRideConfig = require('./vehicle_ride_config.model');
User.hasMany(VehicleProfile, { as: 'vehicles', foreignKey: 'userId', sourceKey: 'userId', onDelete: 'CASCADE' });
VehicleProfile.belongsTo(User, { as: 'owner', foreignKey: 'userId', targetKey: 'userId' });
// Active vehicle ownership is checked under the user row lock. Avoid a circular FK during sync.
User.belongsTo(VehicleProfile, { as: 'activeVehicle', foreignKey: 'activeVehicleId', constraints: false });
VehicleProfile.hasOne(VehicleRideConfig, { as: 'rideConfig', foreignKey: 'vehicleProfileId', onDelete: 'CASCADE' });
VehicleRideConfig.belongsTo(VehicleProfile, { foreignKey: 'vehicleProfileId' });
User.hasMany(AuthSession, { foreignKey: 'userId', sourceKey: 'userId', onDelete: 'CASCADE' });
AuthSession.belongsTo(User, { foreignKey: 'userId', targetKey: 'userId' });
User.hasMany(Provider, { as: 'providers', foreignKey: 'userId', sourceKey: 'userId', onDelete: 'CASCADE' });
Provider.belongsTo(User, { as: 'owner', foreignKey: 'userId', targetKey: 'userId' });
VehicleProfile.hasMany(Provider, { as: 'providerLinks', foreignKey: 'vehicleProfileId', onDelete: 'SET NULL' });
Provider.belongsTo(VehicleProfile, { as: 'vehicle', foreignKey: 'vehicleProfileId' });
Provider.hasMany(ProviderLocationHistory, { as: 'locations', foreignKey: 'providerId', onDelete: 'CASCADE' });
ProviderLocationHistory.belongsTo(Provider, { foreignKey: 'providerId' });
Provider.hasMany(ProviderDocument, { as: 'documents', foreignKey: 'providerId', onDelete: 'CASCADE' });
ProviderDocument.belongsTo(Provider, { foreignKey: 'providerId' });
Provider.hasMany(ProviderAuditLog, { as: 'auditHistory', foreignKey: 'providerId', onDelete: 'CASCADE' });
ProviderAuditLog.belongsTo(Provider, { foreignKey: 'providerId' });
const HazardFlag = require('./hazard_flag.model');
const HazardVote = require('./hazard_vote.model');
const HazardImage = require('./hazard_image.model');
const HazardMessage = require('./hazard_message.model');
const SavedPlace = require('./saved_place.model');
const SavedRoute = require('./saved_route.model');
for (const Model of [HazardFlag, HazardVote, HazardMessage, SavedPlace, SavedRoute]) {
 User.hasMany(Model, { foreignKey: 'userId', sourceKey: 'userId', onDelete: 'CASCADE' });
 Model.belongsTo(User, { foreignKey: 'userId', targetKey: 'userId' });
}
for (const Model of [HazardVote, HazardImage, HazardMessage]) {
 HazardFlag.hasMany(Model, { foreignKey: 'flagId', onDelete: 'CASCADE' });
 Model.belongsTo(HazardFlag, { foreignKey: 'flagId' });
}
const { ChatRoom, ChatMessage, ChatParticipant } = require('./chat.model');
const S3Asset = require('./s3_asset.model');
const StorageCleanup = require('./storage_cleanup.model');
for (const Model of [ChatMessage, ChatParticipant]) {
 ChatRoom.hasMany(Model, { foreignKey: 'roomId', onDelete: 'CASCADE' });
 Model.belongsTo(ChatRoom, { foreignKey: 'roomId' });
}
User.hasMany(S3Asset, { foreignKey: 'userId', sourceKey: 'userId' });
S3Asset.belongsTo(User, { foreignKey: 'userId', targetKey: 'userId' });
User.hasMany(ChatMessage, { foreignKey: 'senderId', sourceKey: 'userId' });
ChatMessage.belongsTo(User, { foreignKey: 'senderId', targetKey: 'userId' });
User.hasMany(ChatParticipant, { foreignKey: 'userId', sourceKey: 'userId' });
ChatParticipant.belongsTo(User, { foreignKey: 'userId', targetKey: 'userId' });
module.exports = { ChatRoom, ChatMessage, ChatParticipant, S3Asset, StorageCleanup,  HazardFlag, HazardVote, HazardImage, HazardMessage, SavedPlace, SavedRoute,  ProviderDocument, ProviderAuditLog, Provider, ProviderLocationHistory, PendingRegistration, User, AuthSession, VehicleProfile, VehicleRideConfig };
