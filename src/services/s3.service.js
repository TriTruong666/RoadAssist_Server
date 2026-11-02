// Adapted from Picare Core: SDK v3 multipart upload, timeout/abort, metadata records,
// presigning, delete batches, HEAD/exists and slug+UUID keys. RoadAssist fixes its namespace.
const { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { randomUUID } = require('node:crypto');
const slugify = require('slugify');
const client = require('../config/s3.config');
const config = require('../config/app.config').s3;
const { resolveMimeType } = require('../common/s3_upload.helper');
const { BaseException, BadRequestException } = require('../common/exceptions/BaseException');
const unavailable = () => new BaseException({ code: 'STORAGE_UNAVAILABLE', message: 'Không thể lưu file lên S3', statusCode: 503 });
class S3Service {
 configured() { return !!(config.accessKeyId && config.secretAccessKey && config.region && config.bucketName); }
 assertConfigured() { if (!this.configured()) throw unavailable(); }
 assertKey(key) { if (typeof key !== 'string' || !/^roadassist\/[a-zA-Z0-9_.-]+$/.test(key) || key.includes('..')) throw new BadRequestException('Object phải nằm trực tiếp trong roadassist/'); return key; }
 buildKey(folder, filename) {
  const basename = String(filename || 'file').split(/[\\/]/).at(-1);
  const dot = basename.lastIndexOf('.'); const ext = dot > 0 ? basename.slice(dot).replace(/[^a-zA-Z0-9.]/g,'').slice(0,12).toLowerCase() : '';
  const slug = slugify(dot > 0 ? basename.slice(0,dot) : basename, { lower: true, strict: true, locale: 'vi' }).slice(0,60) || 'file';
  return `roadassist/${Date.now()}_${randomUUID()}_${slug}${ext}`;
 }
 publicUrl(key) {
  this.assertKey(key);
  const base = config.publicBaseUrl || (config.endpoint ? `${config.endpoint.replace(/\/$/,'')}/${config.bucketName}` : `https://${config.bucketName}.s3.${config.region}.amazonaws.com`);
  return `${base.replace(/\/$/,'')}/${key.split('/').map(encodeURIComponent).join('/')}`;
 }
 async uploadToS3(params) {
  const uploader = new Upload({ client, params }); let timer;
  try { return await Promise.race([uploader.done(), new Promise((resolve,reject) => { timer = setTimeout(() => { uploader.abort().catch(()=>{}); reject(unavailable()); }, config.uploadTimeoutMs); })]); }
  finally { clearTimeout(timer); }
 }
 async upload({ body, mimeType, originalName = 'image.webp', userId, transaction, attachedTo = null, keys = [] }) {
  this.assertConfigured();
  if (!Buffer.isBuffer(body) || !body.length || body.length > 25*1024*1024) throw new BadRequestException('File tối đa 25MB');
  const key = this.buildKey('roadassist', originalName); keys.push(key);
  const type = resolveMimeType(mimeType, originalName);
  try {
   // No ACL: bucket policy managed in S3 console determines anonymous access.
   const result = await this.uploadToS3({ Bucket: config.bucketName, Key: key, Body: body, ContentType: type });
   const record = await require('../models').S3Asset.create({ userId, s3Key:key, s3Url:this.publicUrl(key), s3Bucket:config.bucketName, s3Region:config.region,
    folder:'roadassist', visibility:'public', originalName:originalName.slice(0,120), mimeType:type, fileSize:body.length, etag:result.ETag, attachedTo }, { transaction });
   return { key, url:record.s3Url, etag:result.ETag, record };
  } catch (error) { if (!transaction) await this.cleanup([key]); throw error.statusCode ? error : unavailable(); }
 }
 async withUploads(work) {
  const keys=[];
  try { return await work(keys); }
  catch(error) { await this.cleanup(keys); throw error; }
 }
 async delete(key) { return client.send(new DeleteObjectCommand({ Bucket:config.bucketName, Key:this.assertKey(key) })); }
 async deleteMany(keys) {
  keys.forEach(key=>this.assertKey(key));
  for(let i=0;i<keys.length;i+=1000) { const result=await client.send(new DeleteObjectsCommand({ Bucket:config.bucketName, Delete:{Objects:keys.slice(i,i+1000).map(Key=>({Key}))} })); if(result.Errors?.length) throw unavailable(); }
 }
 async cleanup(keys) {
  for(const key of keys) {
   try { await this.delete(key); }
   catch { try { await require('../models').StorageCleanup.findOrCreate({where:{key}}); } catch { console.error('[S3] Cleanup could not be scheduled:', key); } }
  }
 }
 async retryCleanup() {
  if (!this.configured()) return;
  for(const row of await require('../models').StorageCleanup.findAll({limit:100,order:[['createdAt','ASC']]})) {
   try { await this.delete(row.key); await row.destroy(); } catch { await row.increment('attempts'); }
  }
 }
 async getMetadata(key) {
  const r=await client.send(new HeadObjectCommand({Bucket:config.bucketName,Key:this.assertKey(key)}));
  return {key,contentType:r.ContentType,contentLength:r.ContentLength,lastModified:r.LastModified,metadata:r.Metadata,etag:r.ETag};
 }
 async exists(key) {try {await this.getMetadata(key);return true;} catch(e){if(e.name==='NotFound'||e.$metadata?.httpStatusCode===404)return false;throw e;} }
 getDownloadStream(key) {return client.send(new GetObjectCommand({Bucket:config.bucketName,Key:this.assertKey(key)}));}
 getPresignedUrl(key,expiresIn=3600) {return getSignedUrl(client,new GetObjectCommand({Bucket:config.bucketName,Key:this.assertKey(key)}),{expiresIn});}
 getPresignedUploadUrl(key,mimeType,expiresIn=300) {return getSignedUrl(client,new PutObjectCommand({Bucket:config.bucketName,Key:this.assertKey(key),ContentType:mimeType}),{expiresIn});}
}
module.exports = new S3Service();
