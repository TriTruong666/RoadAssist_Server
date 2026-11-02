// Deterministic AWS transport for DB integration tests; never reaches a real bucket.
const { mock } = require('node:test');
const Storage=require('../src/services/s3.service');
const config=require('../src/config/app.config').s3;
Object.assign(config,{accessKeyId:'test',secretAccessKey:'test',region:'ap-southeast-1',bucketName:'picare-s3',publicBaseUrl:'https://s3.test'});
const objects=new Map();const calls=[];
mock.method(Storage,'uploadToS3',async params=>{calls.push(params);objects.set(params.Key,Buffer.from(params.Body));return{ETag:'"test-etag"'};});
const client=require('../src/config/s3.config');
mock.method(client,'send',async command=>{
 calls.push(command);
 if(command.constructor.name==='DeleteObjectCommand'){objects.delete(command.input.Key);return{};}
 if(command.constructor.name==='DeleteObjectsCommand'){for(const o of command.input.Delete.Objects)objects.delete(o.Key);return{};}
 if(command.constructor.name==='HeadObjectCommand'){if(!objects.has(command.input.Key)){const e=new Error('Not found');e.name='NotFound';throw e;}return{ContentLength:objects.get(command.input.Key).length};}
 throw new Error('Unexpected S3 test command');
});
module.exports={objects,calls,Storage,client};
