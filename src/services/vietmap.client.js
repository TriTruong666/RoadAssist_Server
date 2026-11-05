const axios = require('axios');
const config = require('../config/app.config');
const { BaseException } = require('../common/exceptions/BaseException');
const unavailable = (code = 'MAP_SERVICE_UNAVAILABLE') => new BaseException({ code, message: code === 'VIETMAP_NOT_CONFIGURED' ? 'Chưa cấu hình khóa API VietMap trên server' : 'Dịch vụ địa điểm VietMap hiện không khả dụng', statusCode: 503 });
const validCoordinate = (value, max) => ['number', 'string'].includes(typeof value) && String(value).trim() !== '' && Number.isFinite(Number(value)) && Math.abs(Number(value)) <= max;
// WMS VietMap v4 contract. Keep credentials and upstream error payloads on the server.
class VietmapClient {
  async get(endpoint, params) {
    if (!config.maps.vietmapApiToken) throw unavailable('VIETMAP_NOT_CONFIGURED');
    try {
      return (await axios.get(`${config.maps.vietmapBaseUrl.replace(/\/+$/, '')}${endpoint}`, { params: { ...params, apikey: config.maps.vietmapApiToken }, headers: { Accept: 'application/json' }, timeout: config.maps.vietmapTimeoutMs, maxContentLength: 2 * 1024 * 1024 })).data;
    } catch { throw unavailable(); }
  }
  async autocomplete({ q, latitude, longitude }) {
    const data = await this.get('/api/autocomplete/v4', { text: q, display_type: 6, ...(latitude !== undefined && longitude !== undefined && { focus: `${latitude},${longitude}` }) });
    if (!Array.isArray(data)) throw unavailable();
    return data.slice(0, 10).filter(row => typeof row?.ref_id === 'string' && row.ref_id && typeof row.name === 'string').map(row => ({ id: row.ref_id, refId: row.ref_id, name: row.name, address: String(row.address || row.display || ''), display: String(row.display || [row.name, row.address].filter(Boolean).join(', ')), distanceKm: typeof row.distance === 'number' && Number.isFinite(row.distance) ? row.distance : null, source: 'VIETMAP' }));
  }
  async place(refId) {
    const row = await this.get('/api/place/v4', { refid: refId });
    if (!row || Array.isArray(row) || !validCoordinate(row.lat, 90) || !validCoordinate(row.lng, 180)) throw unavailable();
    return { id: refId, refId, name: String(row.name || row.display || 'Địa điểm'), address: String(row.address || row.display || ''), display: String(row.display || row.address || row.name || ''), latitude: Number(row.lat), longitude: Number(row.lng), center: [Number(row.lng), Number(row.lat)], source: 'VIETMAP' };
  }
  async reverse({ latitude, longitude }) {
    const rows = await this.get('/api/reverse/v4', { lat: latitude, lng: longitude, display_type: 6 });
    if (!Array.isArray(rows)) throw unavailable();
    return { items: rows.slice(0, 10).map(row => ({ name: String(row.name || ''), address: String(row.address || row.display || ''), refId: typeof row.ref_id === 'string' ? row.ref_id : null })) };
  }
}
module.exports = new VietmapClient();
