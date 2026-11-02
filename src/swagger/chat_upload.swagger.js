const ref=name=>({$ref:`#/components/schemas/${name}`});
const uuid={type:'string',format:'uuid'};
const schemas={
 ChatRoom:{type:'object',properties:{id:uuid,scope:{type:'string',enum:['HAZARD','DISPATCH']},referenceId:uuid,version:{type:'integer'},isArchived:{type:'boolean'},providerId:{...uuid,nullable:true}}},
 ChatMessage:{type:'object',properties:{id:uuid,roomId:uuid,senderRole:{type:'string',enum:['RIDER','PROVIDER','COMMUNITY','SYSTEM']},authorName:{type:'string'},content:{type:'string',nullable:true,maxLength:1000},images:{type:'array',maxItems:3,items:{type:'string',format:'uri'}},systemEvent:{type:'string',nullable:true},clientMessageId:{...uuid,nullable:true},createdAt:{type:'string',format:'date-time'},duplicate:{type:'boolean'}}},
 ChatSendInput:{type:'object',description:'Content or at least one image is required. JSON accepts owned unused assetIds from /uploads. Multipart accepts up to three images files. Sender role and system events are server assigned.',properties:{content:{type:'string',maxLength:1000},clientMessageId:uuid,roomId:{...uuid,description:'Expected room ID; 409 if assignment changed since the UI loaded'},assetIds:{type:'array',maxItems:3,uniqueItems:true,items:uuid}}},
 PublicUpload:{type:'object',properties:{id:uuid,key:{type:'string',pattern:'^roadassist/[^/]+$'},url:{type:'string',format:'uri'},folder:{type:'string',enum:['roadassist']},visibility:{type:'string',enum:['public']},mimeType:{type:'string'},size:{type:'integer'}}},
};
const envelope=schema=>({type:'object',properties:{success:{type:'boolean'},message:{type:'string'},data:schema}});
const scopeParams=[{name:'scope',in:'path',required:true,schema:{type:'string',enum:['HAZARD','DISPATCH']}},{name:'referenceId',in:'path',required:true,schema:uuid}];
const op=(summary,extra={})=>({summary,tags:['Chat'],security:[{cookieAuth:[]}],parameters:scopeParams,responses:{200:{description:'Success'},400:{description:'Invalid request, image or cursor'},401:{description:'Cookie session required'},404:{description:'Room not found or not a member of this version'},409:{description:'Archived room or stale room ID'},429:{description:'Ten messages per minute per sender/room'},503:{description:'S3 or Dispatch module unavailable'}},...extra});
const imageFields={type:'object',properties:{images:{type:'array',maxItems:3,items:{type:'string',format:'binary'}}}};
const paths={
 '/api/v1/chat/{scope}/{referenceId}':{get:op('Current room messages; versions isolate reassigned providers',{
  parameters:[...scopeParams,{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:100,default:50}},{name:'before',in:'query',schema:uuid},{name:'version',in:'query',schema:{type:'integer',minimum:1,description:'Explicit archived version; requester must belong to it'}}],
  responses:{200:{description:'Newest messages first; nextCursor is a message UUID',content:{'application/json':{schema:envelope({type:'object',properties:{room:ref('ChatRoom'),items:{type:'array',items:ref('ChatMessage')},nextCursor:{...uuid,nullable:true}}})}}},401:{description:'Cookie required'},404:{description:'Version not found/not a member'},503:{description:'Dispatch not available yet'}},
 })},
 '/api/v1/chat/{scope}/{referenceId}/messages':{post:op('Send text/images with idempotent clientMessageId',{
  requestBody:{required:true,content:{'application/json':{schema:ref('ChatSendInput')},'multipart/form-data':{schema:{allOf:[ref('ChatSendInput'),imageFields]}}}},
  responses:{201:{description:'Committed message, or previous message with duplicate:true',content:{'application/json':{schema:envelope(ref('ChatMessage'))}}},400:{description:'Invalid content or attachment'},401:{description:'Cookie required'},404:{description:'Not a member'},409:{description:'Archived or stale room'},429:{description:'Rate limit'},503:{description:'Storage/dispatch unavailable'}},
 })},
 '/api/v1/chat/{scope}/{referenceId}/history':{get:op('Archived rooms visible only to their original participants',{parameters:[...scopeParams,{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:100,default:50}},{name:'offset',in:'query',schema:{type:'integer',minimum:0,maximum:100000,default:0}}]})},
 '/api/v1/uploads':{post:{...op('Upload 1–3 images to public picare-s3/roadassist; no Core API or ACL'),tags:['Uploads'],parameters:[],requestBody:{required:true,content:{'multipart/form-data':{schema:{...imageFields,required:['images']}}}},responses:{201:{description:'Uploaded public assets; use IDs for chat attachments',content:{'application/json':{schema:envelope({type:'object',properties:{items:{type:'array',items:ref('PublicUpload')}}})}}},400:{description:'Invalid/too many images'},401:{description:'Cookie required'},409:{description:'Daily quota exceeded'},413:{description:'File exceeds 5MB'},503:{description:'Storage unavailable'}}}},
};
module.exports={schemas,paths};
