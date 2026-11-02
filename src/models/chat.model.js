const { DataTypes: D } = require('sequelize');
const db = require('../config/postgres.config');
const id = () => ({ type:D.UUID,primaryKey:true,defaultValue:D.UUIDV4 });
const ChatRoom = db.define('ChatRoom', {
 id:id(), scope:{type:D.ENUM('DISPATCH','HAZARD'),allowNull:false}, referenceId:{type:D.UUID,allowNull:false,field:'reference_id'},
 version:{type:D.INTEGER,allowNull:false,defaultValue:1}, isArchived:{type:D.BOOLEAN,allowNull:false,defaultValue:false,field:'is_archived'},
 // Assignment snapshot; never derive archived membership from the current provider.
 providerId:{type:D.UUID,field:'provider_id'},
}, {tableName:'chat_rooms',indexes:[{unique:true,fields:['scope','reference_id','version']}]});
const ChatParticipant = db.define('ChatParticipant', {
 id:id(), roomId:{type:D.UUID,allowNull:false,field:'room_id'}, userId:{type:D.UUID,allowNull:false,field:'user_id'}, role:{type:D.STRING(20),allowNull:false},
}, {tableName:'chat_participants',indexes:[{unique:true,fields:['room_id','user_id']},{fields:['user_id']}]});
const ChatMessage = db.define('ChatMessage', {
 id:id(), roomId:{type:D.UUID,allowNull:false,field:'room_id'}, senderId:{type:D.UUID,field:'sender_id'},
 senderRole:{type:D.STRING(20),allowNull:false,field:'sender_role'}, content:{type:D.STRING(1000)}, images:{type:D.ARRAY(D.STRING(2048)),defaultValue:[],allowNull:false},
 systemEvent:{type:D.STRING(50),field:'system_event'}, clientMessageId:{type:D.UUID,field:'client_message_id'},
}, {tableName:'chat_messages',indexes:[{fields:['room_id','createdAt','id']},{unique:true,fields:['room_id','sender_id','client_message_id']}]});
module.exports={ChatRoom,ChatMessage,ChatParticipant};
