'use strict';
// UI and room membership. The 3D cooking/dining functions are exposed via MP hooks in index.html.
(() => {
  const $ = id => document.getElementById(id);
  const name=$('mpName'), color=$('mpColor'), codeInput=$('mpRoom');
  let ws=null, self=null, users=[], chef=null, connected=false, joined=false, roomCode='', pending=null, editing=false, toastTimer;
  try {name.value=localStorage.getItem('sushi-name')||'손님';color.value=localStorage.getItem('sushi-color')||'#b68c67';}catch{}
  MP.toast=msg=>{
    const el=$('mpToast');el.textContent=msg;el.style.display='block';
    clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.style.display='none',3000);
  };
  MP.send=obj=>{if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));};
  const log=(who,msg)=>{
    const parent=$('mpMessages');const line=document.createElement('div');
    const title=document.createElement('b');title.textContent=who+'  ';
    line.append(title,document.createTextNode(msg));parent.append(line);
    while(parent.childElementCount>55)parent.firstChild.remove();parent.scrollTop=parent.scrollHeight;
  };
  const store=()=>{name.value=name.value.trim().slice(0,14)||'손님';try{localStorage.setItem('sushi-name',name.value);localStorage.setItem('sushi-color',color.value)}catch{}};
  const roomLabel=()=>{
    $('mpRoomCode').textContent=roomCode ? `방 ${roomCode}` : '방 미입장';
    $('mpCopy').disabled=!joined;
  };
  const render=()=>{
    const wasChef=MP.isChef;
    MP.isChef=joined && self!==null && chef===self;
    MP.chef=chef;
    MP.users=users;
    $('mpCount').textContent=users.length+'/8';
    $('mpDot').classList.toggle('ok',joined&&connected);
    $('mpStatus').textContent=joined?'접속됨':connected?'방 선택':'연결 대기';
    $('mpRoleText').textContent=MP.isChef?`셰프 · 준비 중 ${MP.stock}점 · 접시 ${MP.served}점`:`${chef?(users.find(u=>u.id===chef)?.name||'셰프')+' 조리 중':'셰프 자리 비어 있음'} · 접시 ${MP.served}점`;
    $('mpClaim').style.display=joined&&!chef?'':'none';
    $('mpClaim').disabled=!joined;
    $('mpRelease').style.display=MP.isChef?'':'none';
    $('mpServe').style.display=MP.isChef?'':'none';
    $('mpServe').disabled=MP.stock===0;
    $('cut').disabled=!MP.isChef;
    $('auto').disabled=!MP.isChef;
    $('rst').disabled=!MP.isChef;
    $('th').disabled=!MP.isChef;
    $('sp').disabled=!MP.isChef;
    if(!MP.isChef&&$('auto').classList.contains('on')){
      // The 3D loop also checks MP.isChef, so the switch is merely cosmetic.
      $('auto').classList.remove('on');
    }
    const list=$('mpPeople');list.replaceChildren();
    users.forEach(u=>{
      const row=document.createElement('div');row.className='mpUser';
      const avatar=document.createElement('span');avatar.className='mpFace';avatar.style.background=u.color;
      avatar.textContent=u.name.slice(0,1);
      const label=document.createElement('span');label.textContent=u.name+(u.id===self?' (나)':'');
      row.append(avatar,label);
      if(u.id===chef){const badge=document.createElement('span');badge.className='mpChef';badge.textContent='셰프';row.append(badge);}
      list.append(row);
    });
    if(typeof MP.updateAvatars==='function')MP.updateAvatars(users,chef,self);
    if(wasChef!==MP.isChef && typeof MP.onChefChanged==='function') MP.onChefChanged(MP.isChef);
    roomLabel();
  };
  function onMessage(e){
    let m;try{m=JSON.parse(e.data);}catch{return;}
    if(m.type==='welcome'){
      joined=true;self=m.id;roomCode=m.room;pending=null;
      $('mpSetup').style.display='none';
      $('mpProfile').disabled=false;
      log('시스템',m.created?`새 방 ${roomCode}가 열렸어요. 코드를 공유해 보세요.`:`방 ${roomCode}에 입장했어요.`);
      render();
      return;
    }
    if(m.type==='state'){
      if(m.room!==roomCode)return;
      chef=m.chef;users=m.users;MP.stock=m.stock;MP.served=m.served;MP.room=m.room;
      render();
      if(typeof MP.reconcile==='function')MP.reconcile();
      if(MP.wantDining && MP.served>0 && typeof MP.enterDining==='function'){
        MP.wantDining=false;MP.enterDining();
      }
      return;
    }
    if(m.type==='serve-ok'){
      if(MP.wantDining && typeof MP.enterDining==='function' && MP.served>0){MP.wantDining=false;MP.enterDining();}
      return;
    }
    if(m.type==='reset-ok'){
      if(typeof MP.onResetOk==='function')MP.onResetOk();
      MP.toast('새 참치를 준비했어. 접시에 낸 회는 그대로야.');
      return;
    }
    if(m.type==='chat'){log(m.name,m.message);return;}
    if(m.type==='notice'){log('스시집',m.message);return;}
    if(m.type==='error'){
      MP.wantDining=false;
      MP.toast(m.message);
      if(!joined){$('mpSetup').style.display='grid';$('mpLobbyError').textContent=m.message;}
      return;
    }
  }
  const sendEntry=()=>{
    if(!pending)return;
    MP.send({type:pending.mode,code:pending.code,name:name.value,color:color.value});
  };
  function connectAndEnter(mode, code){
    if(editing){store();MP.send({type:'profile',name:name.value,color:color.value});$('mpSetup').style.display='none';editing=false;return;}
    store();$('mpLobbyError').textContent='';
    pending={mode,code};
    if(ws && ws.readyState===WebSocket.OPEN)return sendEntry();
    if(ws && ws.readyState===WebSocket.CONNECTING)return;
    const scheme=location.protocol==='https:'?'wss':'ws';
    ws=new WebSocket(scheme+'://'+location.host);
    ws.onopen=()=>{connected=true;render();sendEntry();};
    ws.onmessage=onMessage;
    ws.onerror=()=>MP.toast('서버 연결을 확인해 주세요.');
    ws.onclose=()=>{
      connected=false;joined=false;self=null;chef=null;roomCode='';users=[];MP.isChef=false;MP.users=[];MP.stock=0;MP.served=0;MP.wantDining=false;
      render();$('mpSetup').style.display='grid';$('mpLobbyError').textContent='연결이 끊어졌어요. 방 코드를 입력해 다시 입장해 주세요.';
      log('시스템','서버 연결이 종료되었어요.');
    };
  }
  $('mpCreate').onclick=()=>connectAndEnter('create','');
  $('mpJoin').onclick=()=>{
    const code=codeInput.value.trim().toUpperCase().replace(/\s/g,'');
    if(!/^[A-HJ-NP-Z2-9]{6}$/.test(code)){
      $('mpLobbyError').textContent='방 코드는 영문·숫자 6자리야.';return;
    }
    connectAndEnter('join',code);
  };
  codeInput.addEventListener('keydown',e=>{if(e.key==='Enter')$('mpJoin').click();});
  $('mpProfile').onclick=()=>{
    editing=true;$('mpSetup').style.display='grid';
    $('mpLobbyControls').style.display='none';$('mpSaveProfile').style.display='block';
    $('mpLobbyError').textContent='';
  };
  $('mpSaveProfile').onclick=()=>{
    store();MP.send({type:'profile',name:name.value,color:color.value});
    $('mpSetup').style.display='none';$('mpLobbyControls').style.display='block';$('mpSaveProfile').style.display='none';editing=false;
  };
  $('mpCopy').onclick=async()=>{
    if(!roomCode)return;
    try{await navigator.clipboard.writeText(roomCode);MP.toast(`방 코드 ${roomCode} 복사 완료`);}
    catch{window.prompt('친구에게 이 방 코드를 알려 줘',roomCode);}
  };
  $('mpClaim').onclick=()=>MP.send({type:'claim'});
  $('mpRelease').onclick=()=>MP.send({type:'release'});
  $('mpServe').onclick=()=>MP.send({type:'serve'});
  $('mpSend').onsubmit=e=>{
    e.preventDefault();const input=$('mpInput'),message=input.value.trim();
    if(message)MP.send({type:'chat',message});input.value='';
  };
  roomLabel();render();
})();
