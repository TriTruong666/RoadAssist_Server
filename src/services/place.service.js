const axios = require('axios');
const sequelize = require('../config/postgres.config');
const { SavedPlace, SavedRoute, User, HazardFlag } = require('../models');
const { Op } = require('sequelize');
const config = require('../config/app.config');
const { BaseException, NotFoundException, ConflictException } = require('../common/exceptions/BaseException');
const upstream = () => new BaseException({ code: 'MAP_SERVICE_UNAVAILABLE', message: 'Dịch vụ bản đồ hiện không khả dụng', statusCode: 503 });
function ring(flag) {
 const result = [];
 for (let i = 0; i <= 16; i++) {
  const angle = 2 * Math.PI * (i % 16) / 16;
  const lat = flag.latitude * Math.PI / 180, lon = flag.longitude * Math.PI / 180, d = flag.radiusMeters / 6371000;
  const y = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(angle));
  const x = lon + Math.atan2(Math.sin(angle) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(y));
  result.push([((x * 180 / Math.PI + 540) % 360) - 180, y * 180 / Math.PI]);
 }
 return result;
}
class PlaceService {
 static model(routes) { return routes ? SavedRoute : SavedPlace; }
 static async list(actor, routes, { limit = 50, offset = 0 }) {
  const result = await this.model(routes).findAndCountAll({ where: { userId: actor.userId }, limit, offset, order: [['createdAt','DESC'], ['id','DESC']], attributes: { exclude: ['userId'] } });
  return { total: result.count, items: result.rows };
 }
 static async create(actor, routes, data) {
  return sequelize.transaction(async transaction => {
   await User.findOne({ where: { userId: actor.userId }, transaction, lock: transaction.LOCK.UPDATE });
   const Model = this.model(routes);
   if (await Model.count({ where: { userId: actor.userId }, transaction }) >= 100) throw new ConflictException('Tối đa 100 mục đã lưu');
   if (routes) data = { ...data, stops: data.stops.map(p => ({ latitude: p.latitude, longitude: p.longitude })), geometry: { type: 'LineString', coordinates: data.geometry.coordinates } };
   const item = await Model.create({ ...data, userId: actor.userId }, { transaction });
   const result = item.toJSON(); delete result.userId; return result;
  });
 }
 static async remove(actor, routes, id) {
  if (!await this.model(routes).destroy({ where: { id, userId: actor.userId } })) throw new NotFoundException();
  return { deleted: true };
 }
 static async update(actor, id, data) {
  return sequelize.transaction(async transaction => {
   await User.findOne({where:{userId:actor.userId},transaction,lock:transaction.LOCK.UPDATE});
   const place=await SavedPlace.findOne({where:{id,userId:actor.userId},transaction,lock:transaction.LOCK.UPDATE});
   if(!place) throw new NotFoundException();
   await place.update(data,{transaction}); const result=place.toJSON();delete result.userId;return result;
  });
 }
 static async search(options) { return { source: 'VIETMAP', items: await require('./vietmap.client').autocomplete(options) }; }
 static async detail({ refId }) { return require('./vietmap.client').place(refId); }
 static async reverse(point) { return require('./vietmap.client').reverse(point); }
 static async solve({ stops, costing = 'auto' }) {
  const flags = await HazardFlag.findAll({ where: { status: { [Op.in]: ['2','3'] }, expiresAt: { [Op.gt]: new Date() } }, order: [['id','ASC']], limit: 101 });
  // Refuse rather than silently omit known danger areas when the upstream polygon budget is exceeded.
  if (flags.length > 100) throw new ConflictException('Quá nhiều vùng cảnh báo để định tuyến an toàn');
  const payload = { locations: stops.map(p => ({ lat: p.latitude, lon: p.longitude })), costing, format: 'osrm', shape_format: 'geojson', exclude_polygons: flags.map(ring) };
  try {
   const { data } = await axios.post(config.maps.valhallaRouterUrl, payload, { timeout: 10000, maxContentLength: 8 * 1024 * 1024 });
   // Valhalla's native JSON response always uses encoded polyline shapes.
   // GeoJSON shape_format is supported by its OSRM response format.
   const route = data.routes?.[0];
   if (data.code !== 'Ok' || !route || !require('../schemas/place_flag.schema').geometry(route.geometry) || !Number.isFinite(route.distance) || route.distance < 0 || !Number.isFinite(route.duration) || route.duration < 0) throw upstream();
   return { geometry: route.geometry, summary: { length: route.distance / 1000, time: route.duration }, avoidedFlagIds: flags.map(f => f.id), calculatedAt: new Date() };
  } catch { throw upstream(); }
 }
}
PlaceService.ring = ring;
module.exports = PlaceService;
