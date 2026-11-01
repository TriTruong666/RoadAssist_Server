const { REPAIR_CAPABILITIES, TOW_METHODS } = require('../common/provider.constants');
const { BadRequestException } = require('../common/exceptions/BaseException');
const errors = require('../common/exceptions/error_codes');
const FIELDS = ['capabilities', 'supportedVehicleTypes', 'maxConcurrentJobs', 'towMaxWeightKg', 'towMaxWidth', 'towMaxHeight', 'towMaxLength', 'towMethods'];
function valid(profile) {
  if (!Array.isArray(profile.capabilities) || !profile.capabilities.length || !Array.isArray(profile.supportedVehicleTypes) || !profile.supportedVehicleTypes.length) return false;
  if (profile.kind === 'TOW') return profile.capabilities.every(value => value === 'TOWING') &&
    ['towMaxWeightKg', 'towMaxWidth', 'towMaxHeight', 'towMaxLength'].every(field => Number.isFinite(Number(profile[field])) && Number(profile[field]) > 0) &&
    profile.towMethods?.length > 0 && profile.towMethods.every(value => TOW_METHODS.includes(value));
  return profile.capabilities.every(value => REPAIR_CAPABILITIES.includes(value));
}
function validate(profile) {
  if (profile.kind !== 'SHOP' && profile.maxConcurrentJobs !== 1) throw new BadRequestException('Đối tác lưu động chỉ được nhận một cuốc trên một xe');
  if (profile.capabilities?.length && !profile.capabilities.every(value => profile.kind === 'TOW' ? value === 'TOWING' : REPAIR_CAPABILITIES.includes(value))) throw new BadRequestException(errors.PROVIDER_CAPABILITY_MISMATCH);
  if (profile.supportedVehicleTypes?.some(value => !['BIKE', 'CAR'].includes(value))) throw new BadRequestException(errors.PROVIDER_CAPABILITY_MISMATCH);
  if (profile.kind !== 'TOW' && ['towMaxWeightKg', 'towMaxWidth', 'towMaxHeight', 'towMaxLength'].some(field => profile[field] != null)) throw new BadRequestException('Thông số kéo xe chỉ áp dụng cho TOW');
}
function matches(profile, request = {}) {
  if (!valid(profile)) return false;
  if (request.requiredCapabilities?.some(value => !profile.capabilities.includes(value))) return false;
  if (request.vehicleType && !profile.supportedVehicleTypes.includes(request.vehicleType)) return false;
  if (profile.kind === 'TOW') {
    for (const [input, field] of [['vehicleWeightKg', 'towMaxWeightKg'], ['vehicleWidth', 'towMaxWidth'], ['vehicleHeight', 'towMaxHeight'], ['vehicleLength', 'towMaxLength']]) {
      if (request[input] !== undefined && Number(request[input]) > Number(profile[field])) return false;
    }
    if (request.towMethod && !profile.towMethods.includes(request.towMethod)) return false;
  }
  return true;
}
module.exports = { FIELDS, valid, validate, matches };
