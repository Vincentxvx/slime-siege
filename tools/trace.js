const GD=require('../shared/data');const {Match}=require('../server/game/match');
const [dA='hard', dB='easy'] = process.argv.slice(2);
const P=(d)=> d==='none'?{name:'x',unlocked:GD.TOWER_ORDER}:{name:d,isBot:true,difficulty:d,unlocked:GD.TOWER_ORDER};
const m=new Match({mode:'t',players:[P(dA),P(dB)],mapId:'meadow',onEnd:r=>console.log('END',r)});
let lr=0;
while(m.state!=='ended' && m.round<60){m.tick(); if(m.round!==lr){lr=m.round; console.log('R'+m.round, m.boards.map((b,i)=>m.bots[i]?`L${b.lives} g${b.gold} inc${b.income} P${m.bots[i].power().toFixed(0)}/N${m.bots[i].need(m.round).toFixed(0)} ${b.towers.map(t=>t.type.slice(0,2)+t.level).join(',')} sent${b.stats.sentGold}`:`L${b.lives}`).join('  |  '));}}
