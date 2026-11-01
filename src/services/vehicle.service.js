const { Op } = require('sequelize');
const sequelize = require('../config/postgres.config');
const { User, VehicleProfile, VehicleRideConfig } = require('../models');
const errors = require('../common/exceptions/error_codes');
const { NotFoundException, UnauthorizedException } = require('../common/exceptions/BaseException');
class VehicleService {
  static include = [{ model: VehicleRideConfig, as: 'rideConfig' }];
  static async lockUser(userId, transaction) {
    const user = await User.findOne({ where: { userId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException();
    return user;
  }
  static async owned(userId, id, transaction) {
    const vehicle = await VehicleProfile.findOne({ where: { id, userId }, transaction, ...(transaction && { lock: transaction.LOCK.UPDATE }) });
    if (!vehicle) throw new NotFoundException(errors.VEHICLE_NOT_FOUND);
    return vehicle;
  }
  static list(userId) { return VehicleProfile.findAll({ where: { userId }, include: this.include, order: [['createdAt', 'DESC']] }); }
  static async create(userId, data) {
    return sequelize.transaction(async transaction => {
      await this.lockUser(userId, transaction);
      const vehicle = await VehicleProfile.create({ ...data, userId }, { transaction });
      await VehicleRideConfig.create({ vehicleProfileId: vehicle.id, mode: 'SOLO', width: vehicle.baseWidth, height: vehicle.baseHeight }, { transaction });
      return VehicleProfile.findByPk(vehicle.id, { include: this.include, transaction });
    });
  }
  static async update(userId, id, data) {
    return sequelize.transaction(async transaction => {
      const user = await this.lockUser(userId, transaction);
      const vehicle = await this.owned(userId, id, transaction);
      const { rideConfig: submittedRideConfig, ...fields } = data;
      const rideConfig = submittedRideConfig && Object.fromEntries(['mode', 'width', 'height']
        .filter(field => submittedRideConfig[field] !== undefined).map(field => [field, submittedRideConfig[field]]));
      await vehicle.update(fields, { transaction });
      if (vehicle.isActive === false && user.activeVehicleId === id) await user.update({ activeVehicleId: null }, { transaction });
      const current = await VehicleRideConfig.findOne({ where: { vehicleProfileId: id }, transaction, lock: transaction.LOCK.UPDATE });
      const mode = rideConfig?.mode || current?.mode || 'SOLO';
      // SOLO follows base dimensions unless an explicit load configuration is supplied.
      const dimensions = mode === 'SOLO' ? { width: vehicle.baseWidth, height: vehicle.baseHeight } : { width: current?.width || vehicle.baseWidth, height: current?.height || vehicle.baseHeight };
      const values = { ...dimensions, ...rideConfig, mode };
      if (current) await current.update(values, { transaction });
      else await VehicleRideConfig.create({ vehicleProfileId: id, ...values }, { transaction });
      return VehicleProfile.findByPk(id, { include: this.include, transaction });
    });
  }
  static async setActive(userId, id) {
    return sequelize.transaction(async transaction => {
      const user = await this.lockUser(userId, transaction);
      if (id !== null) {
        const vehicle = await this.owned(userId, id, transaction);
        if (!vehicle.isActive) throw new NotFoundException(errors.VEHICLE_NOT_FOUND);
      }
      await user.update({ activeVehicleId: id }, { transaction });
      return { activeVehicleId: id, activeVehicle: id ? await VehicleProfile.findByPk(id, { include: this.include, transaction }) : null };
    });
  }
  static async remove(userId, id) {
    return sequelize.transaction(async transaction => {
      const user = await this.lockUser(userId, transaction);
      const vehicle = await this.owned(userId, id, transaction);
      // Phase 3 registers Provider. All linked licenses must be revoked before the FK can be cleared.
      const Provider = sequelize.models.Provider;
      const revokedProviders = [];
      if (Provider) {
        const providers = await Provider.findAll({ where: { vehicleProfileId: id, userId, kind: { [Op.in]: ['TOW', 'MOBILE_SHOP'] } }, transaction, lock: transaction.LOCK.UPDATE });
        for (const provider of providers) {
          await provider.update({ status: 'DENIED', accepting: false, suspended: true, vehicleProfileId: null }, { transaction });
          revokedProviders.push({ id: provider.id, kind: provider.kind });
        }
        const remaining = await Provider.findAll({ where: { userId, status: { [Op.ne]: 'DENIED' } }, transaction });
        const removedKinds = revokedProviders.map(provider => provider.kind).filter(kind => !remaining.some(provider => provider.kind === kind));
        if (removedKinds.length) {
          const services = user.services.filter(service => !removedKinds.includes(service));
          await user.update({ services, ...(user.role === 'provider' && !services.some(service => ['SHOP', 'MOBILE_SHOP', 'TOW'].includes(service)) ? { role: 'guest' } : {}) }, { transaction });
        }
      }
      if (user.activeVehicleId === id) await user.update({ activeVehicleId: null }, { transaction });
      await vehicle.destroy({ transaction });
      return { deleted: true, revokedProviders };
    });
  }
}
module.exports = VehicleService;
