const { DataTypes } = require('sequelize');
const sequelize = require('../config/postgres.config');
const { RIDE_MODES } = require('../common/auth.constants');
module.exports = sequelize.define('VehicleRideConfig', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  vehicleProfileId: { type: DataTypes.UUID, allowNull: false, unique: true, field: 'vehicle_profile_id' },
  mode: { type: DataTypes.ENUM(...RIDE_MODES), defaultValue: 'SOLO', allowNull: false },
  width: { type: DataTypes.FLOAT, allowNull: false, validate: { isFloat: true, positive(value) { if (!Number.isFinite(value) || value <= 0) throw new Error('Width must be positive'); } } },
  height: { type: DataTypes.FLOAT, allowNull: false, validate: { isFloat: true, positive(value) { if (!Number.isFinite(value) || value <= 0) throw new Error('Height must be positive'); } } },
}, { tableName: 'vehicle_ride_configs', timestamps: true });
