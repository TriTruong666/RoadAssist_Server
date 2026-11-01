const { DataTypes } = require('sequelize');
const sequelize = require('../config/postgres.config');
module.exports = sequelize.define('ProviderLocationHistory', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  providerId: { type: DataTypes.UUID, allowNull: false, field: 'provider_id' },
  latitude: { type: DataTypes.DOUBLE, allowNull: false },
  longitude: { type: DataTypes.DOUBLE, allowNull: false },
  speed: { type: DataTypes.FLOAT },
  accuracy: { type: DataTypes.FLOAT },
  quality: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'UNKNOWN' },
  usableForDispatch: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false, field: 'usable_for_dispatch' },
  recordedAt: { type: DataTypes.DATE, allowNull: false, field: 'recorded_at' },
}, { tableName: 'provider_location_history', timestamps: true, updatedAt: false, indexes: [{ fields: ['provider_id', 'createdAt'] }] });
