'use strict';

const CARD_IMG={
  RUN:'cards/run-card.webp',
  PASS:'cards/pass-card.webp',
  TACKLE:'cards/tackle-card.webp',
  INTERCEPTION:'cards/interception-card.webp',
  BLOCK:'cards/block-card.webp',
  BLITZ:'cards/blitz-card.webp',
  FOOTBALL:'cards/football-card.webp'
};
const HAND={2:7,3:6,4:5};
const POOLS={
  2:{RUN:6,PASS:6,TACKLE:5,INTERCEPTION:3,BLOCK:5,BLITZ:3},
  3:{RUN:8,PASS:8,TACKLE:7,INTERCEPTION:4,BLOCK:7,BLITZ:4},
  4:{RUN:10,PASS:10,TACKLE:9,INTERCEPTION:5,BLOCK:9,BLITZ:5}
};
const POS=[50,40,30,20,10];
const $=id=>document.getElementById(id);
let peer=null,conn=null,netRole=null,myTeam=null,roomCode='',selectedSize=2,selectedPlayer=null;
let G=null,VIEW=null;
let reconnectTimer=null;
let lastRedProgress=null;
let lastBlueProgress=null;
let assetsReady=false;

const GAME_ASSETS=[
  CARD_IMG.RUN,
  CARD_IMG.PASS,
  CARD_IMG.TACKLE,
  CARD_IMG.INTERCEPTION,
  CARD_IMG.BLOCK,
  CARD_IMG.BLITZ,
  CARD_IMG.FOOTBALL
];

async function preloadGameAssets(){
  assetsReady=false;

  const screen=$('loadingScreen');
  const fill=$('loadingFill');
  const percent=$('loadingPercent');
  const text=$('loadingText');
  const retry=$('retryLoadBtn');

  screen.classList.remove('done');
  retry.hidden=true;
  fill.style.width='0%';
  percent.textContent='0%';
  text.textContent='Loading card images...';

  let loaded=0;

  try{
    await Promise.all(
      GAME_ASSETS.map(src=>new Promise((resolve,reject)=>{
        const img=new Image();

        img.onload=()=>{
          loaded++;
          const p=Math.round(
            loaded/GAME_ASSETS.length*100
          );

          fill.style.width=p+'%';
          percent.textContent=p+'%';
          resolve();
        };

        img.onerror=()=>{
          reject(new Error('Failed to load '+src));
        };

        img.src=src;
      }))
    );

    fill.style.width='100%';
    percent.textContent='100%';
    text.textContent='Ready!';

    assetsReady=true;

    setTimeout(()=>{
      screen.classList.add('done');
    },350);

  }catch(err){
    console.error(err);
    text.textContent='Some images failed to load.';
    retry.hidden=false;
  }
}

$('retryLoadBtn').onclick=preloadGameAssets;
function show(id,on=true){$(id).classList.toggle('show',on)}
function setNet(text,on=false){$('netText').textContent=text;$('netDot').classList.toggle('on',on)}
function addLocalLog(msg){if(netRole==='host'&&G){G.logs.push(msg);if(G.logs.length>80)G.logs.shift();} }
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function other(t){return t==='red'?'blue':'red'}
function teamPlayers(team){return G.players.filter(p=>p.team===team)}
function player(id){return G.players.find(p=>p.id===id)}
function hasAttack(team){return teamPlayers(team).some(p=>p.hand.some(c=>c==='RUN'||c==='PASS'))}
function removeCard(pid,card){const p=player(pid),i=p.hand.indexOf(card);if(i<0)return false;p.hand.splice(i,1);G.discard.push(card);return true}
function randomCode(){return String(Math.floor(100000+Math.random()*900000))}

