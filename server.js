const http=require('http'),fs=require('fs'),path=require('path');
const WebSocket=require('ws');
const PORT=process.env.PORT||3000,MAX=8;
const clients=new Map();let chef=null,stock=0,served=0,revision=0;
const server=http.createServer((req,res)=>{let f=req.url==='/'?'/index.html':req.url.split('?')[0];if(f!=='/index.html'){res.writeHead(404);return res.end('Not found')}fs.createReadStream(path.join(__dirname,'index.html')).on('error',()=>{res.writeHead(500);res.end()}).pipe(res)});
const wss=new WebSocket.Server({server,maxPayload:2048});
const send=(ws,o)=>{if(ws.readyState===1)ws.send(JSON.stringify(o))};
const broadcast=o=>{for(const ws of clients.keys())send(ws,o)};
const snapshot=()=>({type:'state',chef,stock,served,revision,users:[...clients.values()].map(u=>({id:u.id,name:u.name,color:u.color,eaten:u.eaten}))});
const sync=()=>{revision++;broadcast(snapshot())};
const id=()=>Math.random().toString(36).slice(2,10);
wss.on('connection',ws=>{
 if(clients.size>=MAX){send(ws,{type:'error',message:'정원 8명이 가득 찼습니다.'});return ws.close(1008,'Full')}
 const u={id:id(),name:'손님',color:'#b68c67',eaten:0,lastCut:0};clients.set(ws,u);send(ws,{type:'welcome',id:u.id});sync();
 ws.on('message',raw=>{let m;try{m=JSON.parse(raw)}catch{return}if(!m||typeof m.type!=='string')return;
 if(m.type==='profile'){u.name=String(m.name||'손님').trim().slice(0,14)||'손님';u.color=/^#[0-9a-fA-F]{6}$/.test(m.color)?m.color:u.color;return sync()}
 if(m.type==='chat'){const msg=String(m.message||'').trim().slice(0,160);if(msg)broadcast({type:'chat',id:u.id,name:u.name,message:msg,time:Date.now()});return}
 if(m.type==='claim'){if(!chef||chef===u.id){chef=u.id;sync()}else send(ws,{type:'error',message:'현재 다른 셰프가 작업 중입니다.'});return}
 if(m.type==='release'){if(chef===u.id){chef=null;sync()}return}
 if(m.type==='cut'){if(chef!==u.id)return;const now=Date.now();if(now-u.lastCut<350)return;u.lastCut=now;if(stock>=24)return;stock++;sync();return}
 if(m.type==='serve'){if(chef!==u.id||stock===0)return;served=Math.min(24,served+stock);stock=0;broadcast({type:'notice',message:`${u.name} 셰프가 참치 ${served}점이 놓인 접시를 내놓았습니다.`});sync();return}
 if(m.type==='eat'){if(served<=0){send(ws,{type:'error',message:'접시에 남은 참치가 없습니다.'});return}served--;u.eaten++;broadcast({type:'notice',message:`${u.name}님이 참치 한 점을 맛보았습니다.`});sync();return}
 });
 ws.on('close',()=>{clients.delete(ws);if(chef===u.id)chef=null;sync()});
});
server.listen(PORT,()=>console.log(`Sushi multiplayer: http://localhost:${PORT}`));
