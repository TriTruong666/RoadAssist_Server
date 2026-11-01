const User = require('./user.model');
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
module.exports = { User, AuthSession, VehicleProfile, VehicleRideConfig };
