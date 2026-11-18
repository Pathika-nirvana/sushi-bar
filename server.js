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
  const files = {'/':'index.html', '/index.html':'index.html', '/multiplayer.js':'multiplayer.js', '/offline.html':'offline.html', '/vendor/three.min.js':'vendor/three.min.js', '/vendor/OrbitControls.js':'vendor/OrbitControls.js'};
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
function newRoom(code=roomCode()) { const room={code, members:new Map(), chef:null, stock:0, ready:0, served:0, revision:0, cuts:[], progress:0, cutting:null, generation:0, nextCut:0, nextSeat:0, totalCuts:0, eatenTotal:0, stolenTotal:0, stockCuts:[], readyCuts:[], cheer:0, boo:0}; rooms.set(room.code,room); return room; }
function members(room) { return [...room.members.values()]; }
function snapshot(room) {
  return {type:'state', room:room.code, chef:room.chef, stock:room.stock, served:room.ready, revision:room.revision,
    generation:room.generation, cuts:room.cuts, cutting:room.cutting, totalCuts:room.totalCuts, eatenTotal:room.eatenTotal, stolenTotal:room.stolenTotal, cheer:room.cheer, boo:room.boo, stockCuts:room.stockCuts,
    users:members(room).map(u=>({id:u.id,name:u.name,color:u.color,eaten:u.eaten,stolen:u.stolen,plate:u.plate,plateCuts:u.plateCuts,seat:u.seat}))};
}
function sync(room) { room.revision++; each(room, snapshot(room)); }
function broadcastNotice(room, message) { each(room,{type:'notice',message}); }
function plateStock(room, chefName) {
  if(room.stock<1)return 0;
  const amount=room.stock;
  const all=members(room).sort((a,b)=>a.seat-b.seat);
  // With guests present, the chef serves only guests. Alone, the chef can dine as before.
  const diners=all.filter(u=>u.id!==room.chef);
  const guests=diners.length?diners:all;
  // Each diner has their own plate; a cut is assigned to exactly one plate.
  for(let i=0;i<amount;i++){
    const thickness=room.stockCuts.shift() ?? .22;
    if(guests.length){const guest=guests[(room.nextSeat+i)%guests.length]; guest.plateCuts.push(thickness);guest.plate++;}
    else{room.readyCuts.push(thickness);room.ready++;}
  }
  if(guests.length)room.nextSeat=(room.nextSeat+amount)%guests.length;
  room.stock=0;
  broadcastNotice(room, `${chefName} 셰프가 참치 ${amount}점을 손님들의 개별 접시에 내놓았어요.`);
  return amount;
}
function finishCut(room, id) {
  const c=room.cutting;
  if(!c || c.id!==id)return;
  room.cuts.push(c.xb-c.xa);room.stockCuts.push(c.xb-c.xa);
  room.progress=c.xb;
  room.stock++;
  room.totalCuts++;
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
  room.readyCuts.push(...u.plateCuts);room.ready+=u.plate;u.plateCuts=[];u.plate=0;
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
  if(room.ready){const n=Math.min(6,room.ready);u.plate+=n;u.plateCuts.push(...room.readyCuts.splice(0,n));room.ready-=n;}
  room.members.set(ws,u);
  send(ws,{type:'welcome',id:u.id,room:room.code,created});
  sync(room);
}
// Flavor-first tasting reactions. Kept server-side so every player hears the same line.
const TASTE_LINES = {
  praise: [
  "첫맛은 담백한데, 씹을수록 고소함이 밀려와…!",
  "지방이 혀의 온도에 녹으면서 맛이 한 겹 더 펼쳐져!",
  "간장은 그저 거들 뿐. 참치 본연의 단맛이 주인공이야!",
  "씹는 순간 살결이 사르르 풀려… 이 식감은 반칙이지!",
  "와… 처음엔 조용한데 뒷맛이 이렇게 길게 남는다고?",
  "비린내는 없고 은은한 바다 향만 남아. 훌륭해!",
  "고소함이 먼저 오고 감칠맛이 뒤를 받치는군. 완벽한 순서야!",
  "이 한 점에 왜 다들 좋은 참치를 찾는지 알겠어.",
  "눈을 감으니까 참치의 단맛이 훨씬 선명해져…!",
  "살결이 살아 있어! 칼끝이 맛을 망치지 않았구나!",
  "혀끝에서 느껴지는 부드러움… 뒤이어 감칠맛이 터져!",
  "기름진데 느끼하지 않아. 이 균형을 어떻게 잡은 거야?",
  "한 점 먹었을 뿐인데 입안에 여운이 계속 남잖아.",
  "이야… 향은 은은하고 식감은 섬세해. 조화가 대단해!",
  "간장을 아주 조금만 찍었는데 단맛이 확 살아났어!",
  "이건 씹는 맛도 있지만 녹아드는 순간이 진짜야.",
  "입안에 남는 맛이 깨끗해. 한 점 더 먹고 싶어지네!",
  "살짝 차가운 첫 느낌 다음에 고소함이 확 피어나!",
  "와사비가 코끝을 스치더니 참치의 감칠맛만 남겨 두고 사라졌어!",
  "살의 결이 부드럽게 갈라져. 참치 상태가 정말 좋군!",
  "이 깊은 맛… 숙성의 묘미가 입안에서 느껴진다.",
  "한 점의 시작과 끝이 이렇게 다를 수 있다니!",
  "참치의 단맛이 이렇게 진하게 느껴질 줄은 몰랐어.",
  "비린 향 하나 없이 고소한 여운만 남네. 감탄했어!",
  "묵직한 감칠맛 뒤에 산뜻한 마무리까지… 정말 좋다.",
  "삼킨 뒤에도 혀끝에 향이 남아 있어. 놀라운 여운이야!",
  "씹을수록 단맛이 배어나오는군. 좋은 살결이야.",
  "간장을 아예 안 찍어도 충분히 맛있겠는데?",
  "참치 맛이 입안에서 층층이 펼쳐지네. 요리의 한 장면 같아!",
  "부드럽다가 살짝 탄력이 돌아와. 이 대비가 좋다!",
  "첫 점에서 입맛이 확 살아났어. 다음 점이 기다려진다!",
  "입에 닿는 순간 고소한 향이 퍼져. 이건 기억에 남겠어!",
  "담백함과 진한 맛이 싸우지 않고 손을 잡았네.",
  "이런 질감이면 굳이 오래 씹을 필요도 없지…",
  "한 점 먹고 말이 없어졌어. 맛이 말을 대신하네.",
  "지방의 고소함이 지나간 자리에 감칠맛이 남는군.",
  "입안에서 조용히 녹아내리다 마지막에 향이 올라와!",
  "살점의 탄력도 좋고 끝맛도 맑아. 밸런스가 예술이야.",
  "참치가 이렇게 우아한 맛을 낼 수 있다니…",
  "혀를 스치고 지나가는 짧은 순간이 아쉬울 정도야!",
  "풍미가 풍부한데 결코 무겁지 않아. 정교한 한 점이군!",
  "오늘 이 한 점 때문에 단골이 될지도 모르겠어.",
  "먹을수록 감칠맛이 쌓여. 젓가락을 멈출 수가 없어!",
  "첫맛은 바다, 끝맛은 고소함… 이야기가 있는 한 점이야!",
  "입안에서 향이 길게 이어져. 좋은 참치의 품격이 느껴져!",
  "이 섬세한 단맛을 살린 게 정말 대단하다.",
  "씹다가 저절로 미소가 나왔어. 이게 바로 행복이지!",
  "한 점인데 이렇게 풍성하다니… 셰프, 정말 훌륭해!",
  "감칠맛이 입안을 가득 채운다. 절묘한 한 점이야!",
  "오늘 최고의 순간은 바로 이 한 점을 먹은 때야."
],
  critique: [
  "첫맛은 나쁘지 않은데… 뒷맛이 너무 밋밋하잖아.",
  "감칠맛이 올라오려다 말았어. 어딘가 허전해!",
  "혀에 닿는 순간 기대했던 고소함이 안 느껴져.",
  "비린 향이 고소함보다 먼저 치고 올라오는데?",
  "어째 씹을수록 기름진 맛만 남지? 균형이 아쉬워.",
  "살결이 입안에서 뭉개져. 식감이 너무 물러!",
  "너무 차가워서인지 참치 고유의 단맛이 살아나질 않아.",
  "간장 맛만 남고 참치의 존재감은 사라졌어…",
  "두께는 좋은데 한 점 삼키기가 살짝 버겁군.",
  "입에서 녹는 게 아니라 질겅질겅 씹히잖아!",
  "지방의 고소함보다 느끼함이 앞서버렸어.",
  "뒷맛이 깔끔하지 않아… 입안에 무거운 맛이 남네.",
  "와사비 향에 참치 맛이 완전히 묻혀버렸어.",
  "향은 괜찮은데 입안에서 이어지는 맛이 없잖아.",
  "솔직히 한 점 더 먹고 싶다는 생각은 안 드는데?",
  "숙성된 깊이보다는 물러진 식감이 먼저 느껴져.",
  "살결이 왜 이렇게 거칠어? 씹을 때마다 걸리잖아.",
  "참치 고유의 단맛이 너무 희미해. 아쉬운 한 점이야.",
  "첫입부터 끝까지 맛이 단조로워. 반전이 없네.",
  "입안에서 향이 확 퍼져야 하는데… 너무 조용해.",
  "고소함이 짧게 지나가고 비린 뒷향만 남아.",
  "씹을수록 촉촉함이 아니라 퍽퍽함이 느껴지는군.",
  "보기에는 훌륭한데 맛이 기대를 따라오지 못했어.",
  "왜 이렇게 물맛이 나지? 감칠맛이 부족해.",
  "혀에서 느껴지는 탄력이 너무 거칠어. 좀 더 부드러웠으면!",
  "지방의 맛이 과해서 참치의 담백함이 가려졌어.",
  "끝맛에 거슬리는 향이 남아. 한 점이 좀 아쉽네.",
  "입안에서 살결이 풀리는 느낌이 부족해!",
  "향은 진하지만 맛의 깊이는 생각보다 얕아.",
  "한 점 먹었는데 여운이 없네. 금세 잊혀지는 맛이야.",
  "식감이 묵직하기만 해. 혀 위에서 살아 움직이지 않아!",
  "단맛이 나와야 할 순간에 짠맛만 튀어나오는데?",
  "감칠맛과 기름기가 따로 노는 느낌이야.",
  "이건 혀가 기다린 맛이 아니야… 뭔가 한 끗 부족해.",
  "참치의 향이 아니라 양념 향만 기억에 남겠어.",
  "입에서 사라지는 순간이 너무 거칠어. 마무리가 아쉽군.",
  "고소함을 기대했는데 텁텁함이 남아 버렸어.",
  "이 살결이라면 좀 더 섬세하게 썰었어야 했어."
],
  thinPraise: [
  "이 얇기가 딱 좋아! 혀에 닿자마자 부드럽게 사라져!",
  "얇게 써니까 단맛이 훨씬 섬세하게 느껴져…!",
  "이렇게 얇은데도 참치 향이 또렷해. 대단하군!",
  "얇은 살결 사이로 간장이 가볍게 스미는군. 조화가 좋아!",
  "두께를 줄이니까 입안에서 녹는 순간이 더 선명해져!",
  "가볍게 썬 한 점에 풍미가 이렇게 농축되어 있다니!",
  "한 점이 입안에서 깃털처럼 풀려. 칼질이 훌륭해!",
  "섬세한 얇기가 참치의 부드러움을 한층 살려 주네."
],
  thinCritique: [
  "너무 얇아서 씹는 맛도 느끼기 전에 사라졌잖아!",
  "이건 거의 종잇장 같은데? 참치의 탄력을 느낄 틈이 없어.",
  "얇긴 한데 풍미가 따라오지 못해. 너무 허무한 한 점이야.",
  "식감이 너무 가벼워서 참치의 존재감이 희미해졌어.",
  "입에 넣자마자 끝나 버렸어. 좀 더 두툼했으면 좋겠군.",
  "얇게 썬 맛은 있는데 고소함이 입안에 머물지 못하네."
],
  thickPraise: [
  "와, 이 두툼한 한 점! 씹을수록 참치의 단맛이 터져 나와!",
  "두껍게 썰었는데 이렇게 부드럽다고? 정말 좋은 살결이야!",
  "씹을 때마다 고소함이 한 겹씩 풀리는군. 두께가 절묘해!",
  "이 묵직한 식감이야말로 참치의 매력이지!",
  "두툼한 회에서 느껴지는 탄력이 기분 좋게 살아 있어!",
  "한 점의 두께가 주는 만족감… 이거지!",
  "씹는 즐거움이 확실해. 두께를 살린 선택이 탁월하군!",
  "입안을 꽉 채우는 감칠맛! 두툼한 참치의 매력이야!"
],
  thickCritique: [
  "너무 두꺼워서 입안이 꽉 막히는 느낌이야!",
  "씹는 맛은 좋은데, 이 두께는 좀 과하지 않아?",
  "이렇게 두껍게 썰면 고소함보다 질긴 느낌이 먼저 와.",
  "두께 때문에 간장과 참치가 따로 노는 것 같아.",
  "살결이 나쁘진 않은데 너무 두꺼워서 삼키기가 버겁군.",
  "이 두께로는 부드러움보다 뻣뻣함이 두드러지네."
],
};

