const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

const DEFAULT_QUESTIONS = [
  {id:"q1", text:"Какой компонент является основным в природном газе?", answers:["Метан","Этан","Пропан","Бутан"], correct:0, type:"question"},
  {id:"q2", text:"Для чего нужна сепарация продукции скважины?", answers:["Для разделения фаз","Для окраски труб","Для увеличения диаметра трубы","Для замены бурового раствора"], correct:0, type:"question"},
  {id:"q3", text:"Какова одна из основных задач бурового раствора?", answers:["Вынос выбуренной породы","Окраска оборудования","Увеличение длины трубы","Замена обсадной колонны"], correct:0, type:"question"}
];

const PATH = [
 [10,31],[12,34],[15,37],[18,40],[21,43],[25,45],[29,45],[33,43],
 [35,40],[34,37],[31,34],[28,34],[25,35],[22,38],[20,42],[20,46],
 [23,49],[27,51],[31,51],[35,50],[39,47],[43,44],[47,41],[50,37],
 [51,33],[48,30],[44,29],[40,30],[37,33],[35,37],[36,41],[40,44],
 [44,47],[49,48],[53,48],[57,45],[60,41],[63,37],[66,34],[70,31],
 [74,28],[78,25],[82,23],[86,22],[88,26],[86,30],[82,32],[78,34],
 [74,37],[70,40],[67,44],[64,48],[62,52],[61,57],[62,62],[66,66],
 [71,68],[76,66],[80,62],[83,58],[86,54],[90,53],[93,56],[91,60],
 [87,64],[83,67],[79,70],[76,74],[74,79],[71,84],[67,87],[62,89],
 [57,90],[52,88],[48,84],[44,81],[40,80],[36,82],[32,86],[28,89],
 [23,90],[20,87],[18,82],[19,77],[23,73],[28,70],[33,68],[38,66],
 [43,64],[48,61],[52,58],[55,54]
];

const SPECIALS = {
  skip: new Set([21, 47, 65]),
  again: new Set([39, 60]),
  easy: new Set([8, 15, 25, 34, 53, 69, 91]),
  camera: new Set([12]),
  cross: new Set([46]),
  diagnostics: new Set([57])
};

function code() { let c; do c=crypto.randomBytes(3).toString("hex").toUpperCase(); while(rooms.has(c)); return c; }
function publicUrl(req, roomCode){
const host = process.env.PUBLIC_HOST || "192.168.0.101:3000";
return `http://${host}/?room=${encodeURIComponent(roomCode)}`;
}
function roomSnapshot(room) {
  return {
    code: room.code,
    roomName: room.roomName,
    hostId: room.hostId,
    started: room.started,
    finished: room.finished,
    teams: room.teams.map(t => ({
      id:t.id, name:t.name, players:t.players, pos:t.pos, skip:t.skip, again:t.again,
      connected:t.connected, pending:t.pending, currentPlayer:t.currentPlayer
    })),
    questions: room.questions,
    log: room.log.slice(0,50),
    pathLength: PATH.length,
    specials: {
      skip:[...SPECIALS.skip], again:[...SPECIALS.again], easy:[...SPECIALS.easy],
      camera:[...SPECIALS.camera], cross:[...SPECIALS.cross], diagnostics:[...SPECIALS.diagnostics]
    }
  };
}
function emitRoom(room) { io.to(room.code).emit("state", roomSnapshot(room)); }
function addLog(room, text) { room.log.unshift(text); room.log = room.log.slice(0,50); }
function findRoom(code) { return rooms.get(String(code||"").toUpperCase()); }
function cleanTeams(teams, count){
  const list=Array.isArray(teams)?teams:[];
  const n=Math.max(2,Math.min(12,Number(count)||list.length||2));
  return Array.from({length:n},(_,i)=>{
    const t=list[i]||{};
    return {id:"t"+i,name:String(t.name||`Команда ${i+1}`).slice(0,40),players:(Array.isArray(t.players)?t.players:[]).slice(0,4).map(x=>String(x||"").slice(0,30)),pos:0,skip:false,again:false,connected:0,pending:null,currentPlayer:0};
  });
}

