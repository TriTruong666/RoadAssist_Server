const sequelize = require("../config/postgres.config");
const { User, VehicleProfile, VehicleRideConfig } = require("../models");
const AuthService = require("./auth.service");
const VehicleService = require("./vehicle.service");
const { NotFoundException } = require("../common/exceptions/BaseException");
const errors = require("../common/exceptions/error_codes");
class UserService {
  static async me(userId) {
    const user = await User.findOne({ where: { userId } });
    if (!user) throw new NotFoundException(errors.USER_NOT_FOUND);
    const activeVehicle = user.activeVehicleId
      ? await VehicleProfile.findOne({
          where: { id: user.activeVehicleId, userId, isActive: true },
          include: [{ model: VehicleRideConfig, as: "rideConfig" }],
        })
      : null;
    const permissions = await require("./provider_access.service").permissions(user);
    return { ...user.toJSON(), ...permissions, activeVehicle };
  }
  static async update(userId, data) {
    await sequelize.transaction(async (transaction) => {
      const user = await VehicleService.lockUser(userId, transaction);
      await user.update(data, { transaction });
    });
    return this.me(userId);
  }
  static async onboard(userId, data, context) {
    return sequelize.transaction(async (transaction) => {
      const user = await VehicleService.lockUser(userId, transaction);
      const requestedServices = [...new Set(['RIDER', ...(data.requestedServices || data.services || user.requestedServices)])];
      await user.update({ onboarded: true, requestedServices }, { transaction });
      return AuthService.issueSession(user, context, transaction);
    });
  }
}
module.exports = UserService;
