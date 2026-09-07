const startButton=document.getElementById("startButton");
const stopButton=document.getElementById("stopButton");
const frequencyEl=document.getElementById("frequency");
const noteNameEl=document.getElementById("noteName");
const centsEl=document.getElementById("cents");
const confidenceText=document.getElementById("confidenceText");
const confidenceFill=document.getElementById("confidenceFill");
const statusEl=document.getElementById("status");
const dialTab=document.getElementById("dialTab");
const exerciseTab=document.getElementById("exerciseTab");
const dialView=document.getElementById("dialView");
const exerciseView=document.getElementById("exerciseView");
const startExerciseButton=document.getElementById("startExerciseButton");
const bpmInput=document.getElementById("bpmInput");
const intervalInputs=[...document.querySelectorAll(".intervalInput")];
const metronomeToggle=document.getElementById("metronomeToggle");
const attemptLabel=document.getElementById("attemptLabel");
const beatLabel=document.getElementById("beatLabel");
const beatLights=[...document.querySelectorAll(".beat-lights span")];
const scoreCells=[...document.querySelectorAll("#scoreGrid>div span")];
const canvas=document.getElementById("pitchCanvas");
const ctx=canvas.getContext("2d");
const traceCanvas=document.getElementById("traceCanvas");
const tctx=traceCanvas.getContext("2d");

let audioContext=null,analyser=null,mediaStream=null,source=null,timeDomainBuffer=null,animationId=null;
let lastAnalysisTime=0,stableMidi=null,stableFrequency=null,currentConfidence=0;
let pendingJumpMidi=null,pendingJumpCount=0;