app.get("/api/qr/:code", async (req,res)=>{
  const room=findRoom(req.params.code);
  if(!room) return res.status(404).send("Комната не найдена");
  res.type("png").send(await QRCode.toBuffer(publicUrl(req,room.code),{width:520,margin:2,errorCorrectionLevel:"M"}));
});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

io.on("connection", socket=>{
  socket.on("requestState", ({code})=>{
    const room=findRoom(code);
    if(!room) return socket.emit("errorMsg","Комната не найдена.");
    socket.emit("state",roomSnapshot(room));
  });

  // Первый человек, который нажимает «Создать комнату», становится её администратором.
  socket.on("createRoom", ({roomName,teamCount,teams})=>{
    const safeName=String(roomName||"Газовая трасса").trim().slice(0,60)||"Газовая трасса";
    const c=code();
    const room={
      code:c, roomName:safeName, hostId:socket.id, started:false, finished:false,
      teams:cleanTeams(teams,teamCount), questions:DEFAULT_QUESTIONS.map(q=>({...q})),
      log:[], sockets:new Map()
    };
    rooms.set(c,room);
    socket.join(c); room.sockets.set(socket.id,{role:"host"});
    addLog(room,`👑 Администратор создал комнату «${room.roomName}».`);
   socket.emit("created", {
code: c,
roomName: room.roomName,
url: publicUrl(null, c)
});
    // Клиент сам строит корректную ссылку из location.origin; URL здесь нужен только как fallback.
    emitRoom(room);
  });

  socket.on("joinRoom", ({code,name,teamId,playerIndex})=>{
    const room=findRoom(code);
    if(!room) return socket.emit("errorMsg","Комната не найдена.");
    if(room.finished) return socket.emit("errorMsg","Эта игра уже завершена.");
    const team=room.teams.find(t=>t.id===teamId);
    if(!team) return socket.emit("errorMsg","Команда не найдена.");
    const idx=Math.max(0,Math.min(3,Number(playerIndex)||0));
    const clean=String(name||"Игрок").trim().slice(0,30)||"Игрок";
    const occupied=[...room.sockets.values()].some(x=>x.role==="player"&&x.teamId===teamId&&x.playerIndex===idx);
    if(occupied) return socket.emit("errorMsg","Это место уже занято. Выберите другого игрока.");
    socket.join(room.code);
    room.sockets.set(socket.id,{role:"player",teamId,playerIndex:idx,name:clean});
    team.players[idx]=clean;
    team.connected++;
    socket.emit("joined",{code:room.code,teamId,playerIndex:idx});
    addLog(room,`👤 ${clean} присоединился к команде «${team.name}».`);
    emitRoom(room);
  });

  socket.on("updateTeams", ({code,teams,teamCount})=>{
    const room=findRoom(code);
    if(!room || room.hostId!==socket.id || room.started) return;
    room.teams=cleanTeams(teams,teamCount);
    emitRoom(room);
  });

  socket.on("startGame", ({code})=>{
    const room=findRoom(code);
    if(!room||room.hostId!==socket.id||room.started)return;
    room.started=true;
    addLog(room,`▶ Игра «${room.roomName}» началась.`);
    emitRoom(room);
  });

  socket.on("addQuestion", ({code,q})=>{
    const room=findRoom(code); if(!room||room.hostId!==socket.id)return;
    if(!q||!q.type)return;
    const question={
      id:crypto.randomUUID(), text:String(q.text||"").slice(0,500),
      answers:Array.isArray(q.answers)?q.answers.slice(0,6).map(x=>String(x).slice(0,200)):[],
      correct:Number(q.correct)||0, type:q.type
    };
    if((question.type==="question"||question.type==="easy") && (!question.text || question.answers.length<2 || question.correct<0 || question.correct>=question.answers.length)) return;
    room.questions.push(question); emitRoom(room);
  });
  socket.on("deleteQuestion", ({code,id})=>{
    const room=findRoom(code); if(!room||room.hostId!==socket.id)return;
    room.questions=room.questions.filter(q=>q.id!==id); emitRoom(room);
  });
  socket.on("replaceQuestions", ({code,questions})=>{
    const room=findRoom(code); if(!room||room.hostId!==socket.id||!Array.isArray(questions))return;
    room.questions=questions.slice(0,1000); emitRoom(room);
  });

  // Каждый team.pending хранит свой вопрос/спецклетку. Поэтому команды никогда не блокируют друг друга.
  socket.on("roll", ({code,teamId})=>{
    const room=findRoom(code);
    if(!room||!room.started||room.finished)return;
    const caller=room.sockets.get(socket.id);
    if(!caller)return;
    const team=room.teams.find(t=>t.id===teamId);
    if(!team)return;
    if(caller.role==="player" && caller.teamId!==teamId)return;
    if(caller.role!=="host" && caller.role!=="player")return;
    if(team.pending)return;

    if(team.skip){
      team.skip=false;
      addLog(room,`⛔ ${team.name} пропускает ход.`);
      team.currentPlayer=(team.currentPlayer+1)%4;
      emitRoom(room);
      return;
    }

    const n=Math.floor(Math.random()*6)+1;
    team.pos=Math.min(PATH.length-1,team.pos+n);
    addLog(room,`🎲 ${team.name}: выпало ${n}, переход на клетку ${team.pos+1}.`);

    if(team.pos>=PATH.length-1){
      room.finished=true;
      addLog(room,`🏆 ${team.name} победила!`);
      emitRoom(room);
      return;
    }

    const cell=team.pos+1;
    const makePending=(type,q=null)=>{ team.pending={type,team:team.id,cell,q}; emitRoom(room); };
    if(SPECIALS.skip.has(cell)) return makePending("skip");
    if(SPECIALS.again.has(cell)) return makePending("again");
    if(SPECIALS.camera.has(cell)) return makePending("camera");
    if(SPECIALS.cross.has(cell)) return makePending("cross");
    if(SPECIALS.diagnostics.has(cell)) return makePending("diagnostics");

    const q=room.questions.length?room.questions[Math.floor(Math.random()*room.questions.length)]:null;
    if(q) return makePending("question",q);

    team.currentPlayer=(team.currentPlayer+1)%4;
    emitRoom(room);
  });

  socket.on("resolve", ({code,teamId,result})=>{
    const room=findRoom(code);
    if(!room||room.finished)return;
    const caller=room.sockets.get(socket.id);
    if(!caller || caller.role!=="host")return;
    const team=room.teams.find(t=>t.id===teamId);
    if(!team||!team.pending)return;
    const p=team.pending;

    if(p.type==="skip"){
      team.skip=true;
      addLog(room,`⛔ ${team.name} получил пропуск следующего хода.`);
    } else if(p.type==="again"){
      team.again=true;
      addLog(room,`🎲 ${team.name} получает ещё один бросок.`);
    } else if(p.type==="camera"){
      addLog(room,`📷 ${team.name}: «Камера приёма запуска» — действие завершено.`);
    } else if(p.type==="cross"){
      addLog(room,`🔀 ${team.name}: «Перекрёсток» — действие завершено.`);
    } else if(p.type==="diagnostics"){
      addLog(room,`🔧 ${team.name}: «Внутритрубная диагностика» — действие завершено.`);
    } else if(p.type==="question"){
      addLog(room,`${team.name}: ${result?.correct?'✅ правильный':'❌ неправильный'} ответ.`);
    }

    team.pending=null;
    team.currentPlayer=(team.currentPlayer+1)%4;
    emitRoom(room);
  });

  socket.on("disconnect",()=>{
    for(const room of rooms.values()){
      const s=room.sockets.get(socket.id); if(!s)continue;
      if(s.role==="player"){
        const t=room.teams.find(x=>x.id===s.teamId); if(t)t.connected=Math.max(0,t.connected-1);
        addLog(room,`📴 ${s.name} отключился.`);
        room.sockets.delete(socket.id);
      } else if(s.role==="host"){
        room.sockets.delete(socket.id);
        const next=[...room.sockets.entries()].find(([,x])=>x.role==="player");
        if(next){
          const [newId,info]=next;
          info.role="host"; room.hostId=newId;
          io.to(newId).emit("promotedHost",{code:room.code,roomName:room.roomName});
          addLog(room,"👑 Администратор отключился — права переданы следующему подключённому игроку.");
        } else {
          room.hostId=null;
          addLog(room,"⚠ Администратор отключился.");
        }
      }
      emitRoom(room);
    }
  });
});

server.listen(PORT,"0.0.0.0",()=>console.log(`Газовая трасса: http://localhost:${PORT}`));
