const { DataTypes } = require('sequelize');
const sequelize = require('../config/postgres.config');
const { DOCUMENT_TYPES } = require('../common/provider.constants');
module.exports = sequelize.define('ProviderDocument', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  providerId: { type: DataTypes.UUID, allowNull: false, field: 'provider_id' },
  documentType: { type: DataTypes.ENUM(...DOCUMENT_TYPES), allowNull: false, field: 'document_type' },
  mimeType: { type: DataTypes.STRING(40), allowNull: false, field: 'mime_type' },
  originalName: { type: DataTypes.STRING(120), allowNull: false, field: 'original_name' },
  size: { type: DataTypes.INTEGER, allowNull: false },
  subjectFingerprint: { type: DataTypes.STRING(64), allowNull: false, field: 'subject_fingerprint' },
  sha256: { type: DataTypes.STRING(64), allowNull: false },
  s3Key: { type: DataTypes.STRING(255), field: 's3_key' },
  url: { type: DataTypes.STRING(2048) },
  content: { type: DataTypes.BLOB, allowNull: true },
  withdrawnAt: { type: DataTypes.DATE, field: 'withdrawn_at' },
}, { tableName: 'provider_documents', timestamps: true, updatedAt: false, defaultScope: { attributes: { exclude: ['content'] } }, indexes: [{ fields: ['provider_id', 'withdrawn_at'] }] });
