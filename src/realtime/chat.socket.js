const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const config = require('../config/app.config');
const JWT = require('../services/jwt.service');
const Chat = require('../services/chat.service');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
module.exports = (server, app) => {
 const io = new Server(server, { cors: { origin:config.cors, credentials:true }, maxHttpBufferSize:16384, pingTimeout:config.socket.pingTimeout,pingInterval:config.socket.pingInterval,
  allowRequest:(req,done)=>{if(!req.headers.origin)return done(null,false);config.cors(req.headers.origin,error=>done(null,!error));} });
 io.use(async(socket,next)=>{
  try {await new Promise((resolve,reject)=>cookieParser()(socket.request,{},error=>error?reject(error):resolve()));
   socket.data.token=socket.request.cookies?.road_as_token;
   if(!socket.data.token||!await JWT.verifyUserSession(socket.data.token))throw new Error('Unauthorized');next();
  }catch{next(new Error('Unauthorized'));}
 });
 require('../services/dispatch_notification.service').setIO(io);
 require('../services/finance_notification.service').setIO(io);
 io.on('connection',socket=>{
  JWT.verifyUserSession(socket.data.token).then(actor=>{if(actor){socket.join(`user:${actor.userId}`);require('../services/dispatch_notification.service').deliver().catch(error=>console.error('[Dispatch notifications]',error.message));}}).catch(()=>socket.disconnect(true));
  const timer=setInterval(async()=>{try{if(!await JWT.verifyUserSession(socket.data.token))socket.disconnect(true);}catch{socket.disconnect(true);}},15000);timer.unref();socket.on('disconnect',()=>clearInterval(timer));
  const handle=(event,legacy,action)=>socket.on(event,async(data,ack)=>{
   const reply=typeof ack==='function'?ack:()=>{};
   try{
    const actor=await JWT.verifyUserSession(socket.data.token);if(!actor){socket.disconnect(true);return;}
    if(!data||typeof data!=='object')throw new Error('Invalid input');
    const scope=legacy?'HAZARD':data.scope;const referenceId=legacy?data.flagId:data.referenceId;
    if(!['HAZARD','DISPATCH'].includes(scope)||!uuid(referenceId))throw new Error('Invalid reference');
    reply({success:true,data:await action(actor,scope,referenceId,data,legacy)});
   }catch(error){reply({success:false,message:error.statusCode?error.message:'Yêu cầu không hợp lệ',error_code:error.errorCode||'INVALID_SOCKET_REQUEST'});}
  });
  const join=async(actor,scope,referenceId,data,legacy)=>{
   if(socket.rooms.size>40)throw new Error('Too many rooms');
   if(data.version!==undefined&&(!Number.isSafeInteger(data.version)||data.version<1))throw new Error('Invalid version');
   const result=await Chat.list(actor,scope,referenceId,{version:data.version,limit:1});
   await socket.join(`chat:${result.room.id}`);
   if(legacy)await socket.join(`flag:${referenceId}`);
   return {joined:true,room:result.room};
  };
  const leave=async(actor,scope,referenceId,data,legacy)=>{
   const result=await Chat.list(actor,scope,referenceId,{version:data.version,limit:1});
   await socket.leave(`chat:${result.room.id}`);if(legacy)await socket.leave(`flag:${referenceId}`);return {left:true};
  };
  const send=async(actor,scope,referenceId,data,legacy)=>{
   const current=await Chat.list(actor,scope,referenceId,{limit:1});
   if(!socket.rooms.has(`chat:${current.room.id}`))throw new Error('Join the current room first');
   if(data.clientMessageId!==undefined&&!uuid(data.clientMessageId))throw new Error('Invalid message ID');
   if(data.assetIds!==undefined&&(!Array.isArray(data.assetIds)||data.assetIds.length>3||new Set(data.assetIds).size!==data.assetIds.length||!data.assetIds.every(uuid)))throw new Error('Invalid images');
   const content=legacy?data.text:data.content;if(content!==undefined&&typeof content!=='string')throw new Error('Invalid content');
   // expectedRoomId closes the reassign-between-authorization-and-send race.
   const message=await Chat.send(actor,scope,referenceId,{content,clientMessageId:data.clientMessageId,assetIds:data.assetIds,expectedRoomId:current.room.id});
   Chat.broadcast(app,scope,referenceId,message);return legacy?{...message,flagId:referenceId,text:message.content}:message;
  };
  for(const [suffix,action] of [['join',join],['leave',leave],['message',send]]){handle(`chat:${suffix}`,false,action);handle(`flag:${suffix}`,true,action);}
 });
 app.set('chatIO',io);app.set('hazardIO',io);return io;
};