function createGame(size){
  const players=[];
  for(const team of ['red','blue']){
    const prefix=team==='red'?'R':'B';
    for(let i=1;i<=size;i++)players.push({id:prefix+i,team,num:i,role:'PLAYER',skill:false,hand:[]});
    const q=1+Math.floor(Math.random()*size);playerTemp(players,prefix+q).role='QB';
  }
  const deck=[];for(const [c,n] of Object.entries(POOLS[size]))for(let i=0;i<n;i++)deck.push(c);shuffle(deck);
  G={version:1,size,players,deck,discard:[],round:1,firstTeam:null,offense:null,holder:null,redProgress:0,blueProgress:0,redBalls:0,blueBalls:0,phase:'rps',pending:null,rps:{red:null,blue:null},logs:['Match started. Choose Rock, Paper, or Scissors.']};
  dealAll();
}
function playerTemp(arr,id){return arr.find(p=>p.id===id)}
function dealAll(){
  const n=HAND[G.size];
  for(const p of G.players)p.hand=[];
  for(let r=0;r<n;r++)for(const p of G.players){if(G.deck.length)p.hand.push(G.deck.pop())}
}
function recycleAndDeal(){
  const all=[...G.deck,...G.discard];
  for(const p of G.players)all.push(...p.hand);
  G.deck=shuffle(all);G.discard=[];dealAll();
}
function filtered(team){
  if(!G)return null;
  return {version:G.version,size:G.size,round:G.round,firstTeam:G.firstTeam,offense:G.offense,holder:G.holder,redProgress:G.redProgress,blueProgress:G.blueProgress,redBalls:G.redBalls,blueBalls:G.blueBalls,phase:G.phase,pending:publicPending(G.pending,team),logs:G.logs.slice(-80),me:team,players:G.players.map(p=>({id:p.id,team:p.team,num:p.num,role:p.team===team?p.role:'?',skill:p.team===team?p.skill:null,hand:p.team===team?[...p.hand]:null,handCount:p.hand.length}))};
}
function publicPending(p,team){if(!p)return null;return {action:p.action,attacker:p.attacker,receiver:p.receiver||null,defense:p.defense||null,defender:p.defender||null,qbBoost:!!p.qbBoost};}
function broadcast(){
  G.version++;
  VIEW=filtered('red');render();
  if(conn&&conn.open)conn.send({type:'state',state:filtered('blue')});
}
function sendAction(action,payload={}){if(netRole==='host')dispatch('red',action,payload,G?G.version:0);else if(conn&&conn.open)conn.send({type:'action',team:'blue',action,payload,version:VIEW?.version||0});}

