const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
if (process.env.RUN_DB_TESTS !== '1') {
 test('Phase 4 PostgreSQL/Redis integration (RUN_DB_TESTS=1)', { skip: true }, () => {});
} else {
 const suffix = randomUUID().replaceAll('-', '');
 Object.assign(process.env, { NODE_ENV: 'test', DB_SCHEMA: `phase4_test_${suffix}`, AUTH_REDIS_PREFIX: `test:${suffix}:auth:`, PROVIDER_REDIS_PREFIX: `test:${suffix}:providers:`, JWT_SECRET: randomUUID()+randomUUID(), ALLOWED_CLIENT_URL_1: 'http://localhost:5173' });
 const s3Fixture = require('./s3.fixture');
 const { app } = require('../index');
 const db = require('../src/config/postgres.config');
 const redis = require('../src/config/redis.config');
 const { User, HazardFlag: Flag, HazardVote: Vote, HazardImage: Image } = require('../src/models');
 const Flags = require('../src/services/flag.service');
 const Auth = require('../src/services/auth.service');
 const axios = require('axios');
 const origin = { latitude: 10.77, longitude: 106.69 };
 let server, io, base, owner, admin, users;
 async function account(n, role = 'guest') {
  const user = await User.create({ name: `Phase4 ${n}`, email: `phase4-${n}@example.com`, phone: `09440000${n.toString().padStart(2,'0')}`, password: 'Phase4-strong-password!', emailVerifiedAt: new Date(), role });
  const session = await Auth.completeLogin({ userId: user.userId, ipAddress: '127.0.0.1' });
  return { userId: user.userId, token: session.token, role };
 }
 async function request(actor, method, path, body, expected = 200) {
  const form = body instanceof FormData;
  const response = await fetch(base+'/api/v1'+path, { method, headers: { ...(actor && { Cookie: `road_as_token=${actor.token}` }), ...(!form && body !== undefined && { 'Content-Type': 'application/json' }) }, ...(body !== undefined && { body: form ? body : JSON.stringify(body) }) });
  const json = await response.json();
  assert.equal(response.status, expected, JSON.stringify(json)); return json.data;
 }
 const create = extra => request(owner, 'POST', '/flags', { ...origin, ...extra }, 201);
 before(async () => {
  await db.authenticate(); await db.createSchema(process.env.DB_SCHEMA); await db.sync(); await redis.connect();
  server = require('http').createServer(app); io = require('../src/realtime/hazard.socket')(server, app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  owner = await account(1); admin = await account(2, 'admin'); users = await Promise.all([3,4,5,6,7].map(n => account(n)));
 });
 after(async () => {
  if (io) await new Promise(resolve => io.close(resolve));
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  const keys = await redis.keys(process.env.AUTH_REDIS_PREFIX+'*'); if (keys.length) await redis.del(...keys);
  redis.disconnect(); await db.dropSchema(process.env.DB_SCHEMA, { cascade: true }); await db.close();
 });
 test('saved places and GeoJSON routes are cookie-authenticated, validated and isolated by owner', async () => {
  await request(null, 'GET', '/places/saved', undefined, 401);
  const place = await request(owner, 'POST', '/places/saved', { ...origin, name: 'Nhà', category: 'HOME', userId: admin.userId }, 201);
  assert.equal(place.userId, undefined);
  assert.equal((await request(owner,'GET','/places/saved')).total, 1);
  assert.equal((await request(admin,'GET','/places/saved')).total, 0);
  await request(admin,'DELETE',`/places/saved/${place.id}`,undefined,404);
  await request(owner,'POST','/places/saved',{ ...origin, name: 'x', latitude: 91 },400);
  const route = { name: 'Đi làm', stops: [origin, { ...origin, latitude: 10.78 }], geometry: { type: 'LineString', coordinates: [[106.69,10.77],[106.69,10.78]] } };
  const saved = await request(owner,'POST','/places/routes',route,201);
  assert.deepEqual((await request(owner,'GET','/places/routes')).items[0].geometry, route.geometry);
  await request(admin,'DELETE',`/places/routes/${saved.id}`,undefined,404);
  await request(owner,'POST','/places/routes',{ ...route, geometry: { type:'LineString', coordinates:[[999,90],[0,0]] } },400);
  await request(owner,'DELETE',`/places/routes/${saved.id}`);
  await request(owner,'DELETE',`/places/saved/${place.id}`);
 });
 test('three distinct votes atomically confirm and award reputation once; confirmed and locked states enforce rights', async () => {
  const flag = await create({ ttlMinutes: 60, radiusMeters: 25 });
  assert.equal(flag.userId, undefined); assert.equal(flag.status,'1');
  assert.ok(Math.abs(new Date(flag.expiresAt)-Date.now()-3600000)<3000);
  await request(owner,'POST',`/flags/${flag.id}/vote`,{ voteType:'CONFIRM' },403);
  const repeated = await Promise.all(Array.from({ length: 4 }, () => fetch(base+`/api/v1/flags/${flag.id}/vote`, { method:'POST',headers:{Cookie:`road_as_token=${users[0].token}`,'Content-Type':'application/json'},body:JSON.stringify({voteType:'CONFIRM'}) })));
  assert.deepEqual(repeated.map(r=>r.status).sort(),[200,409,409,409]);
  await Promise.all([1,2].map(i=>request(users[i],'POST',`/flags/${flag.id}/vote`,{voteType:'CONFIRM'})));
  const detail = await request(null,'GET',`/flags/${flag.id}`);
  assert.equal(detail.status,'2'); assert.equal(detail.confirmVotes,3);
  assert.equal(await Vote.count({where:{flagId:flag.id}}),3);
  assert.equal((await User.findOne({where:{userId:owner.userId}})).reputationPoints,1);
  await request(users[3],'POST',`/flags/${flag.id}/vote`,{voteType:'DENY'},409);
  await request(owner,'PUT',`/admin/flags/${flag.id}/lock`,{},403);
  await request(admin,'PUT',`/admin/flags/${flag.id}/lock`,{});
  await request(owner,'POST',`/flags/${flag.id}/unflag`,{},403);
  await request(owner,'PUT',`/admin/flags/${flag.id}/unlock`,{},403);
  await request(admin,'PUT',`/admin/flags/${flag.id}/unlock`,{});
  await request(users[3],'POST',`/flags/${flag.id}/vote`,{voteType:'CONFIRM'},409);
  assert.equal((await User.findOne({where:{userId:owner.userId}})).reputationPoints,1);
  await request(admin,'PUT',`/admin/flags/${flag.id}/lock`,{});
  await request(admin,'DELETE',`/admin/flags/${flag.id}`);
  assert.equal((await Flag.findByPk(flag.id)).status,'4');
 });
 test('deny consensus, ownership removal and TTL apply before cron and include locked expiration', async () => {
  const denied = await create();
  await Promise.all(users.slice(0,3).map(u=>request(u,'POST',`/flags/${denied.id}/vote`,{voteType:'DENY'})));
  assert.equal((await Flag.findByPk(denied.id)).status,'4');
  const flag = await create();
  await request(users[0],'POST',`/flags/${flag.id}/unflag`,{},403);
  await request(admin,'PUT',`/admin/flags/${flag.id}/lock`,{},409);
  await Flag.update({expiresAt:new Date(Date.now()-1000),status:'3'},{where:{id:flag.id}});
  assert.equal((await request(null,'GET',`/flags/${flag.id}`)).status,'4');
  assert.ok(!(await request(null,'GET',`/flags/nearby?latitude=${origin.latitude}&longitude=${origin.longitude}`)).some(f=>f.id===flag.id));
  await request(users[0],'POST',`/flags/${flag.id}/vote`,{voteType:'CONFIRM'},409);
  await request(owner,'POST',`/flags/${flag.id}/messages`,{text:'late'},409);
  assert.equal(await Flags.expire(),1); assert.equal(await Flags.expire(),0);
  assert.equal((await Flag.findByPk(flag.id)).removedReason,'EXPIRED');
  const own = await create(); await request(owner,'POST',`/flags/${own.id}/unflag`,{});
 });
 test('nearby exact distances and pagination validation exclude far-away reports', async () => {
  const alias = await request(owner,'POST','/flags',{lat:10.77,lng:106.69},201);
  assert.equal(alias.latitude,10.77);
  assert.ok((await request(null,'GET','/flags/nearby?lat=10.77&lng=106.69')).some(f=>f.id===alias.id));
  await request(owner,'POST','/flags',{...origin,lat:11},400);
  const near = await create(); const far = await create({latitude:11.1});
  const items = await request(null,'GET',`/flags/nearby?latitude=${origin.latitude}&longitude=${origin.longitude}&limit=100`);
  assert.ok(items.some(f=>f.id===near.id)); assert.ok(!items.some(f=>f.id===far.id));
  assert.ok(items.every(f=>f.distanceMeters<=2000));
  await request(null,'GET','/flags/nearby?latitude=NaN&longitude=106',undefined,400);
  await request(owner,'GET','/flags/my?limit=1000',undefined,400);
  assert.ok((await request(owner,'GET','/flags/my')).total>0);
 });
 test('multipart evidence is decoded, stripped and compressed; spoofed and excess images rejected atomically', async () => {
  const png = await require('sharp')({create:{width:8,height:8,channels:3,background:'#ff0000'}}).png().toBuffer();
  const form = () => {const f = new FormData();f.set('latitude','10.77');f.set('longitude','106.69');return f;};
  const f = form(); f.append('images',new Blob([png],{type:'image/png'}),'scene.png');
  const flag = await request(owner,'POST','/flags',f,201);
  assert.equal(flag.images.length,1); assert.ok(flag.images[0].size<=800*1024);
  assert.ok(flag.images[0].url.startsWith('https://s3.test/roadassist/'));
  const stored = await Image.unscoped().findByPk(flag.images[0].id); assert.equal(stored.content,null);
  assert.equal(s3Fixture.objects.get(stored.s3Key).toString('ascii',8,12),'WEBP');
  const count = await Flag.count();
  const bad = form();bad.append('images',new Blob(['fake'],{type:'image/png'}),'fake.png'); await request(owner,'POST','/flags',bad,400);
  const many = form();for(let i=0;i<4;i++)many.append('images',new Blob([png],{type:'image/png'}),'scene.png'); await request(owner,'POST','/flags',many,400);
  assert.equal(await Flag.count(),count);
  await request(owner,'POST','/flags',{...origin,images:['https://arbitrary.example/image']},400);
 });
 test('chat persists messages, prevents anonymous writes and limits spam', async () => {
  const flag = await create();
  await request(null,'POST',`/flags/${flag.id}/messages`,{text:'x'},401);
  await request(owner,'POST',`/flags/${flag.id}/messages`,{text:'   '},400);
  for(let i=0;i<10;i++) await request(owner,'POST',`/flags/${flag.id}/messages`,{text:`Water ${i}`},201);
  await request(owner,'POST',`/flags/${flag.id}/messages`,{text:'spam'},429);
  const rows = await request(users[0],'GET',`/flags/${flag.id}/messages?limit=5`); assert.equal(rows.length,5); assert.equal(rows[0].userId,undefined); assert.equal(rows[0].authorName,'Phase4 1');
 });
 test('Socket.IO requires cookie and allowed Origin; room chat broadcasts committed messages', async () => {
  const connect = (token, origin='http://localhost:5173') => require('socket.io-client').io(base,{transports:['websocket'],reconnection:false,extraHeaders:{Origin:origin,...(token&&{Cookie:`road_as_token=${token}`})}});
  for (const [token,origin] of [[null,'http://localhost:5173'],[owner.token,'https://attacker.example']]) {
   const socket=connect(token,origin);try {await new Promise((resolve,reject)=>{socket.once('connect',()=>reject(new Error('Unexpected connection')));socket.once('connect_error',resolve);});}finally{socket.close();}
  }
  const flag=await create();const socket=connect(owner.token);
  try {
   await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
   const emit=(event,data)=>new Promise(resolve=>socket.emit(event,data,resolve));
   assert.equal((await emit('flag:join',{flagId:flag.id})).success,true);
   const broadcast=new Promise(resolve=>socket.once('flag:message',resolve));
   const ack=await emit('flag:message',{flagId:flag.id,text:'Hiện trường đang ngập'});assert.equal(ack.success,true);assert.equal((await broadcast).id,ack.data.id);
   await request(owner,'POST',`/flags/${flag.id}/unflag`,{});
   assert.equal((await emit('flag:message',{flagId:flag.id,text:'closed'})).success,false);
  } finally {socket.close();}
 });
 test('routing sends only current confirmed polygons; upstream failures stay structured and saved geometry needs no routing call', async t => {
  const flag=await create({radiusMeters:100});await Flag.update({status:'2'},{where:{id:flag.id}});
  const config=require('../src/config/app.config'); const oldKey=config.maps.maptilerApiKey;config.maps.maptilerApiKey='test-key';
  t.mock.method(axios,'get',async()=>({data:{features:[{id:'1',text:'Test',place_name:'Test address',center:[106.69,10.77]}]}}));
  t.mock.method(axios,'post',async(url,body)=>{
   assert.ok(body.exclude_polygons.length>=1);assert.equal(body.shape_format,'geojson');
   assert.ok(body.exclude_polygons.every(r=>r.length===17&&r[0][0]===r[16][0]));
   return {data:{trip:{legs:[{shape:{type:'LineString',coordinates:[[106.69,10.77],[106.7,10.78]]}}],summary:{length:2}}}};
  });
  try {
   assert.equal((await request(owner,'GET','/places/search?q=Saigon')).items[0].name,'Test');
   const solved=await request(owner,'POST','/places/route',{stops:[origin,{latitude:10.78,longitude:106.7}]});assert.ok(solved.avoidedFlagIds.includes(flag.id));
   axios.post.mock.mockImplementation(async()=>{throw new Error('private upstream secret');});
   await request(owner,'POST','/places/route',{stops:[origin,origin]},503);
   await request(owner,'POST','/places/routes',{name:'Cached',stops:[origin,origin],geometry:solved.geometry},201);
  }finally{config.maps.maptilerApiKey=oldKey;}
 });
}
