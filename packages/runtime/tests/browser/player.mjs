/** Measures the actual production canvas via draw calls against the time being heard: the audio element clock less the output latency the page's AudioContext reports, at the audio rate. */
// An injected output latency about that of Bluetooth headphones (the macOS app saw 203 ms on WH-1000XM4), and one the browser does not report.
const INJECTED={baseLatency:.01,outputLatency:.19},UNREPORTED={baseLatency:undefined,outputLatency:undefined};
export async function playerChecks(page,out){
 const result={};
 await page.locator('#result').scrollIntoViewIfNeeded();await page.bringToFront();
 // Volume, before the first play: the audio element starts at the slider's initial value, follows the slider down by key and pointer, and stays at most 1 when pushed past the top.
 const volume=()=>page.evaluate(()=>{const v=document.querySelector('#volume'),a=document.querySelector('#audio');return{value:Number(v.value),initial:Number(v.defaultValue),max:Number(v.max),audio:a.volume,shown:document.querySelector('#volume-value').textContent,valueText:v.getAttribute('aria-valuetext'),played:a.played.length};});
 const slider=page.locator('#volume'),initial=await volume();
 await slider.focus();await page.keyboard.press('ArrowLeft');const key=await volume();
 const box=await slider.boundingBox();await page.mouse.click(box.x+box.width*initial.initial/initial.max/2,box.y+box.height/2);const pointer=await volume();
 await slider.focus();await page.keyboard.press('End');for(let i=0;i<3;i++)await page.keyboard.press('ArrowRight');const top=await volume();
 await slider.fill(String(initial.initial));
 const steps={initial,key,pointer,top};
 result.volume={...steps,pass:initial.played===0&&initial.value===initial.initial&&key.value<initial.value&&pointer.value<initial.value&&top.value===top.max&&Object.values(steps).every(s=>s.audio===s.value/100&&s.audio<=1&&parseInt(s.shown)===s.value&&s.valueText===s.shown)};
 await page.evaluate(()=>{
  const audio=document.querySelector('#audio'),canvas=document.querySelector('#lanes');window.__player={samples:[],capture:false,firstDraw:null,contexts:[],sources:0,edges:[],latency:null};
  // The page's audio graph, and the latency it reads: __player.latency, when set, is what both getters return.
  const Native=AudioContext;window.AudioContext=class extends Native{constructor(...a){super(...a);__player.contexts.push(this);}createMediaElementSource(e){__player.sources++;return super.createMediaElementSource(e);}};
  const connect=AudioNode.prototype.connect;AudioNode.prototype.connect=function(to,...r){__player.edges.push([this,to]);return connect.call(this,to,...r);};
  for(const key of ['baseLatency','outputLatency']){const get=Object.getOwnPropertyDescriptor(Native.prototype,key)?.get;Object.defineProperty(Native.prototype,key,{configurable:true,get(){return __player.latency?__player.latency[key]:get?.call(this);}});}
  const rr=CanvasRenderingContext2D.prototype.roundRect;
  CanvasRenderingContext2D.prototype.roundRect=function(x,y,w,h,...r){if(this.canvas===canvas&&h===14&&this.fillStyle==='#eaa0b7'&&!__player.firstDraw)__player.firstDraw={x,y};return rr.call(this,x,y,w,h,...r);};
  const raf=window.requestAnimationFrame;window.requestAnimationFrame=callback=>raf(time=>{
   __player.firstDraw=null;const start=performance.now();callback(time);
   if(__player.capture&&__player.firstDraw){
    const c=__player.contexts[0],base=c?.baseLatency,output=c?.outputLatency,ms=audio.currentTime*1000,paused=audio.paused,rate=audio.playbackRate,heard=paused||!c?ms:ms-((base??0)+(output??0))*1000*rate;
    const chart=__test.results.at(-1).chart,draw=__player.firstDraw,judge=canvas.clientHeight*.82,laneW=Math.min(80,(canvas.clientWidth-32)/4),x0=(canvas.clientWidth-4*laneW)/2,lane=Math.round((draw.x-x0-4)/laneW);
    const speed=Number(document.querySelector('#speeds [aria-pressed="true"]').textContent),offset=(draw.y+7-judge)/(speed/1000);
    // The drawn time is that of the lane's tap closest to the clock text (shown to 1 ms); the other taps are a note spacing away.
    const clock=document.querySelector('#clock').textContent,[m,s]=clock.split(' / ')[0].split(':'),clockMs=(Number(m)*60+Number(s))*1000;
    let drawn=null;for(const o of chart.objects){if(o.lane!==lane||o.end_ms!==undefined)continue;const t=o.start_ms+offset;if(drawn===null||Math.abs(t-clockMs)<Math.abs(drawn-clockMs))drawn=t;}
    __player.samples.push({frame:time,cpuMs:performance.now()-start,audio:ms,paused,rate,base,output,heard,drawn,drift:drawn-heard,clock,clockMs});
   }
  });
 });
 function summary(samples){const pct=(v,q)=>{v=[...v].sort((a,b)=>a-b);return v[Math.min(v.length-1,Math.floor(v.length*q))]};const intervals=samples.slice(1).map((s,i)=>s.frame-samples[i].frame),drifts=samples.map(s=>Math.abs(s.drift)),range=key=>{const v=samples.map(s=>s[key]).filter(x=>x!==undefined);return v.length?[Math.min(...v),Math.max(...v)]:null;};return{samples:samples.length,wallSeconds:(samples.at(-1).frame-samples[0].frame)/1000,fps:1000*(samples.length-1)/(samples.at(-1).frame-samples[0].frame),intervalMedian:pct(intervals,.5),intervalP95:pct(intervals,.95),intervalMax:Math.max(...intervals),drawTimeMedian:pct(samples.map(s=>s.cpuMs),.5),drawTimeP95:pct(samples.map(s=>s.cpuMs),.95),maxDriftMs:Math.max(...drifts),medianDriftMs:pct(drifts,.5),overOneMedianFrame:drifts.filter(x=>x>pct(intervals,.5)).length,maxClockErrorMs:Math.max(...samples.map(s=>Math.abs(s.drawn-s.clockMs))),baseLatency:range('base'),outputLatency:range('output'),first:samples[0],last:samples.at(-1)};}
 // Routing, at the first play: one AudioContext, the element through one MediaElementAudioSourceNode and a GainNode to its destination. The gain is the slider's value over 100,
 // set below the default before the play and moved by key and past the top while playing, at most 1; the element's volume stays 1.
 const graph=()=>page.evaluate(()=>{const p=__player,c=p.contexts[0],a=document.querySelector('#audio'),v=document.querySelector('#volume'),gain=p.edges[0]?.[1];return{contexts:p.contexts.length,sources:p.sources,state:c?.state,edges:p.edges.map(e=>e.map(n=>n.constructor.name)),fromElement:p.edges[0]?.[0].mediaElement===a,toDestination:p.edges[1]?.[1]===c?.destination,value:Number(v.value),max:Number(v.max),gain:gain?.gain.value,audio:a.volume,playing:!a.paused};});
 const ROUTE=JSON.stringify([['MediaElementAudioSourceNode','GainNode'],['GainNode','AudioDestinationNode']]),routed=g=>g.contexts===1&&g.sources===1&&JSON.stringify(g.edges)===ROUTE&&g.fromElement&&g.toDestination&&g.audio===1&&g.gain===Math.fround(g.value/100)&&g.gain<=1;
 await slider.focus();await page.keyboard.press('ArrowLeft');await page.locator('#play').click();await page.waitForTimeout(300);const first=await graph();
 await slider.focus();await page.keyboard.press('ArrowLeft');const lower=await graph();await page.keyboard.press('End');for(let i=0;i<3;i++)await page.keyboard.press('ArrowRight');const highest=await graph();
 await slider.fill(String(initial.initial));await page.evaluate(()=>document.querySelector('#audio').pause());
 result.routing={first,lower,highest,pass:first.state==='running'&&first.playing&&first.value<initial.initial&&lower.value<first.value&&highest.value===highest.max&&[first,lower,highest].every(routed)};
 result.playback={};
 for(const [rate,duration] of [[1,60],[.5,60],[1.5,60]]){
  await page.locator('#rates button').getByText(`${rate}×`,{exact:true}).click();
  await page.evaluate(()=>{const a=document.querySelector('#audio');a.pause();a.currentTime=30;__player.capture=false;__player.samples=[];});
  await page.waitForTimeout(250);await page.locator('#play').click();await page.waitForTimeout(300);
  await page.evaluate(()=>{__player.samples=[];__player.capture=true;});
  await page.waitForTimeout(duration*1000);
  const samples=await page.evaluate(()=>{__player.capture=false;document.querySelector('#audio').pause();return __player.samples;});
  result.playback[rate]=summary(samples);
  const {writeFile}=await import('node:fs/promises');await writeFile(`${out}/bulk/player-${rate}-frames.json`,JSON.stringify(samples));
 }
 // Latency the page reads, injected or not reported: from 30 s, play 1 s, seek to mid-song on the overview, play 1 s. While playing, the drawing must be at max(start, audio clock
 // less latency x rate), where start is 30 s before the seek and its target after it, within one frame; it must hold at each start, and never step back.
 const ov=await page.locator('#overview').boundingBox(),duration=await page.evaluate(()=>__test.results.at(-1).chart.duration_ms);
 result.latency={injected:INJECTED,runs:{}};
 for(const [name,latency] of [['injected',INJECTED],['unreported',UNREPORTED]])for(const rate of [1,.5,1.5]){
  await page.locator('#rates button').getByText(`${rate}×`,{exact:true}).click();
  await page.evaluate(l=>{const a=document.querySelector('#audio');a.pause();a.currentTime=30;__player.latency=l;__player.samples=[];__player.capture=true;},latency);
  await page.waitForTimeout(250);await page.locator('#play').click();await page.waitForTimeout(1000);await page.mouse.click(ov.x+ov.width*.5,ov.y+ov.height*.5);await page.waitForTimeout(1000);
  const samples=await page.evaluate(()=>{__player.capture=false;document.querySelector('#audio').pause();return __player.samples;});
  const lag=((latency.baseLatency??0)+(latency.outputLatency??0))*1000*rate,frame=summary(samples).intervalMedian*rate,playing=samples.filter(s=>!s.paused),seek=duration*.5;
  // The overview puts the seek within 0.001 ms of mid-song (the overview check below); before it the clock is near 30 s, after it near mid-song.
  const runs=[playing.filter(s=>s.audio<seek/2),playing.filter(s=>s.audio>=seek/2)].map((part,i)=>{const start=i?seek:30000,errors=part.map(s=>s.drawn-Math.max(start,s.audio-lag));
   return{start,samples:part.length,held:part.filter(s=>Math.abs(s.drawn-start)<.01).length,trailing:part.filter(s=>s.audio-lag>start).map(s=>s.audio-s.drawn).reduce((r,x)=>[Math.min(r[0],x),Math.max(r[1],x)],[Infinity,-Infinity]),maxErrorMs:Math.max(...errors.map(Math.abs))};});
  const run=result.latency.runs[`${name}-${rate}`]={lagMs:lag,frameMs:frame,read:[samples.at(-1).base,samples.at(-1).output],pausedEqual:samples.filter(s=>s.paused).every(s=>Math.abs(s.drawn-s.audio)<1e-3),backward:samples.filter((s,i)=>i&&s.drawn<samples[i-1].drawn-1e-6).length,maxClockErrorMs:Math.max(...samples.map(s=>Math.abs(s.drawn-s.clockMs))),runs};
  run.pass=run.pausedEqual&&!run.backward&&run.maxClockErrorMs<=.5+1e-6&&runs.every(r=>r.samples&&r.maxErrorMs<=frame&&(lag?r.held>0:true));
  const {writeFile}=await import('node:fs/promises');await writeFile(`${out}/bulk/player-${name}-${rate}-frames.json`,JSON.stringify(samples));
 }
 await page.evaluate(()=>{__player.latency=null;});
 result.latency.pass=Object.values(result.latency.runs).every(r=>r.pass);
 await page.locator('#rates button').getByText('1×',{exact:true}).click();
 const current=()=>page.evaluate(()=>document.querySelector('#audio').currentTime*1000);
 const reset=async()=>{await page.evaluate(()=>{const a=document.querySelector('#audio');a.pause();a.currentTime=60;});await page.waitForTimeout(100);};
 const check=async(name,expected,fn)=>{await reset();await fn();await page.waitForTimeout(120);const actual=await current();result[name]={expectedMs:expected,actualMs:actual,errorMs:actual-expected,clock:await page.locator('#clock').textContent()};};
 // Expected times follow the visual speed selected on the page.
 const speed=await page.evaluate(()=>Number(document.querySelector('#speeds [aria-pressed="true"]').textContent));
 const rect=await page.locator('#lanes').boundingBox();
 await check('right',65000,async()=>{await page.locator('#lanes').focus();await page.keyboard.press('ArrowRight');});
 await check('left',55000,async()=>{await page.locator('#lanes').focus();await page.keyboard.press('ArrowLeft');});
 await check('up',60000+40/speed*1000,async()=>{await page.locator('#lanes').focus();await page.keyboard.press('ArrowUp');});
 await check('down',60000-40/speed*1000,async()=>{await page.locator('#lanes').focus();await page.keyboard.press('ArrowDown');});
 await check('click',60000+240/speed*1000,async()=>page.mouse.click(rect.x+100,rect.y+rect.height*.82-240));
 await check('drag',60000+120/speed*1000,async()=>{await page.mouse.move(rect.x+100,rect.y+300);await page.mouse.down();await page.mouse.move(rect.x+100,rect.y+180,{steps:10});await page.mouse.up();});
 await page.evaluate(()=>{window.__wheelEvents=[];document.querySelector('#lanes').addEventListener('wheel',e=>__wheelEvents.push({deltaY:e.deltaY,deltaMode:e.deltaMode}),{capture:true});});
 await check('wheel',60000-120/speed*1000,async()=>{await page.mouse.move(rect.x+100,rect.y+300);await page.mouse.wheel(0,120);});
 result.wheel.events=await page.evaluate(()=>window.__wheelEvents);result.wheel.expectedFromDeliveredEventsMs=60000-result.wheel.events.reduce((a,e)=>a+e.deltaY,0)/speed*1000;result.wheel.errorFromDeliveredEventsMs=result.wheel.actualMs-result.wheel.expectedFromDeliveredEventsMs;
 await check('overview',duration*.5,async()=>page.mouse.click(ov.x+ov.width*.5,ov.y+ov.height*.5));
 await check('restart',0,async()=>page.locator('#restart').click());
 await page.locator('#lanes').focus();await page.keyboard.press('Space');await page.waitForTimeout(250);result.spacePlays=await page.evaluate(()=>!document.querySelector('#audio').paused);await page.keyboard.press('Space');result.spacePauses=await page.evaluate(()=>document.querySelector('#audio').paused);
 await page.locator('#result').screenshot({path:`${out}/screenshots/player-adventure.png`});
 // createMediaElementSource once, after every play above.
 result.routing.final=await graph();result.routing.pass&&=routed(result.routing.final);
 result.pass=result.volume.pass&&result.routing.pass&&result.latency.pass;
 return result;
}
