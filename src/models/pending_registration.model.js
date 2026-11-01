const { DataTypes } = require('sequelize');
const sequelize = require('../config/postgres.config');
// No email/phone reservation until ownership is proved. Draft passwords are bcrypt hashes.
module.exports = sequelize.define('PendingRegistration', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  email: { type: DataTypes.STRING(150), allowNull: false, validate: { isEmail: true } },
  name: { type: DataTypes.STRING(120), allowNull: false },
  phone: { type: DataTypes.STRING(20), allowNull: false },
  passwordHash: { type: DataTypes.STRING, allowNull: false, field: 'password_hash' },
  requestedServices: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, field: 'requested_services' },
  expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
}, { tableName: 'pending_registrations', timestamps: true, indexes: [{ fields: ['expires_at'] }] });
