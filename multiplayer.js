'use strict';
// UI and room membership. The 3D cooking/dining functions are exposed via MP hooks in index.html.
(() => {
  const $ = id => document.getElementById(id);
  const name=$('mpName'), color=$('mpColor'), codeInput=$('mpRoom');
  let ws=null, self=null, users=[], chef=null, connected=false, joined=false, roomCode='', pending=null, editing=false, toastTimer;
  let unread=0;
  let isLocal=false, localRoom=null, localCutTimer=null;
  let stealCursor=0;
  const isMobile=()=>matchMedia('(max-width:740px)').matches;
  const chatOpen=()=>document.body.classList.contains('mpChatOpen');
  const showChat=(open, focusInput=false)=>{
    document.body.classList.toggle('mpChatOpen',open);
    $('mpChatToggle').setAttribute('aria-expanded',String(open));
    if(open){unread=0;$('mpChatBadge').textContent='';$('mpChatToggle').classList.remove('hasUnread');
      $('mpMessages').scrollTop=$('mpMessages').scrollHeight;
      document.body.classList.remove('mpPeopleOpen');$('mpPeopleToggle').setAttribute('aria-expanded','false');
      if(focusInput)$('mpInput').focus();
    }else if(document.activeElement===$('mpInput'))$('mpInput').blur();
  };
  $('mpChatToggle').addEventListener('click',()=>showChat(!chatOpen(),false));
  $('mpChatClose').addEventListener('click',()=>showChat(false));
  $('mpPeopleToggle').addEventListener('click',()=>{
    const next=!document.body.classList.contains('mpPeopleOpen');
    document.body.classList.toggle('mpPeopleOpen',next);
    $('mpPeopleToggle').setAttribute('aria-expanded',String(next));
    if(next)showChat(false);
  });
  document.addEventListener('pointerdown',e=>{
    if(!isMobile())return;
    if(chatOpen()&&!e.target.closest('#mpChat, #mpChatToggle'))showChat(false);
    if(document.body.classList.contains('mpPeopleOpen')&&!e.target.closest('#mpPeople, #mpPeopleToggle')){
      document.body.classList.remove('mpPeopleOpen');$('mpPeopleToggle').setAttribute('aria-expanded','false');
    }
  },true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){showChat(false);document.body.classList.remove('mpPeopleOpen');$('mpPeopleToggle').setAttribute('aria-expanded','false');}});
  const noteUnread=()=>{
    if(!isMobile()||chatOpen())return;
    unread=Math.min(99,unread+1);
    $('mpChatBadge').textContent=unread>9?'9+':String(unread);
    $('mpChatToggle').classList.add('hasUnread');
  };
  // Desktop stays open; mobile is compact by default.

  try {name.value=localStorage.getItem('sushi-name')||'손님';color.value=localStorage.getItem('sushi-color')||'#b68c67';}catch{}
  MP.toast=msg=>{
    const el=$('mpToast');el.textContent=msg;el.style.display='block';
    clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.style.display='none',3000);
  };
  MP.send=obj=>{if(isLocal){localAction(obj);return;}if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));};
  const log=(who,msg)=>{
    const parent=$('mpMessages');const line=document.createElement('div');
    const title=document.createElement('b');title.textContent=who+'  ';
    line.append(title,document.createTextNode(msg));parent.append(line);
    while(parent.childElementCount>55)parent.firstChild.remove();parent.scrollTop=parent.scrollHeight;
  };
  const store=()=>{name.value=name.value.trim().slice(0,14)||'손님';try{localStorage.setItem('sushi-name',name.value);localStorage.setItem('sushi-color',color.value)}catch{}};
  const roomLabel=()=>{
    $('mpRoomCode').textContent=isLocal?'오프라인 · 혼자':roomCode?`방 ${roomCode}`:'방 미입장';
    $('mpCopy').disabled=!joined||isLocal;
  };
  const render=()=>{
    const wasChef=MP.isChef;
    MP.isChef=joined && self!==null && chef===self;
    MP.chef=chef;
    MP.users=users;
    $('mpCount').textContent=users.length+'/8';
    $('mpDot').classList.toggle('ok',joined&&connected);
    $('mpStatus').textContent=isLocal?'오프라인':joined?'접속됨':connected?'방 선택':'연결 대기';
    $('mpRoleText').textContent=MP.isChef?`셰프 · 준비 중 ${MP.stock}점 · 내 접시 ${MP.served}점`:`${chef?(users.find(u=>u.id===chef)?.name||'셰프')+' 조리 중':'셰프 자리 비어 있음'} · 내 접시 ${MP.served}점`;
    $('mpTake').style.display=joined&&MP.ready>0?'':'none';
    $('mpClaim').style.display=joined&&!chef?'':'none';
    $('mpClaim').disabled=!joined;
    $('mpRelease').style.display=MP.isChef?'':'none';
    $('mpServe').style.display=MP.isChef?'':'none';
    $('mpServe').disabled=MP.stock===0;
    const victims=users.filter(u=>u.id!==self && u.plate>0);
    $('mpSteal').style.display=MP.isChef&&victims.length?'':'none';
    $('mpSteal').disabled=!victims.length;
    $('mpPraise').style.display=joined&&!!chef&&!MP.isChef?'':'none';
    $('mpBoo').style.display=joined&&!!chef&&!MP.isChef?'':'none';
    $('mpReactions').textContent=`👏 ${MP.cheer||0} · 😖 ${MP.boo||0}`;

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
      if(u.plate>0){const food=document.createElement('span');food.className='mpChef';food.textContent=`${u.plate}점`;row.append(food);}
      if(u.id===chef){const badge=document.createElement('span');badge.className='mpChef';badge.textContent='셰프';row.append(badge);}
      if(MP.isChef && u.id!==self && u.plate>0){
        const take=document.createElement('button');take.className='mpSneak';take.type='button';
        take.textContent='몰래 한 점';take.title=`${u.name} 접시에서 회 한 점 몰래 집어먹기`;
        take.onclick=()=>MP.send({type:'steal',target:u.id});row.append(take);
      }
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
      log('시스템',m.created?`방 ${roomCode}를 새로 만들었어요. 이 코드를 공유해 보세요.`:`방 ${roomCode}에 입장했어요.`);
      render();
      return;
    }
    if(m.type==='state'){
      if(m.room!==roomCode)return;
      chef=m.chef;users=m.users;MP.stock=m.stock;MP.ready=m.served;
      const me=users.find(u=>u.id===self)||{};
      MP.served=me.plate||0;MP.plateCuts=Array.isArray(me.plateCuts)?me.plateCuts.slice():[];
      MP.cheer=m.cheer||0;MP.boo=m.boo||0;MP.room=m.room;MP.cutState=m;
      render();
      if(typeof MP.onCutState==='function')MP.onCutState(m);
      if(typeof MP.reconcile==='function')MP.reconcile();
      if(MP.wantDining && MP.served>0 && typeof MP.enterDining==='function'){
        MP.wantDining=false;MP.enterDining();
      }
      return;
    }
    if(m.type==='cut-animation'){
      if(typeof MP.playCut==='function')MP.playCut(m.cut);
      return;
    }
    if(m.type==='cut-reset'){
      if(typeof MP.onCutReset==='function')MP.onCutReset(m.generation);
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
    if(m.type==='chat'){log(m.name,m.message);if(typeof MP.showBubble==='function')MP.showBubble(m.id,m.message);if(m.id!==self)noteUnread();return;}
    if(m.type==='reaction'){
      const prefix=m.kind==='praise'?'👏':'😖';
      log(`${prefix} ${m.name}`,m.message);
      if(typeof MP.showBubble==='function')MP.showBubble(m.id,`${prefix} ${m.message}`);
      if(m.id!==self)noteUnread();
      if(self===m.chefId)MP.toast(m.kind==='praise'?'셰프 칭찬을 받았어!':'셰프에게 맛 혹평이 들어왔어!');
      return;
    }
    if(m.type==='steal-animation'){
      if(typeof MP.playSteal==='function')MP.playSteal(m);
      return;
    }
    if(m.type==='steal-ok'){
      MP.toast(`쉿! ${m.target} 접시에서 참치 한 점 성공 (${m.total}점째)`);
      return;
    }
    if(m.type==='notice'){log('스시집',m.message);return;}
    if(m.type==='error'){
      if(typeof MP.onCutError==='function')MP.onCutError();
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
    if(isLocal){MP.toast('멀티 방에 들어가려면 페이지를 새로고침해 줘.');return;}
    if(ws && ws.readyState===WebSocket.OPEN)return sendEntry();
    if(ws && ws.readyState===WebSocket.CONNECTING)return;
    const scheme=location.protocol==='https:'?'wss':'ws';
    ws=new WebSocket(scheme+'://'+location.host);
    ws.onopen=()=>{connected=true;render();sendEntry();};
    ws.onmessage=onMessage;
    ws.onerror=()=>MP.toast('서버 연결을 확인해 주세요.');
    ws.onclose=()=>{
      if(isLocal)return;
      connected=false;joined=false;self=null;chef=null;roomCode='';users=[];MP.isChef=false;MP.users=[];MP.stock=0;MP.served=0;MP.plateCuts=[];MP.ready=0;MP.wantDining=false;MP.cutState=null;
      render();$('mpSetup').style.display='grid';$('mpLobbyError').textContent='연결이 끊어졌어요. 방 코드를 입력해 다시 입장해 주세요.';
      log('시스템','서버 연결이 종료되었어요.');
    };
  }
  // Server-free solo mode. Reuses the same MP render hooks and cutting timeline.
  // It never connects a WebSocket; file:// and hosted pages behave the same.
  function offlineSync(){
    if(!localRoom)return;
    const r=localRoom;
    const member={id:'solo',name:name.value,color:color.value,seat:0,
      plate:r.plateCuts.length,plateCuts:r.plateCuts.slice(),eaten:r.eaten,stolen:0};
    onMessage({data:JSON.stringify({type:'state',room:'오프라인',chef:'solo',stock:r.stockCuts.length,
      served:0,revision:r.revision++,generation:r.generation,cuts:r.cuts.slice(),
      cutting:r.cutting,totalCuts:r.totalCuts,eatenTotal:r.eaten,stolenTotal:0,
      cheer:0,boo:0,users:[member]})});
  }
  function offlineServe(){
    if(!localRoom||!localRoom.stockCuts.length)return;
    localRoom.plateCuts.push(...localRoom.stockCuts);
    localRoom.stockCuts=[];
    offlineSync();
    onMessage({data:JSON.stringify({type:'serve-ok'})});
  }
  function localAction(m){
    const r=localRoom;if(!r)return;
    if(m.type==='profile')return offlineSync();
    if(m.type==='claim'||m.type==='release')return MP.toast('오프라인에서는 언제든 셰프처럼 썰고 먹을 수 있어.');
    if(m.type==='chat'){
      const message=String(m.message||'').trim().slice(0,160);
      if(message)onMessage({data:JSON.stringify({type:'chat',id:'solo',name:name.value,message})});
      return;
    }
    if(m.type==='slice'){
      if(r.cutting)return MP.toast('칼질이 끝난 뒤 다시 썰어 줘.');
      const remaining=3.2-r.progress;
      if(remaining<.03)return MP.toast('참치를 다 썰었어. 새 참치 준비를 눌러 줘.');
      if(r.stockCuts.length>=40)return MP.toast('회를 접시에 내놓거나 새 참치를 준비해 줘.');
      const thickness=Math.min(remaining,Math.max(.12,Math.min(.45,Number(m.thickness)||.22)));
      const speed=Math.max(.5,Math.min(2,Number(m.speed)||1));
      const cut={id:++r.nextCut,xa:r.progress,xb:r.progress+thickness,speed,started:Date.now()};
      r.cutting=cut;
      onMessage({data:JSON.stringify({type:'cut-animation',cut})});offlineSync();
      clearTimeout(localCutTimer);
      localCutTimer=setTimeout(()=>{
        if(!localRoom||r.cutting!==cut)return;
        r.cuts.push(cut.xb-cut.xa);r.stockCuts.push(cut.xb-cut.xa);
        r.progress=cut.xb;r.cutting=null;r.totalCuts++;offlineSync();
      },Math.ceil(2150/speed));
      return;
    }
    if(m.type==='serve'){
      if(r.cutting)return MP.toast('칼질이 끝난 다음 접시에 담아 줘.');
      offlineServe();return;
    }
    if(m.type==='reset'){
      if(r.cutting)return MP.toast('칼질이 끝난 다음 새 참치를 준비해 줘.');
      offlineServe();r.generation++;r.progress=0;r.cuts=[];
      onMessage({data:JSON.stringify({type:'cut-reset',generation:r.generation})});
      onMessage({data:JSON.stringify({type:'reset-ok'})});offlineSync();return;
    }
    if(m.type==='eat'){
      if(!r.plateCuts.length)return MP.toast('내 접시에 회가 없어.');
      const index=Number.isInteger(m.index)?Math.max(0,Math.min(r.plateCuts.length-1,m.index)):0;
      r.plateCuts.splice(index,1);r.eaten++;offlineSync();return;
    }
    if(m.type==='react')return MP.toast('혼자 즐기는 중이야. 셰프 평가는 멀티에서 해 봐!');
  }
  function startSolo(){
    store();
    if(ws){try{ws.close()}catch{} ws=null;}
    isLocal=true;MP.isLocal=true;connected=true;joined=true;pending=null;self='solo';
    roomCode='오프라인';chef='solo';users=[];
    localRoom={stockCuts:[],plateCuts:[],cuts:[],progress:0,generation:0,
      nextCut:0,totalCuts:0,cutting:null,eaten:0,revision:0};
    $('mpSetup').style.display='none';$('mpProfile').disabled=false;
    $('mpLobbyControls').style.display='block';$('mpSaveProfile').style.display='none';
    $('mpLobbyError').textContent='';
    offlineSync();
    log('시스템','오프라인 1인 모드로 입장했어. 서버 없이 썰고 먹을 수 있어.');
  }
  $('mpOffline').onclick=startSolo;

  $('mpCreate').onclick=()=>connectAndEnter('create','');
  $('mpJoin').onclick=()=>{
    // Use the same normalization as the server. Do not strip meaningful spaces.
    const code=codeInput.value.trim().normalize('NFC').toUpperCase();
    if(!code){
      $('mpLobbyError').textContent='원하는 방 코드를 입력해 줘.';return;
    }
    if(Array.from(code).length>64){
      $('mpLobbyError').textContent='방 코드는 최대 64글자까지 입력할 수 있어.';return;
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
  $('mpSteal').onclick=()=>{
    const victims=users.filter(u=>u.id!==self&&u.plate>0);
    if(!victims.length)return MP.toast('몰래 집어먹을 손님 회가 없어.');
    const target=victims[stealCursor++%victims.length];
    MP.send({type:'steal',target:target.id});
  };
  $('mpTake').onclick=()=>MP.send({type:'take'});
  $('mpPraise').onclick=()=>MP.send({type:'react',kind:'praise'});
  $('mpBoo').onclick=()=>MP.send({type:'react',kind:'boo'});
  $('mpSend').onsubmit=e=>{
    e.preventDefault();const input=$('mpInput'),message=input.value.trim();
    if(message)MP.send({type:'chat',message});input.value='';if(isMobile())showChat(false);
  };
  roomLabel();render();
  if(location.protocol==='file:' || /(^|\/)offline\.html$/i.test(location.pathname))startSolo();
})();
