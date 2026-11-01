const maxUploadMb = Number.parseInt(process.env.MAX_UPLOAD_MB, 10) || 10;
module.exports = { maxUploadMb, maxUploadBytes: maxUploadMb * 1024 * 1024 };