function dispatch(team,action,payload,version){
  if(!G)return;
  if(version&&version!==G.version&&action!=='rps')return;
  if(action==='rps')return doRps(team,payload.choice);
  if(action==='selectCarrier')return selectCarrier(team,payload.playerId);
  if(action==='playAttack')return playAttack(team,payload.playerId,payload.card);
  if(action==='selectReceiver')return selectReceiver(team,payload.playerId);
  if(action==='qbSkill')return qbSkill(team,!!payload.use);
  if(action==='defend')return defend(team,payload.playerId,payload.card||null);
  if(action==='block')return block(team,payload.playerId,payload.card||null);
  if(action==='finalBlitz')return finalBlitz(team,payload.playerId,payload.card||null);
}
function doRps(team,choice){
  if(G.phase!=='rps'||!['rock','paper','scissors'].includes(choice)||G.rps[team])return;
  G.rps[team]=choice;broadcast();
  if(G.rps.red&&G.rps.blue){
    const r=G.rps.red,b=G.rps.blue;
    if(r===b){G.logs.push(`RPS tie: ${r.toUpperCase()}. Choose again.`);G.rps={red:null,blue:null};broadcast();return;}
    const redWins=(r==='rock'&&b==='scissors')||(r==='paper'&&b==='rock')||(r==='scissors'&&b==='paper');
    G.firstTeam=redWins?'red':'blue';G.offense=G.firstTeam;G.phase='choose';G.logs.push(`${G.firstTeam.toUpperCase()} wins RPS and gets first possession.`);broadcast();
  }
}
function selectCarrier(team,pid){if(G.phase!=='choose'||team!==G.offense)return;const p=player(pid);if(!p||p.team!==team||!p.hand.some(c=>c==='RUN'||c==='PASS'))return;G.holder=pid;G.phase='attack';G.logs.push(`${pid} has the FOOTBALL CARD.`);broadcast();}
function playAttack(team,pid,card){if(G.phase!=='attack'||team!==G.offense||pid!==G.holder||!['RUN','PASS'].includes(card))return;if(!removeCard(pid,card))return;G.pending={action:card,attacker:pid,receiver:null,defense:null,defender:null,qbBoost:false};if(card==='RUN'){G.phase='defense';G.logs.push(`${pid} plays RUN.`);}else{G.phase='receiver';G.logs.push(`${pid} plays PASS. Choose a receiver.`);}broadcast();}
function selectReceiver(team,pid){if(G.phase!=='receiver'||team!==G.offense)return;const p=player(pid),a=player(G.pending.attacker);if(!p||p.team!==team||pid===a.id)return;G.pending.receiver=pid;if(a.role==='QB'&&!a.skill)G.phase='qb';else G.phase='defense';G.logs.push(`${pid} is the PASS target.`);broadcast();}
function qbSkill(team,use){if(G.phase!=='qb'||team!==G.offense)return;const a=player(G.pending.attacker);if(!a||a.role!=='QB'||a.skill)return;if(use){a.skill=true;G.pending.qbBoost=true;G.logs.push(`${a.id} uses the QB skill: a successful PASS advances 2 spaces.`);}G.phase='defense';broadcast();}
function defend(team,pid,card){if(G.phase!=='defense'||team===G.offense)return;if(!card){G.logs.push(`${team.toUpperCase()} does not defend.`);return successPlay();}const a=G.pending.action;const valid=card==='BLITZ'||(a==='RUN'&&card==='TACKLE')||(a==='PASS'&&card==='INTERCEPTION');const p=player(pid);if(!valid||!p||p.team!==team||!removeCard(pid,card))return;G.pending.defense=card;G.pending.defender=pid;G.logs.push(`${pid} plays ${card}.`);if(card==='BLITZ')return failPlay('BLITZ stops the play.');G.phase='block';broadcast();}
function block(team,pid,card){if(G.phase!=='block'||team!==G.offense)return;if(!card){if(G.pending.defense==='INTERCEPTION')return interception();return failPlay(`${G.pending.defense} stops the play.`);}if(card!=='BLOCK')return;const p=player(pid);if(!p||p.team!==team||!removeCard(pid,'BLOCK'))return;G.logs.push(`${pid} plays BLOCK.`);G.phase='final';broadcast();}
function finalBlitz(team,pid,card){if(G.phase!=='final'||team===G.offense)return;if(!card)return successPlay();if(card!=='BLITZ')return;const p=player(pid);if(!p||p.team!==team||!removeCard(pid,'BLITZ'))return;G.logs.push(`${pid} plays final BLITZ.`);return failPlay('Final BLITZ stops the play.');}
function interception(){const d=G.pending.defender;G.holder=d;G.offense=player(d).team;G.logs.push(`${d} completes the INTERCEPTION. Possession changes.`);G.pending=null;afterPlay();}
function successPlay(){const p=G.pending;G.holder=p.action==='PASS'?p.receiver:p.attacker;const step=p.qbBoost?2:1;const key=G.offense==='red'?'redProgress':'blueProgress';G[key]=Math.min(4,G[key]+step);G.logs.push(`${G.offense.toUpperCase()} gains ${step} field ${step===1?'space':'spaces'}.`);G.pending=null;if(G[key]>=4)return touchdown(G.offense);afterPlay();}
function failPlay(msg){G.logs.push(msg);G.holder=G.pending.attacker;G.pending=null;afterPlay();}
function touchdown(team){const ballsKey=team==='red'?'redBalls':'blueBalls',progKey=team==='red'?'redProgress':'blueProgress';G[ballsKey]++;G[progKey]=0;G.logs.push(`TOUCHDOWN! ${team.toUpperCase()} earns a football.`);if(G[ballsKey]>=3){G.phase='gameover';G.logs.push(`${team.toUpperCase()} wins the match!`);broadcast();return;}G.round++;G.firstTeam=other(G.firstTeam);G.offense=G.firstTeam;G.holder=null;recycleAndDeal();G.phase='choose';G.logs.push(`Round ${G.round}. ${G.firstTeam.toUpperCase()} starts with possession.`);broadcast();}
function afterPlay(){
  if(!hasAttack('red')&&!hasAttack('blue')){G.round++;G.firstTeam=other(G.firstTeam);G.offense=G.firstTeam;G.holder=null;recycleAndDeal();G.phase='choose';G.logs.push(`No offense cards remain. Round ${G.round} begins.`);broadcast();return;}
  if(!hasAttack(G.offense)){G.offense=other(G.offense);G.holder=null;G.phase='choose';G.logs.push(`Possession changes to ${G.offense.toUpperCase()} — no RUN/PASS cards remain for the other team.`);broadcast();return;}
  if(!G.holder||!player(G.holder).hand.some(c=>c==='RUN'||c==='PASS')){G.holder=null;G.phase='choose';broadcast();return;}
  G.phase='attack';broadcast();
}
function bindConn(c,isHost){
  conn=c;

  conn.on('open',()=>{
    clearTimeout(reconnectTimer);
    setNet(isHost?'BLUE connected':'Connected to RED',true);

    if(isHost){
      $('guestWaitText').textContent='BLUE player connected.';
      $('startBtn').disabled=false;

      // Reconnecting BLUE receives the current match state.
      if(G){
        c.send({
          type:'state',
          state:filtered('blue')
        });
      }
    }else{
      show('lobby',false);
      $('lobbyStatus').textContent='';
    }
  });

  conn.on('data',msg=>{
    if(isHost){
      if(msg?.type==='action'){
        dispatch(
          'blue',
          msg.action,
          msg.payload||{},
          msg.version||0
        );
      }
    }else if(msg?.type==='state'){
      VIEW=msg.state;
      render();

      if(VIEW.phase==='rps'){
        show('rpsOverlay',true);
      }else{
        show('rpsOverlay',false);
      }
    }
  });

  conn.on('close',()=>{
    setNet(
      isHost?'BLUE reconnecting…':'Reconnecting…',
      false
    );

    $('turnPrompt').textContent=isHost
      ?'Waiting for BLUE to reconnect…'
      :'Reconnecting to RED…';

    if(!isHost){
      scheduleReconnect();
    }
  });

  conn.on('error',()=>{
    setNet(
      isHost?'BLUE connection error':'Reconnecting…',
      false
    );

    if(!isHost){
      scheduleReconnect();
    }
  });
}

