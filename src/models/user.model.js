const { DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');
const sequelize = require('../config/postgres.config');
const { ROLES, SERVICES } = require('../common/auth.constants');
const User = sequelize.define('User', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  userId: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, unique: true, allowNull: false, field: 'user_id' },
  name: { type: DataTypes.STRING(120), allowNull: false, validate: { notEmpty: true } },
  email: { type: DataTypes.STRING(150), allowNull: false, unique: true, validate: { isEmail: true }, set(value) { this.setDataValue('email', value.trim().toLowerCase()); } },
  password: { type: DataTypes.STRING, allowNull: false },
  phone: { type: DataTypes.STRING(20), unique: true, allowNull: false },
  avatar: { type: DataTypes.STRING(2048), allowNull: true },
  role: { type: DataTypes.ENUM(...ROLES), defaultValue: 'guest', allowNull: false },
  services: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: ['RIDER'], allowNull: false, validate: { supported(value) { if (!value.every(v => SERVICES.includes(v))) throw new Error('Invalid service'); } } },
  status: { type: DataTypes.ENUM('ACTIVE', 'INACTIVE', 'BANNED'), defaultValue: 'ACTIVE', allowNull: false },
  onboarded: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
  activeVehicleId: { type: DataTypes.UUID, allowNull: true, field: 'active_vehicle_id' },
  sessionVersion: { type: DataTypes.INTEGER, defaultValue: 0, allowNull: false, field: 'session_version' },
  trustedIpRecords: { type: DataTypes.JSONB, defaultValue: [], allowNull: false, field: 'trusted_ip_records' },
  loginIp: { type: DataTypes.STRING(50), field: 'login_ip' },
  loginAt: { type: DataTypes.DATE, field: 'login_at' },
  logoutAt: { type: DataTypes.DATE, field: 'logout_at' },
  webPushToken: { type: DataTypes.STRING(255), field: 'web_push_token' },
}, {
  tableName: 'users', timestamps: true,
  hooks: {
    async beforeCreate(user) { user.password = await bcrypt.hash(user.password, 12); },
    async beforeUpdate(user) {
      if (user.changed('password')) user.password = await bcrypt.hash(user.password, 12);
      if (['password', 'status', 'role', 'email'].some(field => user.changed(field)) && !user.changed('sessionVersion')) {
        user.sessionVersion = Number(user.sessionVersion) + 1;
      }
    },
  },
});
User.prototype.comparePassword = function(candidate) { return bcrypt.compare(candidate, this.password); };
// Use an allowlist to prevent credentials and security metadata escaping in responses.
User.prototype.toJSON = function() {
  const fields = ['userId', 'name', 'email', 'phone', 'avatar', 'role', 'services', 'status', 'onboarded', 'activeVehicleId', 'webPushToken', 'createdAt', 'updatedAt'];
  return Object.fromEntries(fields.map(field => [field, this.get(field)]));
};
module.exports = User;
