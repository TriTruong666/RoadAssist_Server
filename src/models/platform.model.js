const { DataTypes: D } = require("sequelize");
const db = require("../config/postgres.config");
const Announcement = db.define(
  "Announcement",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    title: { type: D.STRING(160), allowNull: false },
    content: { type: D.TEXT, allowNull: false },
    target: { type: D.ENUM("ALL", "RIDER", "PROVIDER"), allowNull: false },
    priority: {
      type: D.ENUM("NORMAL", "IMPORTANT", "CRITICAL"),
      allowNull: false,
    },
    createdBy: { type: D.UUID, allowNull: false, field: "created_by" },
    recipientCount: {
      type: D.INTEGER,
      allowNull: false,
      field: "recipient_count",
    },
  },
  { tableName: "announcements" },
);
const AnnouncementReceipt = db.define(
  "AnnouncementReceipt",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    announcementId: {
      type: D.UUID,
      allowNull: false,
      field: "announcement_id",
    },
    userId: { type: D.UUID, allowNull: false, field: "user_id" },
    deliveredAt: { type: D.DATE, field: "delivered_at" },
    readAt: { type: D.DATE, field: "read_at" },
  },
  {
    tableName: "announcement_receipts",
    indexes: [{ unique: true, fields: ["announcement_id", "user_id"] }],
  },
);
const PlatformSetting = db.define(
  "PlatformSetting",
  {
    key: { type: D.STRING(80), primaryKey: true },
    value: { type: D.JSONB, allowNull: false },
    updatedBy: { type: D.UUID, field: "updated_by" },
    revision: { type: D.INTEGER, allowNull: false, defaultValue: 1 },
  },
  { tableName: "platform_settings" },
);
module.exports = { Announcement, AnnouncementReceipt, PlatformSetting };

const UserDevice = db.define(
  "UserDevice",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    userId: { type: D.UUID, allowNull: false, field: "user_id" },
    clientDeviceId: {
      type: D.UUID,
      allowNull: false,
      field: "client_device_id",
    },
    name: { type: D.STRING(120), allowNull: false },
    userAgent: { type: D.STRING(512), field: "user_agent" },
    lastSeenAt: { type: D.DATE, allowNull: false, field: "last_seen_at" },
  },
  {
    tableName: "user_devices",
    indexes: [{ unique: true, fields: ["user_id", "client_device_id"] }],
  },
);
const AnnouncementDelivery = db.define(
  "AnnouncementDelivery",
  {
    id: { type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 },
    announcementId: {
      type: D.UUID,
      allowNull: false,
      field: "announcement_id",
    },
    userId: { type: D.UUID, allowNull: false, field: "user_id" },
    deviceId: { type: D.UUID, allowNull: false, field: "device_id" },
    deliveredAt: { type: D.DATE, allowNull: false, field: "delivered_at" },
  },
  {
    tableName: "announcement_deliveries",
    indexes: [
      { unique: true, fields: ["announcement_id", "user_id", "device_id"] },
    ],
  },
);
const PayoutAccount = db.define(
  "PayoutAccount",
  {
    userId: { type: D.UUID, primaryKey: true, field: "user_id" },
    bankCode: { type: D.STRING(30), allowNull: false, field: "bank_code" },
    accountNumber: {
      type: D.STRING(34),
      allowNull: false,
      field: "account_number",
    },
    accountName: {
      type: D.STRING(120),
      allowNull: false,
      field: "account_name",
    },
  },
  { tableName: "payout_accounts" },
);
Object.assign(module.exports, {
  UserDevice,
  AnnouncementDelivery,
  PayoutAccount,
});
