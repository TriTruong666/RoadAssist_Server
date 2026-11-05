const sequelize = require("../config/postgres.config");
const { User, VehicleProfile, VehicleRideConfig } = require("../models");
const Policy = require("./vehicle_policy.service");
const ProviderAccess = require("./provider_access.service");
const errors = require("../common/exceptions/error_codes");
const {
  NotFoundException,
  UnauthorizedException,
} = require("../common/exceptions/BaseException");
class VehicleService {
  static include = [{ model: VehicleRideConfig, as: "rideConfig" }];
  static async lockUser(userId, transaction) {
    const user = await User.findOne({
      where: { userId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!user || user.status !== "ACTIVE") throw new UnauthorizedException();
    return user;
  }
  static async owned(userId, id, transaction) {
    const vehicle = await VehicleProfile.findOne({
      where: { id, userId },
      transaction,
      ...(transaction && { lock: transaction.LOCK.UPDATE }),
    });
    if (!vehicle) throw new NotFoundException(errors.VEHICLE_NOT_FOUND);
    return vehicle;
  }
  static async list(userId) {
    const rows = await VehicleProfile.findAll({
      where: { userId },
      include: this.include,
      order: [["createdAt", "DESC"]],
    });
    const { Op } = require("sequelize");
    const photos = rows.length ? await sequelize.models.S3Asset.findAll({ where: { userId, attachedTo: { [Op.in]: rows.map(row => `vehicle:${row.id}`) } }, order: [["createdAt", "DESC"], ["id", "DESC"]] }) : [];
    return rows.map(row => ({ ...row.toJSON(), photo: (() => { const photo = photos.find(asset => asset.attachedTo === `vehicle:${row.id}`); return photo ? { id: photo.id, url: photo.s3Url } : null; })() }));
  }
  static async uploadPhoto(userId, id, file) {
    const { BadRequestException } = require("../common/exceptions/BaseException");
    if (!file) throw new BadRequestException("Cần chọn ảnh phương tiện");
    // Authorize before image decoding or external storage work.
    await this.owned(userId, id);
    const [image] = await require("../middlewares/upload.middleware").compress([file]);
    const Storage = require("./s3.service");
    return Storage.withUploads(keys => sequelize.transaction(async transaction => {
      await this.lockUser(userId, transaction);
      const vehicle = await this.owned(userId, id, transaction);
      await Policy.assertNotBusy(vehicle, await Policy.linkedProviders(vehicle, transaction), transaction);
      const Asset = sequelize.models.S3Asset;
      const old = await Asset.findAll({ where: { userId, attachedTo: `vehicle:${id}` }, transaction, lock: transaction.LOCK.UPDATE });
      const saved = await Storage.upload({ body: image.content, mimeType: image.mimeType, originalName: "vehicle.webp", userId, attachedTo: `vehicle:${id}`, transaction, keys });
      for (const asset of old) await asset.destroy({ transaction });
      transaction.afterCommit(() => Storage.cleanup(old.map(asset => asset.s3Key)));
      return { id: saved.record.id, url: saved.url };
    }));
  }
  static async create(userId, data) {
    return sequelize.transaction(async (transaction) => {
      await this.lockUser(userId, transaction);
      const vehicle = await VehicleProfile.create(
        { ...data, userId },
        { transaction },
      );
      await VehicleRideConfig.create(
        {
          vehicleProfileId: vehicle.id,
          mode: "SOLO",
          width: vehicle.baseWidth,
          height: vehicle.baseHeight,
        },
        { transaction },
      );
      return VehicleProfile.findByPk(vehicle.id, {
        include: this.include,
        transaction,
      });
    });
  }
  static async update(userId, id, data) {
    return sequelize.transaction(async (transaction) => {
      const user = await this.lockUser(userId, transaction);
      const vehicle = await this.owned(userId, id, transaction);
      const { rideConfig: submittedRideConfig, ...fields } = data;
      const rideConfig =
        submittedRideConfig &&
        Object.fromEntries(
          ["mode", "width", "height"]
            .filter((field) => submittedRideConfig[field] !== undefined)
            .map((field) => [field, submittedRideConfig[field]]),
        );
      const providers = await Policy.linkedProviders(vehicle, transaction);
      await Policy.assertNotBusy(vehicle, providers, transaction);
      const priorVehicle = vehicle.toJSON();
      const identityChanged = Policy.identityChanged(vehicle, fields);
      await vehicle.update(fields, { transaction });
      const reapprovalRequiredProviders = identityChanged
        ? await Policy.requireReapproval(providers, vehicle, transaction, priorVehicle)
        : [];
      await ProviderAccess.synchronize(user, transaction);
      if (vehicle.isActive === false && user.activeVehicleId === id)
        await user.update({ activeVehicleId: null }, { transaction });
      const current = await VehicleRideConfig.findOne({
        where: { vehicleProfileId: id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const mode = rideConfig?.mode || current?.mode || "SOLO";
      // SOLO follows base dimensions unless an explicit load configuration is supplied.
      const dimensions =
        mode === "SOLO"
          ? { width: vehicle.baseWidth, height: vehicle.baseHeight }
          : {
              width: current?.width || vehicle.baseWidth,
              height: current?.height || vehicle.baseHeight,
            };
      const values = { ...dimensions, ...rideConfig, mode };
      if (current) await current.update(values, { transaction });
      else
        await VehicleRideConfig.create(
          { vehicleProfileId: id, ...values },
          { transaction },
        );
      const updated = await VehicleProfile.findByPk(id, {
        include: this.include,
        transaction,
      });
      return { ...updated.toJSON(), reapprovalRequiredProviders };
    });
  }
  static async setActive(userId, id) {
    return sequelize.transaction(async (transaction) => {
      const user = await this.lockUser(userId, transaction);
      if (id !== null) {
        const vehicle = await this.owned(userId, id, transaction);
        if (!vehicle.isActive)
          throw new NotFoundException(errors.VEHICLE_NOT_FOUND);
      }
      await user.update({ activeVehicleId: id }, { transaction });
      return {
        activeVehicleId: id,
        activeVehicle: id
          ? await VehicleProfile.findByPk(id, {
              include: this.include,
              transaction,
            })
          : null,
      };
    });
  }
  static async remove(userId, id) {
    return sequelize.transaction(async (transaction) => {
      const user = await this.lockUser(userId, transaction);
      const vehicle = await this.owned(userId, id, transaction);
      const providers = await Policy.linkedProviders(vehicle, transaction);
      await Policy.assertNotBusy(vehicle, providers, transaction);
      const revokedProviders = [];
      transaction.roadAssistActorId = userId;
      for (const provider of providers) {
        await provider.update(
          {
            status: "REVOKED",
            accepting: false,
            suspended: true,
            vehicleProfileId: null,
            revokedAt: provider.revokedAt || new Date(),
            revocationReason: provider.revocationReason || "VEHICLE_DELETED",
          },
          { transaction },
        );
        revokedProviders.push({ id: provider.id, kind: provider.kind });
      }
      await ProviderAccess.synchronize(user, transaction);
      if (user.activeVehicleId === id)
        await user.update({ activeVehicleId: null }, { transaction });
      const photos = await sequelize.models.S3Asset.findAll({ where: { userId, attachedTo: `vehicle:${id}` }, transaction });
      for (const photo of photos) await photo.destroy({ transaction });
      transaction.afterCommit(() => require("./s3.service").cleanup(photos.map(photo => photo.s3Key)));
      await vehicle.destroy({ transaction });
      return { deleted: true, revokedProviders };
    });
  }
}
module.exports = VehicleService;