function peerOptions(){
  return {
    host:'0.peerjs.com',
    port:443,
    path:'/',
    secure:true,
    debug:2,
    config:{
      iceServers:[
        {
          urls:'stun:stun.relay.metered.ca:80'
        },
        {
          urls:'turn:global.relay.metered.ca:80',
          username:'f6daee39b5d43cc2cf594321',
          credential:'y9iktPyDeiFn3GdK'
        },
        {
          urls:'turn:global.relay.metered.ca:80?transport=tcp',
          username:'f6daee39b5d43cc2cf594321',
          credential:'y9iktPyDeiFn3GdK'
        },
        {
          urls:'turn:global.relay.metered.ca:443',
          username:'f6daee39b5d43cc2cf594321',
          credential:'y9iktPyDeiFn3GdK'
        },
        {
          urls:'turns:global.relay.metered.ca:443?transport=tcp',
          username:'f6daee39b5d43cc2cf594321',
          credential:'y9iktPyDeiFn3GdK'
        }
      ]
    }
  };
}

function connectGuest(){
  if(
    netRole!=='guest' ||
    !peer ||
    peer.destroyed ||
    !peer.open ||
    (conn && conn.open)
  ) return;

  setNet('Connecting…',false);

  const c=peer.connect(
    'gsm-football-'+roomCode,
    {reliable:true}
  );

  bindConn(c,false);
}

function scheduleReconnect(){
  if(netRole!=='guest' || !roomCode)return;

  clearTimeout(reconnectTimer);

  reconnectTimer=setTimeout(()=>{
    if(!peer || peer.destroyed)return;

    if(peer.disconnected){
      try{
        peer.reconnect();
      }catch(e){
        console.error(e);
      }
    }

    if(peer.open){
      connectGuest();
    }else{
      peer.once('open',connectGuest);
    }
  },1200);
}

function resumeConnection(){
  if(netRole==='host'){
    if(
      peer &&
      peer.disconnected &&
      !peer.destroyed
    ){
      try{
        peer.reconnect();
      }catch(e){
        console.error(e);
      }
    }
  }else if(
    netRole==='guest' &&
    (!conn || !conn.open)
  ){
    scheduleReconnect();
  }
}

document.addEventListener('visibilitychange',()=>{
  if(!document.hidden){
    resumeConnection();
  }
});

window.addEventListener('online',resumeConnection);
window.addEventListener('pageshow',resumeConnection);

function createRoom(){
  roomCode=randomCode();
  netRole='host';
  myTeam='red';
  setNet('Creating room…');

  peer=new Peer(
    'gsm-football-'+roomCode,
    peerOptions()
  );

  peer.on('open',()=>{
    show('lobby',false);
    show('hostSetup',true);
    $('roomCodeText').textContent=roomCode;
    $('copyRoomBtn').hidden=false;
    setNet('Waiting for BLUE',false);
  });

  peer.on('connection',c=>{
    if(conn && conn.open){
      c.close();
      return;
    }

    bindConn(c,true);
  });

  peer.on('disconnected',()=>{
    setNet('Reconnecting room…',false);

    if(!document.hidden){
      resumeConnection();
    }
  });

  peer.on('error',e=>{
    $('lobbyStatus').textContent=
      'Could not create room. Try again.';
    setNet('Offline',false);
    console.error(e);
  });
}

