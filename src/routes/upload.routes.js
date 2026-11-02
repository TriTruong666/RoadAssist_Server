const router=require('express').Router();
const Storage=require('../services/s3.service');const db=require('../config/postgres.config');const {User,S3Asset}=require('../models');const {Op}=require('sequelize');const {ConflictException}=require('../common/exceptions/BaseException');const R=require('../common/response.handler');
router.use(require('../middlewares/auth.middleware').protect);
router.post('/',require('../middlewares/upload.middleware'),async(req,res)=>{
 const images=await require('../middlewares/upload.middleware').compress(req.files||[]);
 if(!images.length)throw new (require('../common/exceptions/BaseException').BadRequestException)('Cần ít nhất một ảnh');
 const items=await Storage.withUploads(keys=>db.transaction(async transaction=>{
  await User.findOne({where:{userId:req.user.userId},transaction,lock:transaction.LOCK.UPDATE});
  if(await S3Asset.count({where:{userId:req.user.userId,createdAt:{[Op.gt]:new Date(Date.now()-86400000)}},transaction})+images.length>100)throw new ConflictException('Tối đa 100 ảnh upload/ngày');
  const items=[];for(const image of images){const upload=await Storage.upload({body:image.content,mimeType:image.mimeType,originalName:'upload.webp',userId:req.user.userId,transaction,keys});items.push({id:upload.record.id,key:upload.key,url:upload.url,mimeType:image.mimeType,size:image.size,folder:'roadassist',visibility:'public'});}return items;
 }));R.created(res,{items});
});
module.exports=router;
