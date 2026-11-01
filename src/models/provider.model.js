const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/postgres.config');
const { PROVIDER_KINDS } = require('../common/auth.constants');
async function scheduleLocationSync(provider, options) {
  const sync = () => require('../services/location.service').syncProvider(provider.id);
  if (options.transaction) options.transaction.afterCommit(sync);
  else await sync();
}
module.exports = sequelize.define('Provider', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
  kind: { type: DataTypes.ENUM(...PROVIDER_KINDS), allowNull: false },
  name: { type: DataTypes.STRING(120), allowNull: false },
  phone: { type: DataTypes.STRING(20), allowNull: false },
  vehicleProfileId: { type: DataTypes.UUID, field: 'vehicle_profile_id' },
  plateNumber: { type: DataTypes.STRING(20), field: 'plate_number' },
  licenseNumber: { type: DataTypes.STRING(50), field: 'license_number' },
  latitude: { type: DataTypes.DOUBLE, allowNull: false, validate: { min: -85.05112878, max: 85.05112878 } },
  longitude: { type: DataTypes.DOUBLE, allowNull: false, validate: { min: -180, max: 180 } },
  address: { type: DataTypes.STRING(255), allowNull: false },
  serviceSegments: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: ['SOLO_BIKE'], allowNull: false, field: 'service_segments' },
  openHours: { type: DataTypes.JSONB, defaultValue: {}, allowNull: false, field: 'open_hours' },
  status: { type: DataTypes.ENUM('ACTIVE', 'PENDING', 'DENIED'), allowNull: false, defaultValue: 'ACTIVE' },
  accepting: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
  suspended: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
  requiresApproval: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false, field: 'requires_approval' },
  denialReason: { type: DataTypes.STRING(500), field: 'denial_reason' },
  suspensionReason: { type: DataTypes.STRING(500), field: 'suspension_reason' },
  adminSuspendedAt: { type: DataTypes.DATE, field: 'admin_suspended_at' },
  reviewedAt: { type: DataTypes.DATE, field: 'reviewed_at' },
  reviewedBy: { type: DataTypes.UUID, field: 'reviewed_by' },
  revokedAt: { type: DataTypes.DATE, field: 'revoked_at' },
  ratingAvg: { type: DataTypes.FLOAT, defaultValue: 5, allowNull: false, field: 'rating_avg', validate: { min: 0, max: 5 } },
  ratingCount: { type: DataTypes.INTEGER, defaultValue: 0, allowNull: false, field: 'rating_count', validate: { min: 0 } },
  lastHeartbeatAt: { type: DataTypes.DATE, field: 'last_heartbeat_at' },
  lastLocationRecordedAt: { type: DataTypes.DATE, field: 'last_location_recorded_at' },
  geoVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'geo_version' },
}, {
  tableName: 'providers', timestamps: true,
  indexes: [
    { unique: true, fields: ['user_id', 'kind'], where: { status: { [Op.ne]: 'DENIED' } } },
    { fields: ['status', 'suspended', 'kind', 'latitude', 'longitude'] },
    { fields: ['vehicle_profile_id'] },
  ],
  hooks: {
    beforeUpdate(provider) { provider.geoVersion = Number(provider.geoVersion) + 1; },
    afterSave: scheduleLocationSync,
  },
});

// Internal cache ordering counters do not belong in API payloads.
module.exports.prototype.toJSON = function() {
  const data = this.get({ plain: true });
  delete data.geoVersion;
  return data;
};
