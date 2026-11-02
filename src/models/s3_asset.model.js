const { DataTypes: D } = require('sequelize');
const db = require('../config/postgres.config');
module.exports = db.define('S3Asset', {
 id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
 userId: { type: D.UUID, allowNull: false, field: 'user_id' },
 s3Key: { type: D.STRING(255), unique: true, allowNull: false, field: 's3_key' },
 s3Url: { type: D.STRING(2048), allowNull: false, field: 's3_url' },
 s3Bucket: { type: D.STRING(100), allowNull: false, field: 's3_bucket' },
 s3Region: { type: D.STRING(50), allowNull: false, field: 's3_region' },
 folder: { type: D.STRING(20), defaultValue: 'roadassist', allowNull: false, validate: { isIn: [['roadassist']] } },
 visibility: { type: D.STRING(10), defaultValue: 'public', allowNull: false, validate: { isIn: [['public']] } },
 originalName: { type: D.STRING(120), allowNull: false, field: 'original_name' },
 mimeType: { type: D.STRING(100), allowNull: false, field: 'mime_type' },
 fileSize: { type: D.INTEGER, allowNull: false, field: 'file_size' },
 etag: D.STRING(255), attachedTo: { type: D.STRING(100), field: 'attached_to' },
}, { tableName: 's3_assets', indexes: [{ fields: ['user_id','createdAt'] }] });