function joinRoom(){
  const code=$('roomInput')
    .value
    .replace(/\D/g,'')
    .slice(0,6);

  if(code.length!==6){
    $('lobbyStatus').textContent=
      'Enter the 6-digit room code.';
    return;
  }

  roomCode=code;
  netRole='guest';
  myTeam='blue';
  setNet('Connecting…');

  peer=new Peer(
    undefined,
    peerOptions()
  );

  peer.on('open',connectGuest);

  peer.on(
    'disconnected',
    scheduleReconnect
  );

  peer.on('error',e=>{
    console.error(e);

    if(netRole==='guest'){
      scheduleReconnect();
    }
  });
}

function redProgressLeft(n){
  return `${50+n*8}%`;
}

function blueProgressLeft(n){
  return `${50-n*8}%`;
}
function render(){
  const V=netRole==='host'?filtered('red'):VIEW;if(!V)return;
  $('redBalls').textContent=V.redBalls;$('blueBalls').textContent=V.blueBalls;$('redProgress').textContent=POS[V.redProgress]??'TD';$('blueProgress').textContent=POS[V.blueProgress]??'TD';$('roundText').textContent=`ROUND ${V.round}`;$('redMarker').style.left=redProgressLeft(V.redProgress);$('blueMarker').style.left=blueProgressLeft(V.blueProgress);;$('possessionText').textContent=V.offense?`${V.offense.toUpperCase()}${V.holder?' · '+V.holder:''}`:'—';$('myTeamText').textContent=`YOU ARE ${V.me.toUpperCase()}`;
const redTeam=$('redMarker');
const blueTeam=$('blueMarker');

if(lastRedProgress!==null && V.redProgress!==lastRedProgress){
  redTeam.classList.add('running');
  clearTimeout(redTeam.runTimer);

  redTeam.runTimer=setTimeout(()=>{
    redTeam.classList.remove('running');
  },750);
}

if(lastBlueProgress!==null && V.blueProgress!==lastBlueProgress){
  blueTeam.classList.add('running');
  clearTimeout(blueTeam.runTimer);

  blueTeam.runTimer=setTimeout(()=>{
    blueTeam.classList.remove('running');
  },750);
}

lastRedProgress=V.redProgress;
lastBlueProgress=V.blueProgress;
  if(V.phase==='attack'&&V.offense===V.me&&V.holder)selectedPlayer=V.holder;
  renderRoster('red',V);renderRoster('blue',V);renderHand(V);renderActions(V);renderLog(V);
  if(V.phase==='rps'){show('rpsOverlay',true);$('rpsStatus').textContent=(G?.rps?.[myTeam]||(!G&&false))?'Waiting for opponent…':'Choose one.';}else show('rpsOverlay',false);
  if(V.phase==='gameover'){show('gameOver',true);$('winnerText').textContent=(V.redBalls>=3?'RED':'BLUE')+' WINS!';}
}
function renderRoster(team,V){const root=$(team+'Roster');root.innerHTML='';for(const p of V.players.filter(x=>x.team===team)){const d=document.createElement('div');d.className='player '+(p.team===V.me?'mine':'')+(selectedPlayer===p.id?' active':'');d.innerHTML=`<b>${p.id}</b><small>${p.role}${p.role==='QB'&&p.skill?' · USED':''}</small><small>${p.handCount} cards</small>`;if(p.team===V.me)d.onclick=()=>{selectedPlayer=p.id;render()};root.appendChild(d)}}
function renderHand(V){const root=$('hand');root.innerHTML='';const mine=V.players.filter(p=>p.team===V.me);if(!selectedPlayer||!mine.some(p=>p.id===selectedPlayer))selectedPlayer=mine[0]?.id||null;const p=mine.find(x=>x.id===selectedPlayer);if(!p)return;const counts={};for(const c of p.hand)counts[c]=(counts[c]||0)+1;for(const [c,n] of Object.entries(counts)){const b=document.createElement('button');b.className='game-card';b.innerHTML=`<img src="${CARD_IMG[c]}" alt="${c}"><span class="count">×${n}</span>`;b.onclick=()=>cardClicked(V,p.id,c);root.appendChild(b)}}
function cardClicked(V,pid,c){if(V.phase==='attack'&&V.offense===V.me&&pid===V.holder&&(c==='RUN'||c==='PASS'))sendAction('playAttack',{playerId:pid,card:c});else if(V.phase==='defense'&&V.offense!==V.me)sendAction('defend',{playerId:pid,card:c});else if(V.phase==='block'&&V.offense===V.me&&c==='BLOCK')sendAction('block',{playerId:pid,card:c});else if(V.phase==='final'&&V.offense!==V.me&&c==='BLITZ')sendAction('finalBlitz',{playerId:pid,card:c});}
function addAction(label,fn,cls=''){const b=document.createElement('button');b.textContent=label;b.className=cls;b.onclick=fn;$('actionButtons').appendChild(b)}
function renderActions(V){const a=$('actionButtons');a.innerHTML='';let prompt='Waiting for opponent…';const me=V.me;
  if(V.phase==='rps')prompt='Choose Rock, Paper, or Scissors.';
  if(V.phase==='choose'){if(V.offense===me){prompt='Choose a teammate with RUN or PASS to carry the FOOTBALL CARD.';for(const p of V.players.filter(x=>x.team===me&&x.hand&&x.hand.some(c=>c==='RUN'||c==='PASS')))addAction(`USE ${p.id}`,()=>sendAction('selectCarrier',{playerId:p.id}));}else prompt=`${V.offense.toUpperCase()} is choosing a ball carrier.`;}
  if(V.phase==='attack'){prompt=V.offense===me?'Play RUN or PASS from the current ball carrier.':`${V.offense.toUpperCase()} is attacking.`;}
  if(V.phase==='receiver'){if(V.offense===me){prompt='Choose a PASS receiver.';for(const p of V.players.filter(x=>x.team===me&&x.id!==V.pending.attacker))addAction(`PASS TO ${p.id}`,()=>sendAction('selectReceiver',{playerId:p.id}));}else prompt='Opponent is choosing a receiver.';}
  if(V.phase==='qb'){if(V.offense===me){prompt='Use the QB one-time PASS boost?';addAction('USE QB SKILL',()=>sendAction('qbSkill',{use:true}));addAction('SAVE SKILL',()=>sendAction('qbSkill',{use:false}));}else prompt='Opponent is deciding whether to use QB skill.';}
  if(V.phase==='defense'){if(V.offense!==me){prompt='Defend now or let the play continue.';addAction('NO DEFENSE',()=>sendAction('defend',{playerId:selectedPlayer,card:null}),'warn');}else prompt='Opponent may defend.';}
  if(V.phase==='block'){if(V.offense===me){prompt='Play BLOCK or accept the stop/interception.';addAction('NO BLOCK',()=>sendAction('block',{playerId:selectedPlayer,card:null}),'warn');}else prompt='Opponent may play BLOCK.';}
  if(V.phase==='final'){if(V.offense!==me){prompt='Final chance: play BLITZ or let the offense succeed.';addAction('NO BLITZ',()=>sendAction('finalBlitz',{playerId:selectedPlayer,card:null}),'warn');}else prompt='Opponent has one final BLITZ chance.';}
  if(V.phase==='gameover')prompt='Match complete.';$('turnPrompt').textContent=prompt;
}
function renderLog(V){const root=$('log');root.innerHTML=V.logs.map(x=>`<div>• ${escapeHtml(x)}</div>`).join('');root.scrollTop=root.scrollHeight}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}

$('createBtn').onclick=createRoom;$('joinBtn').onclick=joinRoom;$('roomInput').oninput=e=>e.target.value=e.target.value.replace(/\D/g,'').slice(0,6);$('copyRoomBtn').onclick=()=>navigator.clipboard?.writeText(roomCode);
document.querySelectorAll('.size-btn').forEach(b=>b.onclick=()=>{selectedSize=+b.dataset.size;document.querySelectorAll('.size-btn').forEach(x=>x.classList.toggle('active',x===b))});
$('startBtn').onclick=()=>{createGame(selectedSize);show('hostSetup',false);broadcast();show('rpsOverlay',true)};
document.querySelectorAll('[data-rps]').forEach(b=>b.onclick=()=>{sendAction('rps',{choice:b.dataset.rps});$('rpsStatus').textContent='Choice locked. Waiting for opponent…';});

const params=new URLSearchParams(location.search);if(params.get('room')){$('roomInput').value=params.get('room').replace(/\D/g,'').slice(0,6)}
preloadGameAssets();
