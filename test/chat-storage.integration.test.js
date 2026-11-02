const {test,before,after}=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
if(process.env.RUN_DB_TESTS!=='1')test('Unified chat/S3 integration (RUN_DB_TESTS=1)',{skip:true},()=>{});
else{
 const suffix=randomUUID().replaceAll('-','');Object.assign(process.env,{NODE_ENV:'test',DB_SCHEMA:`chat_test_${suffix}`,AUTH_REDIS_PREFIX:`test:${suffix}:auth:`,PROVIDER_REDIS_PREFIX:`test:${suffix}:provider:`,JWT_SECRET:randomUUID()+randomUUID(),ALLOWED_CLIENT_URL_1:'http://localhost:5173'});
 const fixture=require('./s3.fixture');const {app}=require('../index');const db=require('../src/config/postgres.config');const redis=require('../src/config/redis.config');const {DataTypes:D}=require('sequelize');
 const {User,Provider,ChatRoom,ChatParticipant,ChatMessage,S3Asset,HazardFlag,HazardMessage,HazardImage,StorageCleanup}=require('../src/models');
 const Chat=require('../src/services/chat.service');const Storage=require('../src/services/s3.service');const Auth=require('../src/services/auth.service');
 const Ticket=db.define('DispatchTicket',{id:{type:D.UUID,primaryKey:true,defaultValue:D.UUIDV4},userId:{type:D.UUID,allowNull:false},providerId:D.UUID,status:{type:D.STRING,defaultValue:'2'},chatVersion:{type:D.INTEGER,defaultValue:1}});
 let server,io,base,rider,first,second,outsider,provider1,provider2;const sockets=[];
 const origin={latitude:10.77,longitude:106.69};
 async function account(n){const user=await User.create({name:`Chat ${n}`,email:`chat-${n}@example.com`,phone:`09330000${String(n).padStart(2,'0')}`,password:'Chat-integration-strong-password!',emailVerifiedAt:new Date()});const session=await Auth.completeLogin({userId:user.userId,ipAddress:'127.0.0.1'});return{userId:user.userId,token:session.token};}
 async function request(actor,method,path,body,status=200){const form=body instanceof FormData;const response=await fetch(base+'/api/v1'+path,{method,headers:{...(actor&&{Cookie:`road_as_token=${actor.token}`}),...(!form&&body!==undefined&&{'Content-Type':'application/json'})},...(body!==undefined&&{body:form?body:JSON.stringify(body)})});const json=await response.json();assert.equal(response.status,status,JSON.stringify(json));return json.data;}
 async function connect(actor){const socket=require('socket.io-client').io(base,{transports:['websocket'],reconnection:false,extraHeaders:{Origin:'http://localhost:5173',Cookie:`road_as_token=${actor.token}`}});sockets.push(socket);await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});return socket;}
 const emit=(socket,event,data)=>new Promise(resolve=>socket.emit(event,data,resolve));
 async function ticket(){return Ticket.create({userId:rider.userId,providerId:provider1.id});}
 async function reassign(row,providerId){return db.transaction(async transaction=>{const locked=await Ticket.findByPk(row.id,{transaction,lock:transaction.LOCK.UPDATE});await locked.update({providerId},{transaction});return Chat.synchronizeDispatch(locked,transaction);});}
 before(async()=>{await db.authenticate();await db.createSchema(process.env.DB_SCHEMA);await db.sync();await redis.connect();server=require('http').createServer(app);io=require('../src/realtime/chat.socket')(server,app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  [rider,first,second,outsider]=await Promise.all([1,2,3,4].map(account));
  const provider=(actor,name)=>Provider.create({userId:actor.userId,name,kind:'SHOP',phone:'0901234567',...origin,address:'Test',capabilities:['TYRE_REPAIR'],supportedVehicleTypes:['BIKE'],status:'ACTIVE'});
  provider1=await provider(first,'First');provider2=await provider(second,'Second');
 });
 after(async()=>{sockets.forEach(socket=>socket.close());if(io)await new Promise(resolve=>io.close(resolve));if(server?.listening)await new Promise(resolve=>server.close(resolve));const keys=await redis.keys(process.env.AUTH_REDIS_PREFIX+'*');if(keys.length)await redis.del(...keys);redis.disconnect();await db.dropSchema(process.env.DB_SCHEMA,{cascade:true});await db.close();});
 test('dispatch membership snapshots isolate reassigned providers; archives remain read-only',async()=>{
  const row=await ticket();const path=`/chat/DISPATCH/${row.id}`;
  await request(outsider,'GET',path,undefined,404);
  const initial=await request(rider,'GET',path);assert.equal(initial.room.version,1);
  await request(first,'POST',path+'/messages',{content:'Private with first',clientMessageId:randomUUID()},201);
  const next=await reassign(row,provider2.id);assert.equal(next.version,2);
  const current=await request(second,'GET',path);assert.equal(current.items.length,0);
  await request(second,'GET',path+'?version=1',undefined,404);
  await request(first,'GET',path,undefined,404);
  await request(first,'POST',path+'/messages',{content:'Old provider'},404);
  const archived=await request(first,'GET',path+'?version=1');assert.equal(archived.room.isArchived,true);assert.equal(archived.items[0].content,'Private with first');
  assert.equal((await request(first,'GET',path+'/history')).length,1);
  assert.equal((await request(second,'GET',path+'/history')).length,0);
  await request(rider,'POST',path+'/messages',{content:'stale view',roomId:initial.room.id},409);
  await request(rider,'POST',path+'/messages',{content:'new room',roomId:next.id},201);
  await row.reload();await row.update({status:'4'});
  assert.equal((await request(second,'GET',path)).room.isArchived,true);
  await request(second,'POST',path+'/messages',{content:'after completion'},409);
 });
 test('concurrent dispatch room creation/reassignment has a single version and trusted system events',async()=>{
  const row=await ticket();const rooms=await Promise.all(Array.from({length:5},()=>Chat.list(rider,'DISPATCH',row.id)));assert.equal(new Set(rooms.map(r=>r.room.id)).size,1);
  await Promise.all([reassign(row,provider2.id),reassign(row,provider2.id)]);assert.equal(await ChatRoom.count({where:{referenceId:row.id}}),2);
  await db.transaction(async transaction=>{await Chat.systemMessage(row,'STATUS_CHANGED','Đã nhận cuốc',transaction);});
  const result=await Chat.list(second,'DISPATCH',row.id);assert.equal(result.items[0].senderRole,'SYSTEM');assert.equal(result.items[0].systemEvent,'STATUS_CHANGED');
  const data=await request(second,'POST',`/chat/DISPATCH/${row.id}/messages`,{content:'Cannot forge',senderRole:'SYSTEM',systemEvent:'STATUS_CHANGED'},201);assert.equal(data.senderRole,'PROVIDER');assert.equal(data.systemEvent,null);
 });
 test('hazard legacy APIs and unified chat share one room, idempotency, quota and cursor history',async()=>{
  const flag=await HazardFlag.create({userId:rider.userId,...origin,expiresAt:new Date(Date.now()+3600000)});const path=`/chat/HAZARD/${flag.id}`;const clientMessageId=randomUUID();
  const replies=await Promise.all([1,2,3].map(()=>request(rider,'POST',path+'/messages',{content:'one message',clientMessageId},201)));assert.equal(new Set(replies.map(r=>r.id)).size,1);
  await request(first,'POST',`/flags/${flag.id}/messages`,{text:'legacy endpoint'},201);
  const result=await request(rider,'GET',path+'?limit=1');assert.equal(result.items.length,1);assert.ok(result.nextCursor);
  const next=await request(rider,'GET',path+'?before='+result.nextCursor);assert.equal(next.items.length,1);assert.notEqual(next.items[0].id,result.items[0].id);
  assert.equal((await request(first,'GET',`/flags/${flag.id}/messages`)).length,2);
  for(let i=0;i<9;i++)await request(rider,'POST',path+'/messages',{content:'message '+i},201);
  await request(rider,'POST',`/flags/${flag.id}/messages`,{text:'over shared quota'},429);
  await flag.update({status:'4'});assert.equal((await request(rider,'GET',path)).room.isArchived,true);
 });
 test('chat uploads use public roadassist objects; asset claims enforce ownership and single use',async()=>{
  const flag=await HazardFlag.create({userId:rider.userId,...origin,expiresAt:new Date(Date.now()+3600000)});const path=`/chat/HAZARD/${flag.id}/messages`;
  const png=await require('sharp')({create:{width:2,height:2,channels:3,background:'blue'}}).png().toBuffer();
  const form=new FormData();form.append('images',new Blob([png],{type:'image/png'}),'chat.png');
  const asset=(await request(rider,'POST','/uploads',form,201)).items[0];assert.equal(asset.visibility,'public');assert.equal(asset.folder,'roadassist');assert.match(asset.key,/^roadassist\/[^/]+$/);
  await request(first,'POST',path,{content:'stolen',assetIds:[asset.id]},400);
  const message=await request(rider,'POST',path,{assetIds:[asset.id]},201);assert.deepEqual(message.images,[asset.url]);assert.equal(message.content,null);
  await request(rider,'POST',path,{assetIds:[asset.id]},400);
  await request(rider,'POST',path,{content:'remote',images:['https://arbitrary/image']},400);
  const inline=new FormData();inline.set('content','with image');inline.append('images',new Blob([png],{type:'image/png'}),'chat.png');
  assert.equal((await request(rider,'POST',path,inline,201)).images.length,1);
  const uploadParams=fixture.calls.filter(v=>v.Bucket);assert.ok(uploadParams.length>=2);assert.ok(uploadParams.every(p=>p.Bucket==='picare-s3'&&!Object.hasOwn(p,'ACL')));
 });
 test('failed multi-image upload compensates objects and database writes; failed cleanup is retried',async()=>{
  const flag=await HazardFlag.create({userId:rider.userId,...origin,expiresAt:new Date(Date.now()+3600000)});const beforeObjects=new Set(fixture.objects.keys());const beforeAssets=await S3Asset.count();const beforeMessages=await ChatMessage.count();
  const png=await require('sharp')({create:{width:2,height:2,channels:3,background:'green'}}).png().toBuffer();const form=new FormData();for(let i=0;i<2;i++)form.append('images',new Blob([png],{type:'image/png'}),'x.png');
  const original=Storage.uploadToS3;let count=0;Storage.uploadToS3=async params=>{if(++count===2)throw new Error('AWS secret error');return original.call(Storage,params);};
  try{await request(rider,'POST',`/chat/HAZARD/${flag.id}/messages`,form,503);}finally{Storage.uploadToS3=original;}
  assert.equal(await S3Asset.count(),beforeAssets);assert.equal(await ChatMessage.count(),beforeMessages);assert.deepEqual(new Set(fixture.objects.keys()),beforeObjects);
  const deletion=Storage.delete;Storage.delete=async()=>{throw new Error('offline');};const key=Storage.buildKey('ignored','retry.webp');try{await Storage.cleanup([key]);}finally{Storage.delete=deletion;}
  assert.equal(await StorageCleanup.count({where:{key}}),1);await Storage.retryCleanup();assert.equal(await StorageCleanup.count({where:{key}}),0);
 });
 test('legacy hazard messages and database images migrate idempotently without losing IDs or history',async()=>{
  const flag=await HazardFlag.create({userId:rider.userId,...origin,status:'4',expiresAt:new Date(Date.now()-1000)});const legacy=await HazardMessage.create({flagId:flag.id,userId:rider.userId,text:'Old history'});
  const migrate=require('../src/config/chat.migrations').migrateHazardChat;assert.equal(await migrate(),1);assert.equal(await migrate(),0);
  const migrated=await Chat.list(first,'HAZARD',flag.id);assert.equal(migrated.items[0].id,legacy.id);assert.equal(migrated.room.isArchived,true);
  const bytes=Buffer.from('legacy-test-image');const image=await HazardImage.create({flagId:flag.id,content:bytes,mimeType:'image/webp',size:bytes.length});
  const migrateStorage=require('../src/services/storage_migration.service');assert.equal(await migrateStorage(),1);assert.equal(await migrateStorage(),0);
  await image.reload({attributes:['id','content','s3Key']});assert.equal(image.content,null);assert.deepEqual(fixture.objects.get(image.s3Key),bytes);
 });
 test('dispatch socket membership is rechecked and new provider messages never reach the old room',async()=>{
  const row=await ticket();const socket1=await connect(first);const join1=await emit(socket1,'chat:join',{scope:'DISPATCH',referenceId:row.id});assert.equal(join1.success,true);
  await reassign(row,provider2.id);const socket2=await connect(second);assert.equal((await emit(socket2,'chat:join',{scope:'DISPATCH',referenceId:row.id})).success,true);
  let leaked=false;socket1.on('chat:message',()=>{leaked=true;});
  const ack=await emit(socket2,'chat:message',{scope:'DISPATCH',referenceId:row.id,content:'new private conversation'});assert.equal(ack.success,true);
  const denied=await emit(socket1,'chat:message',{scope:'DISPATCH',referenceId:row.id,content:'stale'});assert.equal(denied.success,false);
  assert.equal(leaked,false);assert.equal((await emit(socket2,'chat:join',{scope:'DISPATCH',referenceId:row.id,version:1})).success,false);
 });
}
