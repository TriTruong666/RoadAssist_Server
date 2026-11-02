const { Op } = require('sequelize');
const db = require('../config/postgres.config');
const { ChatRoom:Room, ChatMessage:Message, ChatParticipant:Participant, HazardFlag:Flag, Provider, User, S3Asset } = require('../models');
const { BaseException, BadRequestException, NotFoundException, ForbiddenException, ConflictException } = require('../common/exceptions/BaseException');
const Storage = require('./s3.service');
const retry = require('../utils/transaction_retry.util');
const { TERMINAL } = require('../common/dispatch.constants');
class ChatService {
 static transaction(work){return retry(()=>db.transaction(work));}
 static async reference(scope, referenceId, transaction) {
  const Model=scope==='HAZARD'?Flag:db.models.DispatchTicket;
  if(!Model)throw new BaseException({code:'DISPATCH_NOT_AVAILABLE',message:'Phân hệ điều phối chưa được triển khai',statusCode:503});
  const ref=await Model.findByPk(referenceId,{transaction,lock:transaction.LOCK.UPDATE});if(!ref)throw new NotFoundException();return ref;
 }
 // Call inside the dispatch mutation transaction AFTER changing providerId/status.
 static async synchronizeDispatch(ticket, transaction) {
  if(!transaction)throw new Error('Dispatch chat requires the assignment transaction');
  const locked=await db.models.DispatchTicket.findByPk(ticket.id,{transaction,lock:transaction.LOCK.UPDATE});
  const latest=await Room.findOne({where:{scope:'DISPATCH',referenceId:locked.id},order:[['version','DESC']],transaction,lock:transaction.LOCK.UPDATE});
  const provider=locked.providerId?await Provider.findByPk(locked.providerId,{transaction}):null;
  if(locked.providerId&&!provider)throw new ConflictException('Đối tác của phiếu không tồn tại');
  let version=Math.max(Number(locked.chatVersion)||1,latest?.version||1);
  const changed=latest && latest.providerId !== locked.providerId;
  if(changed)version=Math.max(version,latest.version+1);
  if(latest&&(changed||version>latest.version))await latest.update({isArchived:true},{transaction});
  let room=latest;
  if(!room||version!==room.version){
   room=await Room.create({scope:'DISPATCH',referenceId:locked.id,version,providerId:locked.providerId,isArchived:TERMINAL.includes(String(locked.status))},{transaction});
   await Participant.create({roomId:room.id,userId:locked.userId,role:'RIDER'},{transaction});
   if(provider&&provider.userId!==locked.userId)await Participant.create({roomId:room.id,userId:provider.userId,role:'PROVIDER'},{transaction});
  }else if(TERMINAL.includes(String(locked.status))&&!room.isArchived)await room.update({isArchived:true},{transaction});
  if(locked.constructor.rawAttributes.chatVersion&&locked.chatVersion!==version)await locked.update({chatVersion:version},{transaction});
  return room;
 }
 static async room(actor, scope, referenceId, transaction, { version, history=false }={}) {
  const ref=await this.reference(scope,referenceId,transaction);
  if(scope==='DISPATCH'){
   const provider=ref.providerId?await Provider.findByPk(ref.providerId,{transaction}):null;
   // Archived participants may request their own history; outsiders cannot trigger room creation.
   const former=await Participant.findOne({where:{userId:actor.userId},include:[{model:Room,where:{scope,referenceId},required:true}],transaction});
   if(ref.userId!==actor.userId&&provider?.userId!==actor.userId&&!former)throw new NotFoundException();
   const current=await this.synchronizeDispatch(ref,transaction);
   const target=version?await Room.findOne({where:{scope,referenceId,version},transaction}):current;
   if(!target||!await Participant.findOne({where:{roomId:target.id,userId:actor.userId},transaction}))throw new NotFoundException();
   return {room:target,ref};
  }
  let room=await Room.findOne({where:{scope,referenceId,version:1},transaction});
  const closed=ref.status==='4'||ref.expiresAt<=new Date();
  if(!room)room=await Room.create({scope,referenceId,version:1,isArchived:closed},{transaction});
  else if(closed&&!room.isArchived)await room.update({isArchived:true},{transaction});
  if(version&&version!==1)throw new NotFoundException();
  return {room,ref};
 }
 static dto(message) {
  return {id:message.id,roomId:message.roomId,senderRole:message.senderRole,authorName:message.User?.name|| (message.senderRole==='SYSTEM'?'Hệ thống':'Người dùng'),content:message.content,images:message.images,systemEvent:message.systemEvent,createdAt:message.createdAt,clientMessageId:message.clientMessageId};
 }
 static async list(actor,scope,referenceId,{limit=50,before,version,offset=0}={}) {
  return this.transaction(async transaction=>{
   const {room}=await this.room(actor,scope,referenceId,transaction,{version});
   const where={roomId:room.id};
   if(before){const cursor=await Message.findOne({where:{id:before,roomId:room.id},transaction});if(!cursor)throw new BadRequestException('Cursor không thuộc phòng chat');where[Op.or]=[{createdAt:{[Op.lt]:cursor.createdAt}},{createdAt:cursor.createdAt,id:{[Op.lt]:cursor.id}}];}
   const rows=await Message.findAll({where,include:[{model:User,attributes:['name']}],order:[['createdAt','DESC'],['id','DESC']],limit:limit+1,offset,transaction});
   const more=rows.length>limit;const items=rows.slice(0,limit).map(row=>this.dto(row));
   return {room:room.toJSON(),items,nextCursor:more?items.at(-1).id:null};
  });
 }
 static async history(actor,scope,referenceId,{limit=50,offset=0}={}) {
  return this.transaction(async transaction=>{
   const ref=await this.reference(scope,referenceId,transaction);
   // Membership snapshot is the source of truth, including rider's old rooms.
   if(scope==='DISPATCH'){
    const participant=await Participant.findOne({where:{userId:actor.userId},include:[{model:Room,where:{scope,referenceId},required:true}],transaction});
    const provider=ref.providerId?await Provider.findByPk(ref.providerId,{transaction}):null;
    if(!participant&&ref.userId!==actor.userId&&provider?.userId!==actor.userId)throw new NotFoundException();
    await this.synchronizeDispatch(ref,transaction);
    const rooms=await Room.findAll({where:{scope,referenceId,isArchived:true},include:[{model:Participant,where:{userId:actor.userId},attributes:[],required:true}],limit,offset,order:[['version','DESC']],transaction});
    return rooms;
   }
   const {room}=await this.room(actor,scope,referenceId,transaction);return room.isArchived?[room]:[];
  });
 }
 static async send(actor,scope,referenceId,data={},files=[]) {
  const text=typeof data.content==='string'?data.content.trim():'';
  if(text.length>1000||(!text&&!files.length&&!data.assetIds?.length))throw new BadRequestException('Cần nội dung 1–1000 ký tự hoặc ảnh');
  const compressed=await require('../middlewares/upload.middleware').compress(files);
  if(compressed.length+(data.assetIds?.length||0)>3)throw new BadRequestException('Tối đa 3 ảnh');
  return retry(()=>Storage.withUploads(keys=>db.transaction(async transaction=>{
   await User.findOne({where:{userId:actor.userId},transaction,lock:transaction.LOCK.UPDATE});
   const {room,ref}=await this.room(actor,scope,referenceId,transaction);
   if((data.expectedRoomId||data.roomId)&&(data.expectedRoomId||data.roomId)!==room.id)throw new ConflictException('Phiên chat đã thay đổi, hãy tham gia phòng mới');
   if(room.isArchived)throw new ConflictException('Phòng chat đã lưu trữ, chỉ được đọc');
   if(data.clientMessageId){const existing=await Message.findOne({where:{roomId:room.id,senderId:actor.userId,clientMessageId:data.clientMessageId},include:[{model:User,attributes:['name']}],transaction});if(existing)return {...this.dto(existing),duplicate:true};}
   const count=await Message.count({where:{roomId:room.id,senderId:actor.userId,createdAt:{[Op.gt]:new Date(Date.now()-60000)}},transaction});
   if(count>=10)throw new BaseException({code:'CHAT_RATE_LIMIT',message:'Tối đa 10 tin nhắn/phút trong một phòng',statusCode:429});
   const id=require('node:crypto').randomUUID();const images=[];
   for(const assetId of data.assetIds||[]){
    const asset=await S3Asset.findOne({where:{id:assetId,userId:actor.userId,attachedTo:null},transaction,lock:transaction.LOCK.UPDATE});
    if(!asset||!asset.mimeType.startsWith('image/'))throw new BadRequestException('Ảnh không thuộc tài khoản hoặc đã được sử dụng');
    await asset.update({attachedTo:`chat:${id}`},{transaction});images.push(asset.s3Url);
   }
   for(const image of compressed){const uploaded=await Storage.upload({body:image.content,mimeType:image.mimeType,originalName:'chat.webp',userId:actor.userId,transaction,attachedTo:`chat:${id}`,keys});images.push(uploaded.url);}
   const member=scope==='DISPATCH'?await Participant.findOne({where:{roomId:room.id,userId:actor.userId},transaction}):null;
   const message=await Message.create({id,roomId:room.id,senderId:actor.userId,senderRole:member?.role||'COMMUNITY',content:text||null,images,clientMessageId:data.clientMessageId||null},{transaction});
   const user=await User.findOne({where:{userId:actor.userId},attributes:['name'],transaction});message.User=user;
   return this.dto(message);
  })));
 }
 static async systemMessage(ticket,event,content,transaction) {
  if(!['STATUS_CHANGED','UNFIXABLE','TOW_OFFER','PROVIDER_CHANGED'].includes(event))throw new Error('Unsupported system event');
  const room=await this.synchronizeDispatch(ticket,transaction);
  return Message.create({roomId:room.id,senderRole:'SYSTEM',systemEvent:event,content:String(content).slice(0,1000)},{transaction});
 }
 static broadcast(app,scope,referenceId,message) {
  if(message.duplicate)return;
  const io=app.get('chatIO')||app.get('hazardIO');if(!io)return;
  io.to(`chat:${message.roomId}`).emit('chat:message',{scope,referenceId,...message});
  if(scope==='HAZARD')io.to(`flag:${referenceId}`).emit('flag:message',{...message,flagId:referenceId,text:message.content});
 }
}
module.exports=ChatService;
