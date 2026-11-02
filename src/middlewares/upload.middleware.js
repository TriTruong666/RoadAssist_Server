const multer = require('multer');
const sharp = require('sharp');
const { BadRequestException } = require('../common/exceptions/BaseException');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 3, fields: 10, fieldSize: 2048 } }).array('images', 3);
module.exports = upload;
module.exports.compress = async files => {
 const result = [];
 for (const file of files) {
  try {
   const decoder = sharp(file.buffer, { limitInputPixels: 25000000, animated: false });
   const meta = await decoder.metadata();
   if (!['jpeg','png','webp'].includes(meta.format) || (meta.pages || 1) > 1) throw new Error('Unsupported image');
   const content = await decoder.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
   if (content.length > 800 * 1024) throw new Error('Image too large');
   result.push({ content, mimeType: 'image/webp', size: content.length });
  } catch { throw new BadRequestException('Ảnh JPEG, PNG hoặc WebP hợp lệ, tối đa 5MB; ảnh sau nén tối đa 800KB'); }
 }
 return result;
};
