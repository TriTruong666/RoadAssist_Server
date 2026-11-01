const multer = require('multer');
module.exports = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2, fieldSize: 100 } }).single('file');