wss.on('connection', ws=>{
  connections.set(ws,{id:crypto.randomUUID().slice(0,8),room:null,seat:null,name:'손님',color:'#b68c67',plate:0,plateCuts:[],eaten:0,stolen:0,lastSteal:0,lastCut:0,lastChat:0,lastReact:0,lastTasteThickness:null,lastTasteLine:''});
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
      const n=Math.min(6,room.ready);room.ready-=n;u.plate+=n;u.plateCuts.push(...room.readyCuts.splice(0,n));sync(room);return;
    }
    if(m.type==='steal'){
      if(room.chef!==u.id)return err(ws,'셰프만 손님 회를 몰래 집어먹을 수 있어요.');
      const now=Date.now();
      if(now-u.lastSteal<1100)return err(ws,'너무 자주 집어먹으면 들켜요!');
      const target=members(room).find(x=>x.id===m.target && x.id!==u.id);
      if(!target)return err(ws,'같은 방에 있는 다른 손님을 선택해 주세요.');
      if(target.plate<1)return err(ws,`${target.name}의 접시가 비었어요.`);
      u.lastSteal=now;
      target.plate--;target.plateCuts.pop();
      u.stolen++;room.stolenTotal++;
      // No system announcement: observers may notice the animation or missing piece.
      each(room,{type:'steal-animation',chefId:u.id,targetId:target.id,seat:target.seat});
      send(ws,{type:'steal-ok',target:target.name,total:u.stolen});
      sync(room);
      return;
    }
    if(m.type==='react'){
      if(!room.chef)return err(ws,'아직 셰프가 없어요.');
      if(room.chef===u.id)return err(ws,'맛 평가는 손님이 해 주도록 두자 ㅋㅋ');
      const now=Date.now();
      if(now-u.lastReact<2300)return err(ws,'잠깐만, 셰프가 반응할 틈을 줘!');
      if(m.kind!=='praise'&&m.kind!=='boo')return;
      u.lastReact=now;
      const good=m.kind==='praise';
      const lines=[...(good?TASTE_LINES.praise:TASTE_LINES.critique)];
      // Extra comments for the thickness of the last slice this guest ACTUALLY ate.
      // Without a tasted slice, only general flavor/texture remarks are selected.
      if(Number.isFinite(u.lastTasteThickness)){
        if(u.lastTasteThickness<=0.19)lines.push(...(good?TASTE_LINES.thinPraise:TASTE_LINES.thinCritique));
        else if(u.lastTasteThickness>=0.31)lines.push(...(good?TASTE_LINES.thickPraise:TASTE_LINES.thickCritique));
      }
      // Avoid immediately repeating the same tasting line on consecutive reactions.
      const options=lines.filter(line=>line!==u.lastTasteLine);
      const message=options[Math.floor(Math.random()*options.length)];
      u.lastTasteLine=message;
      if(good)room.cheer++;else room.boo++;
      each(room,{type:'reaction',id:u.id,name:u.name,chefId:room.chef,kind:m.kind,message,cheer:room.cheer,boo:room.boo});
      sync(room);
      return;
    }
    if(m.type==='eat'){
      if(u.plate<=0) return err(ws,'내 접시에 남은 참치가 없어요.');
      const index=Number.isInteger(m.index) ? Math.min(u.plateCuts.length-1,Math.max(0,m.index)) : 0;
      const [tastedThickness]=u.plateCuts.splice(index,1);u.lastTasteThickness=Number(tastedThickness);u.plate--;u.eaten++;room.eatenTotal++;
      sync(room);
      return;
    }
  });
  ws.on('close',()=>{leaveRoom(ws);connections.delete(ws)});
  ws.on('error',()=>{});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Sushi multiplayer: http://localhost:${PORT}`));
