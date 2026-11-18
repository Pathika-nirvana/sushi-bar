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
// User-chosen room names can contain Korean, numbers, spaces, punctuation, etc.
// Only trim surrounding whitespace and normalize Unicode; never force a fixed 6-character format.
function normalizeRoomCode(input) {
  if(typeof input !== 'string')return '';
  return input.trim().normalize('NFC').toUpperCase();
}
function newRoom(code=roomCode()) { const room={code, members:new Map(), chef:null, stock:0, ready:0, served:0, revision:0, cuts:[], progress:0, cutting:null, generation:0, nextCut:0, nextSeat:0}; rooms.set(room.code,room); return room; }
function members(room) { return [...room.members.values()]; }
function snapshot(room) {
  return {type:'state', room:room.code, chef:room.chef, stock:room.stock, served:room.ready, revision:room.revision,
    generation:room.generation, cuts:room.cuts, cutting:room.cutting,
    users:members(room).map(u=>({id:u.id,name:u.name,color:u.color,eaten:u.eaten,plate:u.plate,seat:u.seat}))};
}
function sync(room) { room.revision++; each(room, snapshot(room)); }
function broadcastNotice(room, message) { each(room,{type:'notice',message}); }
function plateStock(room, chefName) {
  if(room.stock<1)return 0;
  const amount=room.stock, guests=members(room).sort((a,b)=>a.seat-b.seat);
  // Each diner has their own plate. Never make everyone interact with one shared platter.
  for(let i=0;i<amount;i++){
    if(guests.length)guests[(room.nextSeat+i)%guests.length].plate++;
    else room.ready++;
  }
  if(guests.length)room.nextSeat=(room.nextSeat+amount)%guests.length;
  room.stock=0;
  broadcastNotice(room, `${chefName} 셰프가 참치 ${amount}점을 손님들의 개별 접시에 내놓았어요.`);
  return amount;
}
function finishCut(room, id) {
  const c=room.cutting;
  if(!c || c.id!==id)return;
  room.cuts.push(c.xb-c.xa);
  room.progress=c.xb;
  room.stock++;
  room.cutting=null;
  sync(room);
}
function resetTuna(room){
  room.generation++;
  room.progress=0;
  room.cuts=[];
  room.cutting=null;
  each(room,{type:'cut-reset',generation:room.generation});
}

function leaveRoom(ws) {
  const u=connections.get(ws);
  if(!u || !u.room)return;
  const room=u.room;
  if(room.cutting && room.chef===u.id)finishCut(room,room.cutting.id);
  if(room.chef===u.id){plateStock(room,u.name);room.chef=null;}
  // Recover food from a disconnected diner's plate for later guests.
  room.ready+=u.plate;u.plate=0;
  room.members.delete(ws);u.room=null;u.seat=null;
  if(!room.members.size) rooms.delete(room.code); else sync(room);
}
function joinRoom(ws, m, create) {
  let u=connections.get(ws);
  if(u.room) return err(ws,'이미 방에 입장했어요. 다른 방은 새로 접속해 주세요.');
  let room, created=false;
  if(create){
    room=newRoom();created=true;
  }else{
    const code=normalizeRoomCode(m.code);
    // No fixed format: even a single digit or Korean word is a valid room name.
    if(!code || Array.from(code).length>64 || /[\u0000-\u001f\u007f]/.test(code))
      return err(ws,'방 코드를 입력해 주세요. (최대 64글자)');
    room=rooms.get(code);
    if(!room){room=newRoom(code);created=true;}
  }
  if(room.members.size>=MAX_PER_ROOM) return err(ws,'이 방은 8명 정원이에요.');
  const taken=new Set(members(room).map(p=>p.seat));
  for(let n=0;n<MAX_PER_ROOM;n++) if(!taken.has(n)){u.seat=n;break;}
  u.name=String(m.name||'손님').trim().slice(0,14)||'손님';
  u.color=/^#[0-9a-fA-F]{6}$/.test(m.color)?m.color:'#b68c67';
  u.room=room;
  if(room.ready){u.plate+=Math.min(6,room.ready);room.ready-=Math.min(6,room.ready);}
  room.members.set(ws,u);
  send(ws,{type:'welcome',id:u.id,room:room.code,created});
  sync(room);
}
wss.on('connection', ws=>{
  connections.set(ws,{id:crypto.randomUUID().slice(0,8),room:null,seat:null,name:'손님',color:'#b68c67',plate:0,eaten:0,lastCut:0,lastChat:0});
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
      if(room.chef===u.id){if(room.cutting)return err(ws,'칼질이 끝난 뒤 역할을 넘겨 줘.');plateStock(room,u.name);room.chef=null;sync(room);}
      return;
    }
    if(m.type==='slice'){
      if(room.chef!==u.id)return err(ws,'셰프만 참치를 썰 수 있어요.');
      if(room.cutting)return err(ws,'칼질이 끝난 다음 썰어 주세요.');
      if(room.stock>=40)return err(ws,'참치를 접시에 내놓거나 새 참치로 준비해 주세요.');
      const remaining=3.2-room.progress;
      if(remaining<.03)return err(ws,'참치를 다 썰었어요. 새 참치 준비를 눌러 줘.');
      const thickness=Math.min(remaining,Math.max(.12,Math.min(.45,Number(m.thickness)||.22)));
      const speed=Math.max(.5,Math.min(2,Number(m.speed)||1));
      const now=Date.now(),id=++room.nextCut;
      const cut={id,xa:room.progress,xb:room.progress+thickness,speed,started:now};
      room.cutting=cut;
      // Broadcast the ACTUAL knife animation, not just the finished slice count.
      each(room,{type:'cut-animation',cut});
      sync(room);
      setTimeout(()=>{if(rooms.get(room.code)===room)finishCut(room,id)},Math.ceil(2150/speed));
      return;
    }
    // Older clients must not be able to fabricate prepared sashimi.
    if(m.type==='cut')return err(ws,'클라이언트를 최신 버전으로 업데이트해 주세요.');
    if(m.type==='serve'){
      if(room.chef!==u.id) return err(ws,'셰프만 접시에 낼 수 있어요.');
      if(room.cutting)return err(ws,'칼질이 끝난 뒤 접시에 내놓아 줘.');
      plateStock(room,u.name);
      send(ws,{type:'serve-ok'});
      sync(room);
      return;
    }
    if(m.type==='reset'){
      if(room.chef!==u.id) return err(ws,'새 참치는 셰프만 준비할 수 있어요.');
      if(room.cutting)return err(ws,'칼질이 끝난 다음 새 참치를 준비할 수 있어요.');
      // Physical tuna resets independently from each diner's private plate.
      plateStock(room,u.name);
      resetTuna(room);
      send(ws,{type:'reset-ok'});
      sync(room);
      return;
    }
    if(m.type==='take'){
      if(room.ready<1)return err(ws,'남아 있는 예비 참치가 없어요.');
      const n=Math.min(6,room.ready);room.ready-=n;u.plate+=n;sync(room);return;
    }
    if(m.type==='eat'){
      if(u.plate<=0) return err(ws,'내 접시에 남은 참치가 없어요.');
      u.plate--;u.eaten++;
      sync(room);
      return;
    }
  });
  ws.on('close',()=>{leaveRoom(ws);connections.delete(ws)});
  ws.on('error',()=>{});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Sushi multiplayer: http://localhost:${PORT}`));
