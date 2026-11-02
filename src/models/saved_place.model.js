const { DataTypes: D } = require('sequelize');
const sequelize = require('../config/postgres.config');
module.exports = sequelize.define('SavedPlace', {
 id: { type: D.UUID, defaultValue: D.UUIDV4, primaryKey: true },
 userId: { type: D.UUID, allowNull: false, field: 'user_id' }, name: { type: D.STRING(120), allowNull: false }, latitude: { type: D.DOUBLE, allowNull: false }, longitude: { type: D.DOUBLE, allowNull: false }, address: D.STRING(255), category: { type: D.ENUM('HOME','WORK','OTHER'), defaultValue: 'OTHER', allowNull: false }
}, { tableName: 'saved_places', timestamps: true, indexes: [{ fields: ['user_id'] }] });
