const { DataTypes } = require("sequelize");
const sequelize = require("../config/postgres.config");
const { VEHICLE_TYPES, VEHICLE_DEFAULTS } = require("../common/auth.constants");
module.exports = sequelize.define(
  "VehicleProfile",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: { type: DataTypes.UUID, allowNull: false, field: "user_id" },
    type: { type: DataTypes.ENUM(...VEHICLE_TYPES), allowNull: false },
    plateNumber: {
      type: DataTypes.STRING(20),
      allowNull: false,
      field: "plate_number",
      set(value) {
        this.setDataValue(
          "plateNumber",
          value.toUpperCase().replace(/\s/g, ""),
        );
      },
    },
    brand: { type: DataTypes.STRING(50), allowNull: false },
    modelName: {
      type: DataTypes.STRING(50),
      allowNull: false,
      field: "model_name",
    },
    color: { type: DataTypes.STRING(30) },
    baseWidth: {
      type: DataTypes.FLOAT,
      allowNull: false,
      field: "base_width",
      validate: { min: 0.3, max: 3 },
    },
    baseHeight: {
      type: DataTypes.FLOAT,
      allowNull: false,
      field: "base_height",
      validate: { min: 0.5, max: 3 },
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      allowNull: false,
      field: "is_active",
    },
  },
  {
    tableName: "vehicle_profiles",
    timestamps: true,
    indexes: [{ fields: ["user_id"] }],
    hooks: {
      beforeValidate(vehicle) {
        const defaults = VEHICLE_DEFAULTS[vehicle.type];
        if (defaults) {
          vehicle.baseWidth ??= defaults.baseWidth;
          vehicle.baseHeight ??= defaults.baseHeight;
        }
      },
    },
  },
);
