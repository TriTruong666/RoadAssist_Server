const { DataTypes, Op } = require("sequelize");
const sequelize = require("../config/postgres.config");
const { PROVIDER_KINDS } = require("../common/auth.constants");
async function scheduleLocationSync(provider, options) {
  const sync = () =>
    require("../services/location.service").syncProvider(provider.id);
  if (options.transaction) options.transaction.afterCommit(sync);
  else await sync();
}
module.exports = sequelize.define(
  "Provider",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: { type: DataTypes.UUID, allowNull: false, field: "user_id" },
    kind: { type: DataTypes.ENUM(...PROVIDER_KINDS), allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    phone: { type: DataTypes.STRING(20), allowNull: false },
    towBaseFee: { type: DataTypes.INTEGER, field: "tow_base_fee" },
    towPerKmFee: { type: DataTypes.INTEGER, field: "tow_per_km_fee" },
    callOutFee: { type: DataTypes.INTEGER, field: "call_out_fee" },
    travelPerKmFee: { type: DataTypes.INTEGER, field: "travel_per_km_fee" },
    vehicleProfileId: { type: DataTypes.UUID, field: "vehicle_profile_id" },
    plateNumber: { type: DataTypes.STRING(20), field: "plate_number" },
    licenseNumber: { type: DataTypes.STRING(50), field: "license_number" },
    latitude: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      validate: { min: -85.05112878, max: 85.05112878 },
    },
    longitude: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      validate: { min: -180, max: 180 },
    },
    address: { type: DataTypes.STRING(255), allowNull: false },
    serviceSegments: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      defaultValue: ["SOLO_BIKE"],
      allowNull: false,
      field: "service_segments",
    },
    openHours: {
      type: DataTypes.JSONB,
      defaultValue: {},
      allowNull: false,
      field: "open_hours",
    },
    status: {
      type: DataTypes.ENUM("ACTIVE", "PENDING", "DENIED", "REVOKED"),
      allowNull: false,
      defaultValue: "ACTIVE",
    },
    receiveRadiusKm: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10, field: "receive_radius_km", validate: { min: 1, max: 50 } },
    accepting: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    suspended: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    requiresApproval: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
      field: "requires_approval",
    },
    denialReason: { type: DataTypes.STRING(500), field: "denial_reason" },
    suspensionReason: {
      type: DataTypes.STRING(500),
      field: "suspension_reason",
    },
    adminSuspendedAt: { type: DataTypes.DATE, field: "admin_suspended_at" },
    reviewedAt: { type: DataTypes.DATE, field: "reviewed_at" },
    reviewedBy: { type: DataTypes.UUID, field: "reviewed_by" },
    revokedAt: { type: DataTypes.DATE, field: "revoked_at" },
    ratingAvg: {
      type: DataTypes.FLOAT,
      defaultValue: 5,
      allowNull: false,
      field: "rating_avg",
      validate: { min: 0, max: 5 },
    },
    ratingCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      allowNull: false,
      field: "rating_count",
      validate: { min: 0 },
    },
    lastHeartbeatAt: { type: DataTypes.DATE, field: "last_heartbeat_at" },
    lastLocationRecordedAt: {
      type: DataTypes.DATE,
      field: "last_location_recorded_at",
    },
    capabilities: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      defaultValue: [],
      allowNull: false,
    },
    supportedVehicleTypes: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      defaultValue: [],
      allowNull: false,
      field: "supported_vehicle_types",
    },
    maxConcurrentJobs: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
      allowNull: false,
      field: "max_concurrent_jobs",
      validate: { min: 1, max: 20 },
    },
    towMaxWeightKg: { type: DataTypes.FLOAT, field: "tow_max_weight_kg" },
    towMaxWidth: { type: DataTypes.FLOAT, field: "tow_max_width" },
    towMaxHeight: { type: DataTypes.FLOAT, field: "tow_max_height" },
    towMaxLength: { type: DataTypes.FLOAT, field: "tow_max_length" },
    towMethods: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      defaultValue: [],
      allowNull: false,
      field: "tow_methods",
    },
    revocationReason: {
      type: DataTypes.STRING(500),
      field: "revocation_reason",
    },
    profileRevision: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
      allowNull: false,
      field: "profile_revision",
    },
    reviewedRevision: { type: DataTypes.INTEGER, field: "reviewed_revision" },
    locationQuality: {
      type: DataTypes.ENUM(
        "UNKNOWN",
        "GOOD",
        "POOR_ACCURACY",
        "IMPLAUSIBLE_JUMP",
      ),
      defaultValue: "UNKNOWN",
      allowNull: false,
      field: "location_quality",
    },
    lastAccuracy: { type: DataTypes.FLOAT, field: "last_accuracy" },
    lastTrustedLocationAt: {
      type: DataTypes.DATE,
      field: "last_trusted_location_at",
    },
    lastTrustedRecordedAt: {
      type: DataTypes.DATE,
      field: "last_trusted_recorded_at",
    },
    geoVersion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "geo_version",
    },
  },
  {
    tableName: "providers",
    timestamps: true,
    indexes: [
      {
        name: "providers_live_owner_kind",
        unique: true,
        fields: ["user_id", "kind"],
        where: { status: { [Op.notIn]: ["DENIED", "REVOKED"] } },
      },
      { fields: ["status", "suspended", "kind", "latitude", "longitude"] },
      { fields: ["vehicle_profile_id"] },
    ],
    hooks: {
      beforeCreate(provider, options) {
        options._providerCreating = true;
      },
      beforeUpdate(provider) {
        provider.geoVersion = Number(provider.geoVersion) + 1;
        const { REVIEW_FIELDS } = require("../services/provider_audit.service");
        if (
          (REVIEW_FIELDS.some((field) => provider.changed(field)) ||
            (provider.kind === "SHOP" &&
              (provider.changed("latitude") ||
                provider.changed("longitude")))) &&
          !provider.changed("profileRevision")
        )
          provider.profileRevision += 1;
      },
      afterCreate: (provider, options) =>
        require("../services/provider_audit.service").record(provider, {
          ...options,
          _providerCreating: true,
        }),
      afterUpdate: (provider, options) =>
        require("../services/provider_audit.service").record(provider, {
          ...options,
          _providerCreating: false,
        }),
      afterSave: scheduleLocationSync,
    },
  },
);

// Internal cache ordering counters do not belong in API payloads.
module.exports.prototype.toJSON = function () {
  const data = this.get({ plain: true });
  delete data.geoVersion;
  return data;
};
