const { Op } = require('sequelize');
const sequelize = require('../config/postgres.config');
const { ConflictException } = require('../common/exceptions/BaseException');
const errors = require('../common/exceptions/error_codes');
const TERMINAL_STATUSES = ['4', '5', '8', '12', '15'];
class VehiclePolicyService {
  static async linkedProviders(vehicle, transaction) {
    const Provider = sequelize.models.Provider;
    return Provider ? Provider.findAll({ where: { vehicleProfileId: vehicle.id, userId: vehicle.userId,
      kind: { [Op.in]: ['TOW', 'MOBILE_SHOP'] } }, transaction, lock: transaction.LOCK.UPDATE }) : [];
  }
  static async assertNotBusy(vehicle, providers, transaction) {
    const Ticket = sequelize.models.DispatchTicket;
    if (!Ticket) return; // Phase 5 registers DispatchTicket; there are no tickets in Phase 2.
    const alternatives = [{ vehicleProfileId: vehicle.id }];
    if (providers.length) alternatives.push({ providerId: { [Op.in]: providers.map(provider => provider.id) } });
    const ticket = await Ticket.findOne({ where: { status: { [Op.notIn]: TERMINAL_STATUSES }, [Op.or]: alternatives }, transaction, lock: transaction.LOCK.UPDATE });
    if (ticket) throw new ConflictException(errors.VEHICLE_BUSY, { dispatchTicketId: ticket.id });
  }
  static identityChanged(vehicle, fields) {
    return ['type', 'plateNumber', 'brand', 'modelName', 'baseWidth', 'baseHeight', 'isActive'].some(field => {
      if (fields[field] === undefined) return false;
      const value = field === 'plateNumber' ? fields[field].toUpperCase().replace(/\s/g, '') : fields[field];
      return value !== vehicle[field];
    });
  }
  static async requireReapproval(providers, vehicle, transaction) {
    const affected = [];
    for (const provider of providers) {
      if (provider.status !== 'ACTIVE') continue;
      await provider.update({ status: 'PENDING', accepting: false, plateNumber: vehicle.plateNumber }, { transaction });
      affected.push({ id: provider.id, kind: provider.kind });
    }
    return affected;
  }
}
module.exports = VehiclePolicyService;