const ANALYSIS_INTERVAL_MS=45;
const MIN_FREQ=75;
const MAX_FREQ=2200;
const YIN_THRESHOLD=.12;
const MIN_CONFIDENCE=.72;
const ANALYSIS_BUFFER_SIZE=4096;
const NOTE_NAMES=["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];

// Exercise state. Musical time is always derived from AudioContext.currentTime.
const EXERCISE_BEATS=4;
const COUNT_IN_BEATS=4;
const MAX_ATTEMPTS=4;
const SCORE_WINDOW_START=.20; // fraction of beat to ignore at attack
const SCORE_WINDOW_END=.82;   // fraction of beat to ignore at release
let exerciseRunning=false;
let exercisePhase="idle"; // idle | countin | attempt | gap | complete
let exerciseStartTime=0;
let attemptStartTime=0;
let gapEndTime=0;
let attemptNumber=0;
let currentTrace=[];
let traces=[];
let noteSamples=[[],[],[],[]];
let currentReferenceMidi=null;
let targetIntervals=[0,4,7,12];
let scheduledClickNodes=[];

function frequencyToMidi(f){return 69+12*Math.log2(f/440)}
function midiToFrequency(m){return 440*Math.pow(2,(m-69)/12)}
function midiToNoteName(m){const r=Math.round(m),n=NOTE_NAMES[((r%12)+12)%12],o=Math.floor(r/12)-1;return `${n}${o}`}
function centsOffNearestNote(m){return 100*(m-Math.round(m))}
function wrappedPitchClass(m){return ((m%12)+12)%12}
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function median(values){if(!values.length)return null;const a=[...values].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
function secondsPerBeat(){return 60/clamp(Number(bpmInput.value)||60,40,200)}
function readTargets(){targetIntervals=intervalInputs.map(x=>clamp(Number(x.value)||0,-24,24))}

function resizeOneCanvas(c,cx){const r=c.getBoundingClientRect(),dpr=window.devicePixelRatio||1;c.width=Math.max(1,Math.round(r.width*dpr));c.height=Math.max(1,Math.round(r.height*dpr));cx.setTransform(dpr,0,0,dpr,0,0)}
function resizeCanvases(){resizeOneCanvas(canvas,ctx);resizeOneCanvas(traceCanvas,tctx);drawPitchCircle();drawTraceGraph()}
window.addEventListener("resize",resizeCanvases);

function detectPitchYIN(buffer,sampleRate){
  let rms=0;for(let i=0;i<buffer.length;i++)rms+=buffer[i]*buffer[i];rms=Math.sqrt(rms/buffer.length);if(rms<.008)return null;
  const minTau=Math.max(2,Math.floor(sampleRate/MAX_FREQ));
  const maxTau=Math.min(Math.floor(sampleRate/MIN_FREQ),Math.floor(buffer.length/2));
  const diff=new Float64Array(maxTau+1),cmnd=new Float64Array(maxTau+1);
  for(let tau=1;tau<=maxTau;tau++){let sum=0,limit=buffer.length-tau;for(let i=0;i<limit;i++){const d=buffer[i]-buffer[i+tau];sum+=d*d}diff[tau]=sum}
  cmnd[0]=1;let running=0;for(let tau=1;tau<=maxTau;tau++){running+=diff[tau];cmnd[tau]=running>0?diff[tau]*tau/running:1}
  let tauEstimate=-1;for(let tau=minTau;tau<=maxTau;tau++){if(cmnd[tau]<YIN_THRESHOLD){while(tau+1<=maxTau&&cmnd[tau+1]<cmnd[tau])tau++;tauEstimate=tau;break}}
  if(tauEstimate<0){let bestTau=minTau,best=cmnd[minTau];for(let tau=minTau+1;tau<=maxTau;tau++){if(cmnd[tau]<best){best=cmnd[tau];bestTau=tau}}if(best>.35)return null;tauEstimate=bestTau}
  let betterTau=tauEstimate;if(tauEstimate>1&&tauEstimate<maxTau){const s0=cmnd[tauEstimate-1],s1=cmnd[tauEstimate],s2=cmnd[tauEstimate+1],den=2*(2*s1-s2-s0);if(Math.abs(den)>1e-12)betterTau=tauEstimate+(s2-s0)/den}
  const frequency=sampleRate/betterTau,confidence=clamp(1-cmnd[tauEstimate],0,1);if(frequency<MIN_FREQ||frequency>MAX_FREQ)return null;return{frequency,confidence}
}

function updateStablePitch(measuredMidi,confidence){
  if(stableMidi==null){stableMidi=measuredMidi;pendingJumpMidi=null;pendingJumpCount=0;return}
  const diffCents=Math.abs(measuredMidi-stableMidi)*100;
  if(diffCents<140){stableMidi+=.34*(measuredMidi-stableMidi);pendingJumpMidi=null;pendingJumpCount=0;return}
  if(pendingJumpMidi!=null&&Math.abs(measuredMidi-pendingJumpMidi)<.45){pendingJumpCount++;pendingJumpMidi+=.45*(measuredMidi-pendingJumpMidi)}else{pendingJumpMidi=measuredMidi;pendingJumpCount=1}
  if(pendingJumpCount>=2&&confidence>=MIN_CONFIDENCE){stableMidi=pendingJumpMidi;pendingJumpMidi=null;pendingJumpCount=0}
}

function analyzePitch(now){
  if(!analyser||!audioContext||now-lastAnalysisTime<ANALYSIS_INTERVAL_MS)return;
  lastAnalysisTime=now;analyser.getFloatTimeDomainData(timeDomainBuffer);const r=detectPitchYIN(timeDomainBuffer,audioContext.sampleRate);
  if(!r){currentConfidence*=.82;if(currentConfidence<.1)stableFrequency=null;return}
  currentConfidence=.55*currentConfidence+.45*r.confidence;
  if(r.confidence>=MIN_CONFIDENCE){updateStablePitch(frequencyToMidi(r.frequency),r.confidence);stableFrequency=midiToFrequency(stableMidi)}
  captureExerciseSample();
}

function captureExerciseSample(){
  if(!exerciseRunning||exercisePhase!=="attempt"||stableMidi==null||currentConfidence<MIN_CONFIDENCE)return;
  const beat=(audioContext.currentTime-attemptStartTime)/secondsPerBeat();
  if(beat<0||beat>=EXERCISE_BEATS)return;
  currentTrace.push({beat,midi:stableMidi,confidence:currentConfidence});
  const noteIndex=Math.floor(beat),within=beat-noteIndex;
  if(within>=SCORE_WINDOW_START&&within<=SCORE_WINDOW_END)noteSamples[noteIndex].push(stableMidi);
}

function updateReadout(){
  const p=Math.round(currentConfidence*100);confidenceText.textContent=`${p}%`;confidenceFill.style.width=`${p}%`;
  if(stableFrequency&&currentConfidence>=.28){const midi=frequencyToMidi(stableFrequency),c=centsOffNearestNote(midi);frequencyEl.textContent=stableFrequency.toFixed(1);noteNameEl.textContent=midiToNoteName(midi);centsEl.textContent=`${c>=0?"+":""}${c.toFixed(0)} cents`;if(!exerciseRunning)statusEl.textContent=currentConfidence>=MIN_CONFIDENCE?"Stable pitch":"Pitch uncertain — hold the note steadily"}
  else{frequencyEl.textContent="—";noteNameEl.textContent="—";centsEl.textContent="— cents";if(!exerciseRunning)statusEl.textContent=analyser?"Listening — sing, hum, or whistle a steady note":"Microphone is off."}
}

function drawPitchCircle(){
  const w=canvas.clientWidth,h=canvas.clientHeight,size=Math.min(w,h);ctx.clearRect(0,0,w,h);ctx.fillStyle="#181818";ctx.fillRect(0,0,w,h);
  const cx=w/2,cy=h/2,r=size*.34,nr=size*.425;ctx.strokeStyle="#444";ctx.lineWidth=Math.max(1.5,size*.004);ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.stroke();ctx.font=`600 ${Math.max(13,size*.045)}px system-ui`;ctx.textAlign="center";ctx.textBaseline="middle";
  for(let pc=0;pc<12;pc++){const a=-Math.PI/2+pc*Math.PI*2/12,x1=cx+Math.cos(a)*r*.92,y1=cy+Math.sin(a)*r*.92,x2=cx+Math.cos(a)*r*1.08,y2=cy+Math.sin(a)*r*1.08;ctx.strokeStyle="#555";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();ctx.fillStyle="#bdbdbd";ctx.fillText(NOTE_NAMES[pc],cx+Math.cos(a)*nr,cy+Math.sin(a)*nr)}
  const ir=size*.145;ctx.strokeStyle="#333";ctx.lineWidth=Math.max(5,size*.018);ctx.beginPath();ctx.arc(cx,cy,ir,0,Math.PI*2);ctx.stroke();if(currentConfidence>.01){ctx.strokeStyle="#e8e8e8";ctx.globalAlpha=.25+.75*currentConfidence;ctx.beginPath();ctx.arc(cx,cy,ir,-Math.PI/2,-Math.PI/2+Math.PI*2*currentConfidence);ctx.stroke();ctx.globalAlpha=1}
  if(stableFrequency&&currentConfidence>=.20){const midi=frequencyToMidi(stableFrequency),pc=wrappedPitchClass(midi),a=-Math.PI/2+pc*Math.PI*2/12,x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r,mr=Math.max(8,size*.028);ctx.globalAlpha=.28+.72*currentConfidence;ctx.fillStyle="#fff";ctx.beginPath();ctx.arc(x,y,mr,0,Math.PI*2);ctx.fill();ctx.fillStyle="#111";ctx.beginPath();ctx.arc(x,y,mr*.38,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;ctx.fillStyle="#f5f5f5";ctx.font=`800 ${Math.max(20,size*.075)}px system-ui`;ctx.fillText(midiToNoteName(midi),cx,cy-size*.02);ctx.fillStyle="#aaa";ctx.font=`500 ${Math.max(11,size*.035)}px system-ui`;ctx.fillText(`${Math.round(currentConfidence*100)}%`,cx,cy+size*.07)}else{ctx.fillStyle="#888";ctx.font=`600 ${Math.max(15,size*.05)}px system-ui`;ctx.fillText("listen",cx,cy)}
}

function tracePitchRange(){
  const vals=[...targetIntervals];for(const tr of traces)for(const p of tr.points)vals.push(p.relative);if(currentReferenceMidi!=null)for(const p of currentTrace)vals.push(p.midi-currentReferenceMidi);
  let lo=Math.min(-2,...vals),hi=Math.max(14,...vals);lo=Math.floor(lo/2)*2-2;hi=Math.ceil(hi/2)*2+2;if(hi-lo<12)hi=lo+12;return[lo,hi]
}
function drawTraceGraph(){
  const w=traceCanvas.clientWidth,h=traceCanvas.clientHeight;if(!w||!h)return;tctx.clearRect(0,0,w,h);tctx.fillStyle="#121212";tctx.fillRect(0,0,w,h);
  const pad={l:42,r:14,t:18,b:30},pw=w-pad.l-pad.r,ph=h-pad.t-pad.b,[yMin,yMax]=tracePitchRange();
  const x=b=>pad.l+pw*b/EXERCISE_BEATS,y=s=>pad.t+ph*(yMax-s)/(yMax-yMin);
  tctx.font="12px system-ui";tctx.textAlign="right";tctx.textBaseline="middle";
  for(let s=Math.ceil(yMin/2)*2;s<=yMax;s+=2){const yy=y(s);tctx.strokeStyle=s===0?"#555":"#2b2b2b";tctx.lineWidth=1;tctx.beginPath();tctx.moveTo(pad.l,yy);tctx.lineTo(w-pad.r,yy);tctx.stroke();tctx.fillStyle="#888";tctx.fillText(`${s>0?"+":""}${s}`,pad.l-7,yy)}
  for(let b=0;b<=EXERCISE_BEATS;b++){const xx=x(b);tctx.strokeStyle="#3a3a3a";tctx.beginPath();tctx.moveTo(xx,pad.t);tctx.lineTo(xx,h-pad.b);tctx.stroke();if(b<EXERCISE_BEATS){tctx.fillStyle="#999";tctx.textAlign="center";tctx.textBaseline="top";tctx.fillText(`${b+1}`,x(b+.5),h-pad.b+7)}}
  // target: quarter-note plateaus
  tctx.strokeStyle="#bfbfbf";tctx.lineWidth=3;tctx.setLineDash([7,6]);for(let i=0;i<4;i++){tctx.beginPath();tctx.moveTo(x(i+.08),y(targetIntervals[i]));tctx.lineTo(x(i+.92),y(targetIntervals[i]));tctx.stroke()}tctx.setLineDash([]);
  // prior attempts
  traces.forEach((tr,idx)=>{tctx.strokeStyle="#8d8d8d";tctx.globalAlpha=.16+.11*(idx+1)/Math.max(1,traces.length);tctx.lineWidth=2;drawPointTrace(tctx,tr.points,x,y)});tctx.globalAlpha=1;
  // current attempt relative to first stable scoring note when known
  if(currentTrace.length&&currentReferenceMidi!=null){const points=currentTrace.map(p=>({beat:p.beat,relative:p.midi-currentReferenceMidi}));tctx.strokeStyle="#f4f4f4";tctx.lineWidth=2.6;drawPointTrace(tctx,points,x,y)}
  // moving cursor
  if(exerciseRunning&&exercisePhase==="attempt"){const b=clamp((audioContext.currentTime-attemptStartTime)/secondsPerBeat(),0,4),xx=x(b);tctx.strokeStyle="#fff";tctx.globalAlpha=.9;tctx.lineWidth=2;tctx.beginPath();tctx.moveTo(xx,pad.t);tctx.lineTo(xx,h-pad.b);tctx.stroke();tctx.globalAlpha=1}
  tctx.fillStyle="#777";tctx.textAlign="left";tctx.textBaseline="top";tctx.fillText("relative semitones",6,3)
}
function drawPointTrace(c,points,x,y){let pen=false,lastBeat=null;c.beginPath();for(const p of points){if(lastBeat!=null&&p.beat-lastBeat>.18)pen=false;const xx=x(p.beat),yy=y(p.relative);if(!pen){c.moveTo(xx,yy);pen=true}else c.lineTo(xx,yy);lastBeat=p.beat}c.stroke()}

function scheduleClick(time,accent=false){if(!audioContext||!metronomeToggle.checked)return;const osc=audioContext.createOscillator(),gain=audioContext.createGain();osc.frequency.value=accent?1250:900;gain.gain.setValueAtTime(.0001,time);gain.gain.exponentialRampToValueAtTime(accent?.11:.07,time+.005);gain.gain.exponentialRampToValueAtTime(.0001,time+.055);osc.connect(gain).connect(audioContext.destination);osc.start(time);osc.stop(time+.07);scheduledClickNodes.push(osc)}
function scheduleAttemptClicks(countInStart){const spb=secondsPerBeat();for(let i=0;i<COUNT_IN_BEATS+EXERCISE_BEATS;i++)scheduleClick(countInStart+i*spb,i===COUNT_IN_BEATS)}
function clearScheduledClicks(){for(const n of scheduledClickNodes){try{n.stop()}catch{}}scheduledClickNodes=[]}

function resetAttemptCapture(){currentTrace=[];noteSamples=[[],[],[],[]];currentReferenceMidi=null;scoreCells[0].textContent="reference";for(let i=1;i<4;i++)scoreCells[i].textContent="—"}
function startExercise(){
  if(!audioContext||exerciseRunning)return;readTargets();bpmInput.value=clamp(Number(bpmInput.value)||60,40,200);traces=[];attemptNumber=1;exerciseRunning=true;exercisePhase="countin";resetAttemptCapture();const lead=.12;exerciseStartTime=audioContext.currentTime+lead;attemptStartTime=exerciseStartTime+COUNT_IN_BEATS*secondsPerBeat();scheduleAttemptClicks(exerciseStartTime);startExerciseButton.disabled=true;attemptLabel.textContent="Attempt 1 of 4";statusEl.textContent="Count in…";drawTraceGraph()
}
function beginNextAttempt(){attemptNumber++;resetAttemptCapture();exercisePhase="countin";const start=audioContext.currentTime+.12;exerciseStartTime=start;attemptStartTime=start+COUNT_IN_BEATS*secondsPerBeat();scheduleAttemptClicks(start);attemptLabel.textContent=`Attempt ${attemptNumber} of ${MAX_ATTEMPTS}`;statusEl.textContent="Count in…"}
function finalizeAttempt(){
  const medians=noteSamples.map(median);if(medians[0]!=null)currentReferenceMidi=medians[0];
  const points=[];if(currentReferenceMidi!=null){for(const p of currentTrace)points.push({beat:p.beat,relative:p.midi-currentReferenceMidi});traces.push({points,referenceMidi:currentReferenceMidi,medians});scoreCells[0].textContent="reference";for(let i=1;i<4;i++){if(medians[i]==null){scoreCells[i].textContent="no pitch";continue}const observed=medians[i]-currentReferenceMidi,errorCents=Math.round((observed-targetIntervals[i])*100);scoreCells[i].textContent=`${errorCents>=0?"+":""}${errorCents}¢`}}
  else{for(let i=0;i<4;i++)scoreCells[i].textContent="no pitch"}
  currentTrace=[];currentReferenceMidi=null;exercisePhase="gap";gapEndTime=audioContext.currentTime+Math.max(.65,secondsPerBeat());statusEl.textContent=attemptNumber<MAX_ATTEMPTS?"Attempt complete — next count-in shortly":"Final attempt complete";drawTraceGraph()
}
function finishExercise(){exerciseRunning=false;exercisePhase="complete";startExerciseButton.disabled=!audioContext;attemptLabel.textContent="4 attempts complete";beatLabel.textContent="Done";beatLights.forEach(x=>x.classList.remove("active"));statusEl.textContent="Exercise complete. Review the four overlaid attempts.";drawTraceGraph()}
function cancelExercise(){exerciseRunning=false;exercisePhase="idle";clearScheduledClicks();currentTrace=[];currentReferenceMidi=null;attemptNumber=0;attemptLabel.textContent="Ready";beatLabel.textContent="—";beatLights.forEach(x=>x.classList.remove("active"));startExerciseButton.disabled=!audioContext;drawTraceGraph()}

function updateExerciseClock(){
  if(!exerciseRunning||!audioContext)return;const now=audioContext.currentTime,spb=secondsPerBeat();let active=-1;
  if(exercisePhase==="countin"){
    const pos=(now-exerciseStartTime)/spb;if(pos<0){beatLabel.textContent="Get ready"}else if(pos<COUNT_IN_BEATS){active=Math.floor(pos);beatLabel.textContent=`Count ${active+1}`;statusEl.textContent="Count in…"}else{exercisePhase="attempt";stableMidi=null;stableFrequency=null;pendingJumpMidi=null;pendingJumpCount=0;beatLabel.textContent="Beat 1";statusEl.textContent="Play the four-note phrase"}
  }
  if(exercisePhase==="attempt"){
    const beat=(now-attemptStartTime)/spb;if(noteSamples[0].length&&currentReferenceMidi==null)currentReferenceMidi=median(noteSamples[0]);if(beat>=EXERCISE_BEATS){finalizeAttempt()}else if(beat>=0){active=Math.floor(beat);beatLabel.textContent=`Beat ${active+1}`}
  }
  if(exercisePhase==="gap"&&now>=gapEndTime){if(attemptNumber>=MAX_ATTEMPTS)finishExercise();else beginNextAttempt()}
  beatLights.forEach((el,i)=>el.classList.toggle("active",i===active));drawTraceGraph()
}

function loop(now){analyzePitch(now);updateReadout();drawPitchCircle();updateExerciseClock();animationId=requestAnimationFrame(loop)}

async function startMicrophone(){
  try{statusEl.textContent="Requesting microphone access…";mediaStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});audioContext=new(window.AudioContext||window.webkitAudioContext)();await audioContext.resume();source=audioContext.createMediaStreamSource(mediaStream);analyser=audioContext.createAnalyser();analyser.fftSize=ANALYSIS_BUFFER_SIZE;analyser.smoothingTimeConstant=0;timeDomainBuffer=new Float32Array(analyser.fftSize);source.connect(analyser);stableMidi=null;stableFrequency=null;currentConfidence=0;pendingJumpMidi=null;pendingJumpCount=0;lastAnalysisTime=0;startButton.disabled=true;stopButton.disabled=false;startExerciseButton.disabled=false;statusEl.textContent="Listening — sing, hum, or whistle a steady note";animationId=requestAnimationFrame(loop)}catch(e){console.error(e);statusEl.textContent="Could not use microphone. Check browser permission and HTTPS."}
}
function stopMicrophone(){cancelExercise();if(animationId){cancelAnimationFrame(animationId);animationId=null}if(mediaStream)for(const track of mediaStream.getTracks())track.stop();if(audioContext)audioContext.close();mediaStream=null;audioContext=null;analyser=null;source=null;timeDomainBuffer=null;stableMidi=null;stableFrequency=null;currentConfidence=0;pendingJumpMidi=null;pendingJumpCount=0;frequencyEl.textContent="—";noteNameEl.textContent="—";centsEl.textContent="— cents";confidenceText.textContent="—";confidenceFill.style.width="0%";statusEl.textContent="Microphone is off.";startButton.disabled=false;stopButton.disabled=true;startExerciseButton.disabled=true;drawPitchCircle()}
function setView(mode){const exercise=mode==="exercise";dialView.classList.toggle("hidden",exercise);exerciseView.classList.toggle("hidden",!exercise);dialTab.classList.toggle("active",!exercise);exerciseTab.classList.toggle("active",exercise);requestAnimationFrame(resizeCanvases)}

startButton.addEventListener("click",startMicrophone);stopButton.addEventListener("click",stopMicrophone);startExerciseButton.addEventListener("click",startExercise);dialTab.addEventListener("click",()=>setView("dial"));exerciseTab.addEventListener("click",()=>setView("exercise"));bpmInput.addEventListener("change",()=>{bpmInput.value=clamp(Number(bpmInput.value)||60,40,200)});intervalInputs.forEach(x=>x.addEventListener("change",()=>{readTargets();drawTraceGraph()}));
readTargets();resizeCanvases();drawPitchCircle();drawTraceGraph();
