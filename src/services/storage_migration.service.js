const {Op}=require('sequelize');
const db=require('../config/postgres.config');const Storage=require('./s3.service');
module.exports=async()=>{
 if(!Storage.configured())return 0;
 const {HazardImage,ProviderDocument,HazardFlag,Provider}=require('../models');let count=0;
 for(const Model of [HazardImage,ProviderDocument]){
  const candidates=await Model.unscoped().findAll({where:{content:{[Op.ne]:null},s3Key:null},attributes:['id'],limit:50});
  for(const item of candidates)await Storage.withUploads(keys=>db.transaction(async transaction=>{
   const row=await Model.unscoped().findByPk(item.id,{transaction,lock:transaction.LOCK.UPDATE});if(!row?.content||row.s3Key)return;
   const owner=Model===HazardImage?await HazardFlag.findByPk(row.flagId,{transaction}):await Provider.findByPk(row.providerId,{transaction});if(!owner)return;
   const uploaded=await Storage.upload({body:row.content,mimeType:row.mimeType,originalName:row.originalName||'hazard.webp',userId:owner.userId,transaction,attachedTo:Model===HazardImage?`hazard:${row.flagId}`:`provider:${row.providerId}`,keys});
   await row.update({s3Key:uploaded.key,url:uploaded.url,content:null},{transaction});count++;
  }));
 }
 return count;
};
