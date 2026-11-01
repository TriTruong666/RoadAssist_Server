function normalizePlate(value) { return String(value || '').toUpperCase().replace(/[\s.-]/g, ''); }
function isValidVietnamesePlate(value) { return /^\d{2}[A-Z0-9]{1,3}\d{4,6}$/.test(normalizePlate(value)); }
module.exports = { normalizePlate, isValidVietnamesePlate };
