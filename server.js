'use strict';
// Room-authoritative multiplayer for the small sushi bar.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const PORT = Number(process.env.PORT) || 3000;
const MAX_PER_ROOM = 8;
const rooms = new Map();
const connections = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const files = {'/':'index.html', '/index.html':'index.html', '/multiplayer.js':'multiplayer.js'};
  if (url.pathname === '/health') { res.writeHead(200, {'Content-Type':'text/plain'}); return res.end('ok'); }
  const name = files[url.pathname];
  if (!name) { res.writeHead(404); return res.end('Not found'); }
  const f = path.join(__dirname, name);
  res.writeHead(200, {'Content-Type':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8', 'Cache-Control':'no-cache'});
  const stream = fs.createReadStream(f);
  stream.on('error',()=>res.destroy());
  stream.pipe(res);
});
const wss = new WebSocket.Server({server, maxPayload:4096, perMessageDeflate:false});
const send = (ws, obj) => { if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
function each(room, obj) { for(const ws of room.members.keys()) send(ws, obj); }
function err(ws, message) { send(ws, {type:'error', message}); }
function roomCode() {
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from(crypto.randomBytes(6), v=>alphabet[v%alphabet.length]).join(''); } while (rooms.has(code));
  return code;
}
function newRoom() { const room={code:roomCode(), members:new Map(), chef:null, stock:0, served:0, revision:0}; rooms.set(room.code,room); return room; }
function members(room) { return [...room.members.values()]; }
function snapshot(room) {
  return {type:'state', room:room.code, chef:room.chef, stock:room.stock, served:room.served, revision:room.revision,
    users:members(room).map(u=>({id:u.id,name:u.name,color:u.color,eaten:u.eaten,seat:u.seat}))};
}
function sync(room) { room.revision++; each(room, snapshot(room)); }
function broadcastNotice(room, message) { each(room,{type:'notice',message}); }
function plateStock(room, chefName) {
  if(room.stock<1)return 0;
  const amount=room.stock;
  room.served += amount;
  room.stock=0;
  broadcastNotice(room, `${chefName} 셰프가 참치 ${amount}점을 접시에 내놓았어요.`);
  return amount;
}
function leaveRoom(ws) {
  const u=connections.get(ws);
  if(!u || !u.room)return;
  const room=u.room;
  if(room.chef===u.id){plateStock(room,u.name);room.chef=null;}
  room.members.delete(ws);u.room=null;u.seat=null;
  if(!room.members.size) rooms.delete(room.code); else sync(room);
}
function joinRoom(ws, m, create) {
  let u=connections.get(ws);
  if(u.room) return err(ws,'이미 방에 입장했어요. 다른 방은 새로 접속해 주세요.');
  let room;
  if(create){room=newRoom();}
  else{
    const code=String(m.code||'').trim().toUpperCase().replace(/\s/g,'');
    if(!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) return err(ws,'방 코드는 영문·숫자 6자리예요.');
    room=rooms.get(code);
    if(!room) return err(ws,'해당 코드의 방이 없어요. 방장에게 코드를 확인해 주세요.');
  }
  if(room.members.size>=MAX_PER_ROOM) return err(ws,'이 방은 8명 정원이에요.');
  const taken=new Set(members(room).map(p=>p.seat));
  for(let n=0;n<MAX_PER_ROOM;n++) if(!taken.has(n)){u.seat=n;break;}
  u.name=String(m.name||'손님').trim().slice(0,14)||'손님';
  u.color=/^#[0-9a-fA-F]{6}$/.test(m.color)?m.color:'#b68c67';
  u.room=room;
  room.members.set(ws,u);
  send(ws,{type:'welcome',id:u.id,room:room.code,created:create});
  sync(room);
}
wss.on('connection', ws=>{
  connections.set(ws,{id:crypto.randomUUID().slice(0,8),room:null,seat:null,name:'손님',color:'#b68c67',eaten:0,lastCut:0,lastChat:0});
  ws.on('message',raw=>{
    let m;try {m=JSON.parse(raw.toString());}catch{return;}
    if(!m || typeof m.type!=='string')return;
    const u=connections.get(ws);if(!u)return;
    if(m.type==='create'||m.type==='join')return joinRoom(ws,m,m.type==='create');
    const room=u.room;
    if(!room) return err(ws,'먼저 방에 입장해 주세요.');
    if(m.type==='profile') {
      u.name=String(m.name||'손님').trim().slice(0,14)||'손님';
      u.color=/^#[0-9a-fA-F]{6}$/.test(m.color)?m.color:u.color;
      return sync(room);
    }
    if(m.type==='chat'){
      const now=Date.now();if(now-u.lastChat<300)return;
      u.lastChat=now;
      const message=String(m.message||'').trim().slice(0,160);
      if(message)each(room,{type:'chat',id:u.id,name:u.name,message,time:now});
      return;
    }
    if(m.type==='claim'){
      if(!room.chef || room.chef===u.id){room.chef=u.id;sync(room);}
      else err(ws,'다른 셰프가 지금 작업 중이에요.');
      return;
    }
    if(m.type==='release'){
      if(room.chef===u.id){plateStock(room,u.name);room.chef=null;sync(room);}
      return;
    }
    if(m.type==='cut'){
      if(room.chef!==u.id) return err(ws,'셰프만 썰 수 있어요.');
      const now=Date.now();if(now-u.lastCut<180)return;
      u.lastCut=now;
      if(room.stock>=40)return err(ws,'이번 참치는 접시에 내놓거나 새 참치로 교체해 주세요.');
      room.stock++;sync(room);
      return;
    }
    if(m.type==='serve'){
      if(room.chef!==u.id) return err(ws,'셰프만 접시에 낼 수 있어요.');
      plateStock(room,u.name);
      send(ws,{type:'serve-ok'});
      sync(room);
      return;
    }
    if(m.type==='reset'){
      if(room.chef!==u.id) return err(ws,'새 참치는 셰프만 준비할 수 있어요.');
      // Resetting a physical tuna block never destroys plated food.
      plateStock(room,u.name);
      send(ws,{type:'reset-ok'});
      sync(room);
      return;
    }
    if(m.type==='eat'){
      if(room.served<=0) return err(ws,'접시에 남은 참치가 없어요.');
      room.served--;u.eaten++;
      sync(room);
      return;
    }
  });
  ws.on('close',()=>{leaveRoom(ws);connections.delete(ws)});
  ws.on('error',()=>{});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Sushi multiplayer: http://localhost:${PORT}`));
