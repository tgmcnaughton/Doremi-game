const $=id=>document.getElementById(id);
const startButton=$("startButton"),stopButton=$("stopButton"),frequencyEl=$("frequency"),noteNameEl=$("noteName"),centsEl=$("cents"),confidenceText=$("confidenceText"),confidenceFill=$("confidenceFill"),statusEl=$("status");
const dialTab=$("dialTab"),labTab=$("labTab"),dialView=$("dialView"),labView=$("labView"),startExerciseButton=$("startExerciseButton"),bpmInput=$("bpmInput"),phraseSelect=$("phraseSelect"),difficultySelect=$("difficultySelect"),metronomeToggle=$("metronomeToggle"),targetAudioToggle=$("targetAudioToggle"),attemptLabel=$("attemptLabel"),beatLabel=$("beatLabel"),pitchScoreEl=$("pitchScore"),timingScoreEl=$("timingScore"),coverageScoreEl=$("coverageScore"),diagnosticBody=$("diagnosticBody"),fairnessPanel=$("fairnessPanel"),feedbackStatus=$("feedbackStatus"),exportButton=$("exportButton"),pitchGuide=$("pitchGuide"),pitchGuideText=$("pitchGuideText"),pitchGuideCents=$("pitchGuideCents");
const beatLights=[...document.querySelectorAll(".beat-lights span")],fairnessButtons=[...document.querySelectorAll("[data-fairness]")];
const canvas=$("pitchCanvas"),ctx=canvas.getContext("2d"),traceCanvas=$("traceCanvas"),tctx=traceCanvas.getContext("2d");

const NOTE_NAMES=["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
const PHRASES={step:{name:"Step up",intervals:[0,2,4,5]},triad:{name:"Major triad",intervals:[0,4,7,12]},leap:{name:"Leap test",intervals:[0,7,2,9]},repeat:{name:"Repeated pitch",intervals:[0,0,0,0]}};
const POLICIES={
 relaxed:{pitchExcellent:40,pitchAcceptable:100,timingExcellent:120,timingAcceptable:260,guideGreen:40},
 standard:{pitchExcellent:20,pitchAcceptable:50,timingExcellent:70,timingAcceptable:170,guideGreen:25},
 precise:{pitchExcellent:10,pitchAcceptable:25,timingExcellent:45,timingAcceptable:100,guideGreen:15},
 virtuoso:{pitchExcellent:5,pitchAcceptable:12,timingExcellent:25,timingAcceptable:60,guideGreen:10}
};
const EXERCISE_BEATS=4,COUNT_IN_BEATS=4,ANALYSIS_INTERVAL_MS=35,MIN_FREQ=75,MAX_FREQ=2200,YIN_THRESHOLD=.12,MIN_CONFIDENCE=.70,ANALYSIS_BUFFER_SIZE=4096;
const TRANSITION_BEATS=.24,TAIL_START=.46,TAIL_END=.90,TAIL_MIN_FRAMES=4,TAIL_MAX_SPREAD_CENTS=45,TAIL_MAX_SD_CENTS=32;
let audioContext=null,analyser=null,mediaStream=null,source=null,timeDomainBuffer=null,animationId=null,lastAnalysisTime=0;
let stableMidi=null,stableFrequency=null,currentConfidence=0,pendingJumpMidi=null,pendingJumpCount=0,lowPassMidi=null;
let liveReferenceMidi=null,guideState="muted",guideHold=0;
let exerciseRunning=false,exercisePhase="idle",countInStart=0,attemptStartTime=0,currentTrace=[],lastResult=null,scheduledNodes=[];

function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function median(values){if(!values.length)return null;const a=[...values].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
function mean(values){return values.length?values.reduce((a,b)=>a+b,0)/values.length:null}
function stddev(values){if(values.length<2)return 0;const m=mean(values);return Math.sqrt(mean(values.map(x=>(x-m)*(x-m))))}
function frequencyToMidi(f){return 69+12*Math.log2(f/440)}
function midiToFrequency(m){return 440*Math.pow(2,(m-69)/12)}
function midiToNoteName(m){const r=Math.round(m);return `${NOTE_NAMES[((r%12)+12)%12]}${Math.floor(r/12)-1}`}
function centsOffNearestNote(m){return 100*(m-Math.round(m))}
function wrappedPitchClass(m){return ((m%12)+12)%12}
function secondsPerBeat(){return 60/clamp(Number(bpmInput.value)||72,40,160)}
function phrase(){return PHRASES[phraseSelect.value]||PHRASES.step}
function policy(){return POLICIES[difficultySelect.value]||POLICIES.standard}
function scoreFromError(error,excellent,acceptable){const e=Math.abs(error);if(e<=excellent)return 100;if(e>=acceptable)return 0;return Math.round(100*(acceptable-e)/(acceptable-excellent))}
function octaveFoldSemitones(x,target){let best=x,bestErr=Math.abs(x-target);for(let k=-3;k<=3;k++){const c=x+12*k,e=Math.abs(c-target);if(e<bestErr){best=c;bestErr=e}}return best}
function beatPosition(){return !audioContext?null:(audioContext.currentTime-attemptStartTime)/secondsPerBeat()}
function updateLowPass(rawMidi){
 const beat=beatPosition(),phase=beat==null?1:beat-Math.floor(beat);
 const inTransition=exerciseRunning&&exercisePhase==="attempt"&&phase<TRANSITION_BEATS;
 const alpha=inTransition?.13:.34;
 if(lowPassMidi==null||Math.abs(rawMidi-lowPassMidi)>4)lowPassMidi=rawMidi;
 else lowPassMidi+=alpha*(rawMidi-lowPassMidi);
 return lowPassMidi;
}
function setGuide(state,text,cents=null){
 guideState=state;
 if(!pitchGuide)return;
 pitchGuide.dataset.state=state;
 pitchGuideText.textContent=text;
 pitchGuideCents.textContent=cents==null?"":`${cents>=0?"+":""}${Math.round(cents)}¢`;
}
function updatePitchGuide(measurement){
 if(!exerciseRunning||exercisePhase!=="attempt"){setGuide("muted","Pitch guide");return}
 const beat=beatPosition();if(beat==null||beat<0||beat>=4){setGuide("muted","Pitch guide");return}
 const note=Math.floor(beat),phase=beat-note;
 if(phase<TRANSITION_BEATS){setGuide("muted","settling…");guideHold=0;return}
 if(!measurement||measurement.confidence<MIN_CONFIDENCE||measurement.filteredMidi==null){setGuide("muted","listening…");guideHold=0;return}
 if(liveReferenceMidi==null){setGuide("muted","establishing reference…");return}
 const targetRel=phrase().intervals[note],rel=measurement.filteredMidi-liveReferenceMidi;
 const folded=octaveFoldSemitones(rel,targetRel),error=(folded-targetRel)*100,green=policy().guideGreen;
 const wanted=Math.abs(error)<=green?"good":error<0?"low":"high";
 if(wanted!==guideState){guideHold++;if(guideHold<2)return}else guideHold=0;
 guideHold=0;setGuide(wanted,wanted==="good"?"ON TARGET":wanted==="low"?"RAISE PITCH":"LOWER PITCH",error);
}
function selectStableTail(frames,valueFn){
 const usable=frames.filter(p=>p.rawMidi!=null&&p.confidence>=MIN_CONFIDENCE).sort((a,b)=>a.beat-b.beat);
 if(usable.length<TAIL_MIN_FRAMES)return[];
 let selected=[];
 for(let j=usable.length-1;j>=0;j--){
   const p=usable[j],v=valueFn(p);if(v==null)continue;
   if(!selected.length){selected.unshift({p,v});continue}
   const vals=selected.map(x=>x.v),center=median(vals),candidate=[v,...vals];
   const spread=Math.abs(v-center)*100,sd=stddev(candidate)*100;
   if(spread<=TAIL_MAX_SPREAD_CENTS&&sd<=TAIL_MAX_SD_CENTS)selected.unshift({p,v});
   else if(selected.length>=TAIL_MIN_FRAMES)break;
 }
 return selected.length>=TAIL_MIN_FRAMES?selected:[];
}
function noteTailFrames(trace,i){return trace.filter(p=>p.beat>=i+TAIL_START&&p.beat<=i+TAIL_END)}


function resizeOneCanvas(c,cx){const r=c.getBoundingClientRect(),dpr=window.devicePixelRatio||1;c.width=Math.max(1,Math.round(r.width*dpr));c.height=Math.max(1,Math.round(r.height*dpr));cx.setTransform(dpr,0,0,dpr,0,0)}
function resizeCanvases(){resizeOneCanvas(canvas,ctx);resizeOneCanvas(traceCanvas,tctx);drawPitchCircle();drawTraceGraph()}
window.addEventListener("resize",resizeCanvases);

function detectPitchYIN(buffer,sampleRate){
 let rms=0;for(let i=0;i<buffer.length;i++)rms+=buffer[i]*buffer[i];rms=Math.sqrt(rms/buffer.length);if(rms<.008)return null;
 const minTau=Math.max(2,Math.floor(sampleRate/MAX_FREQ)),maxTau=Math.min(Math.floor(sampleRate/MIN_FREQ),Math.floor(buffer.length/2));
 const diff=new Float64Array(maxTau+1),cmnd=new Float64Array(maxTau+1);
 for(let tau=1;tau<=maxTau;tau++){let sum=0;for(let i=0;i<buffer.length-tau;i++){const d=buffer[i]-buffer[i+tau];sum+=d*d}diff[tau]=sum}
 cmnd[0]=1;let running=0;for(let tau=1;tau<=maxTau;tau++){running+=diff[tau];cmnd[tau]=running?diff[tau]*tau/running:1}
 let tauEstimate=-1;for(let tau=minTau;tau<=maxTau;tau++){if(cmnd[tau]<YIN_THRESHOLD){while(tau+1<=maxTau&&cmnd[tau+1]<cmnd[tau])tau++;tauEstimate=tau;break}}
 if(tauEstimate<0){let bestTau=minTau,best=cmnd[minTau];for(let tau=minTau+1;tau<=maxTau;tau++)if(cmnd[tau]<best){best=cmnd[tau];bestTau=tau}if(best>.35)return null;tauEstimate=bestTau}
 let betterTau=tauEstimate;if(tauEstimate>1&&tauEstimate<maxTau){const s0=cmnd[tauEstimate-1],s1=cmnd[tauEstimate],s2=cmnd[tauEstimate+1],den=2*(2*s1-s2-s0);if(Math.abs(den)>1e-12)betterTau=tauEstimate+(s2-s0)/den}
 const frequency=sampleRate/betterTau,confidence=clamp(1-cmnd[tauEstimate],0,1);if(frequency<MIN_FREQ||frequency>MAX_FREQ)return null;return{frequency,confidence,rms}
}

function updateStablePitch(measuredMidi,confidence){
 if(stableMidi==null){stableMidi=measuredMidi;pendingJumpMidi=null;pendingJumpCount=0;return}
 const diffCents=Math.abs(measuredMidi-stableMidi)*100;
 if(diffCents<140){stableMidi+=.32*(measuredMidi-stableMidi);pendingJumpMidi=null;pendingJumpCount=0;return}
 if(pendingJumpMidi!=null&&Math.abs(measuredMidi-pendingJumpMidi)<.45){pendingJumpCount++;pendingJumpMidi+=.45*(measuredMidi-pendingJumpMidi)}else{pendingJumpMidi=measuredMidi;pendingJumpCount=1}
 if(pendingJumpCount>=2&&confidence>=MIN_CONFIDENCE){stableMidi=pendingJumpMidi;pendingJumpMidi=null;pendingJumpCount=0}
}

function analyzePitch(now){
 if(!analyser||!audioContext||now-lastAnalysisTime<ANALYSIS_INTERVAL_MS)return;
 lastAnalysisTime=now;analyser.getFloatTimeDomainData(timeDomainBuffer);
 const r=detectPitchYIN(timeDomainBuffer,audioContext.sampleRate);
 if(!r){currentConfidence*=.82;if(currentConfidence<.1)stableFrequency=null;captureSample(null);updatePitchGuide(null);return}
 const rawMidi=frequencyToMidi(r.frequency),filteredMidi=updateLowPass(rawMidi);
 currentConfidence=.55*currentConfidence+.45*r.confidence;
 if(r.confidence>=MIN_CONFIDENCE){updateStablePitch(filteredMidi,r.confidence);stableFrequency=midiToFrequency(stableMidi)}
 const measurement={rawMidi,filteredMidi,stableMidi,confidence:r.confidence,rms:r.rms};
 captureSample(measurement);updatePitchGuide(measurement);
}
function captureSample(measurement){
 if(!exerciseRunning||exercisePhase!=="attempt"||!audioContext)return;
 const beat=beatPosition();if(beat<0||beat>=EXERCISE_BEATS)return;
 if(measurement&&measurement.confidence>=MIN_CONFIDENCE)currentTrace.push({beat,...measurement});
 else currentTrace.push({beat,rawMidi:null,filteredMidi:null,stableMidi:null,confidence:measurement?.confidence||0,rms:measurement?.rms||0});
 if(liveReferenceMidi==null&&beat>=TAIL_START&&beat<=TAIL_END){
   const refs=currentTrace.filter(p=>p.beat>=TAIL_START&&p.beat<=beat&&p.rawMidi!=null&&p.confidence>=MIN_CONFIDENCE).map(p=>p.rawMidi);
   if(refs.length>=TAIL_MIN_FRAMES&&stddev(refs.slice(-6))*100<TAIL_MAX_SD_CENTS)liveReferenceMidi=median(refs.slice(-6));
 }
}

function updateReadout(){const p=Math.round(currentConfidence*100);confidenceText.textContent=`${p}%`;confidenceFill.style.width=`${p}%`;if(stableFrequency&&currentConfidence>=.28){const m=frequencyToMidi(stableFrequency),c=centsOffNearestNote(m);frequencyEl.textContent=stableFrequency.toFixed(1);noteNameEl.textContent=midiToNoteName(m);centsEl.textContent=`${c>=0?"+":""}${c.toFixed(0)} cents`}else{frequencyEl.textContent="—";noteNameEl.textContent="—";centsEl.textContent="— cents"}}

function drawPitchCircle(){const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;const size=Math.min(w,h);ctx.clearRect(0,0,w,h);ctx.fillStyle="#181818";ctx.fillRect(0,0,w,h);const cx=w/2,cy=h/2,r=size*.34,nr=size*.425;ctx.strokeStyle="#444";ctx.lineWidth=Math.max(1.5,size*.004);ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.stroke();ctx.font=`600 ${Math.max(13,size*.045)}px system-ui`;ctx.textAlign="center";ctx.textBaseline="middle";for(let pc=0;pc<12;pc++){const a=-Math.PI/2+pc*Math.PI*2/12;ctx.fillStyle="#bdbdbd";ctx.fillText(NOTE_NAMES[pc],cx+Math.cos(a)*nr,cy+Math.sin(a)*nr)}const ir=size*.145;ctx.strokeStyle="#333";ctx.lineWidth=Math.max(5,size*.018);ctx.beginPath();ctx.arc(cx,cy,ir,0,Math.PI*2);ctx.stroke();if(stableFrequency&&currentConfidence>=.2){const m=frequencyToMidi(stableFrequency),a=-Math.PI/2+wrappedPitchClass(m)*Math.PI*2/12,x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r,mr=Math.max(8,size*.028);ctx.globalAlpha=.28+.72*currentConfidence;ctx.fillStyle="#fff";ctx.beginPath();ctx.arc(x,y,mr,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;ctx.fillStyle="#f5f5f5";ctx.font=`800 ${Math.max(20,size*.075)}px system-ui`;ctx.fillText(midiToNoteName(m),cx,cy-size*.02);ctx.fillStyle="#aaa";ctx.font=`500 ${Math.max(11,size*.035)}px system-ui`;ctx.fillText(`${Math.round(currentConfidence*100)}%`,cx,cy+size*.07)}else{ctx.fillStyle="#888";ctx.font=`600 ${Math.max(15,size*.05)}px system-ui`;ctx.fillText("listen",cx,cy)}}

function analyzeAttempt(){
 const intervals=phrase().intervals,spb=secondsPerBeat();
 const refTail=selectStableTail(noteTailFrames(currentTrace,0),p=>p.rawMidi);
 const referenceMidi=median(refTail.map(x=>x.v));
 if(referenceMidi==null)return{valid:false,reason:"No stable tail was detected in note 1. Hold the first note a little longer.",trace:[...currentTrace]};
 const normalized=currentTrace.map(p=>p.rawMidi==null?{...p,relative:null,rawRelative:null}:{...p,relative:(p.filteredMidi??p.rawMidi)-referenceMidi,rawRelative:p.rawMidi-referenceMidi});
 const notes=[];
 for(let i=0;i<4;i++){
   const target=intervals[i];
   const tail=selectStableTail(noteTailFrames(normalized,i),p=>p.rawRelative==null?null:octaveFoldSemitones(p.rawRelative,target));
   const vals=tail.map(x=>x.v),med=median(vals),pitchError=med==null?null:(med-target)*100,stability=med==null?null:stddev(vals)*100;
   const allFrames=normalized.filter(p=>p.beat>=i&&p.beat<i+1),voiced=allFrames.filter(p=>p.relative!=null),coverage=allFrames.length?voiced.length/allFrames.length:0;
   const pitchTol=policy().pitchAcceptable/100,correct=allFrames.filter(p=>p.relative!=null&&Math.abs(octaveFoldSemitones(p.relative,target)-target)<=pitchTol),correctCoverage=allFrames.length?correct.length/allFrames.length:0;
   let timingError=null,settlingMs=null;
   if(i===0||intervals[i]===intervals[i-1])timingError=0;
   else{
     const search=normalized.filter(p=>p.relative!=null&&p.confidence>=MIN_CONFIDENCE&&p.beat>=i&&p.beat<=i+.55);
     for(let j=0;j<search.length-2;j++){
       const run=search.slice(j,j+3);
       if(run.every(p=>Math.abs(octaveFoldSemitones(p.relative,target)-target)<=pitchTol)){timingError=(run[0].beat-i)*spb*1000;settlingMs=timingError;break}
     }
   }
   const pitchScore=pitchError==null?0:scoreFromError(pitchError,policy().pitchExcellent,policy().pitchAcceptable);
   const timingScore=timingError==null?0:(i===0||intervals[i]===intervals[i-1]?Math.round(correctCoverage*100):scoreFromError(timingError,policy().timingExcellent,policy().timingAcceptable));
   notes.push({index:i+1,targetSemitones:target,pitchErrorCents:pitchError,timingErrorMs:timingError,settlingMs,coverage,correctCoverage,stabilityCents:stability,pitchScore,timingScore,samples:tail.length,stableTailStart:tail.length?tail[0].p.beat:null,stableTailEnd:tail.length?tail[tail.length-1].p.beat:null});
 }
 return{valid:true,engineVersion:5,phrase:phrase().name,phraseKey:phraseSelect.value,bpm:Number(bpmInput.value),difficulty:difficultySelect.value,policy:{...policy()},analysis:{transitionBeats:TRANSITION_BEATS,tailStart:TAIL_START,tailEnd:TAIL_END,minTailFrames:TAIL_MIN_FRAMES,maxTailSpreadCents:TAIL_MAX_SPREAD_CENTS,maxTailSdCents:TAIL_MAX_SD_CENTS},referenceMidi,referenceNote:midiToNoteName(referenceMidi),referenceSamples:refTail.length,notes,pitchScore:Math.round(mean(notes.map(n=>n.pitchScore))),timingScore:Math.round(mean(notes.map(n=>n.timingScore))),coverage:Math.round(100*mean(notes.map(n=>n.coverage))),trace:normalized,timestamp:new Date().toISOString(),fairness:null};
}
function fmtSigned(v,unit){if(v==null)return"—";return`${v>=0?"+":""}${Math.round(v)}${unit}`}
function renderResult(result){lastResult=result;fairnessPanel.classList.remove("hidden");fairnessButtons.forEach(b=>b.classList.remove("selected"));feedbackStatus.textContent="";if(!result.valid){pitchScoreEl.textContent="—";timingScoreEl.textContent="—";coverageScoreEl.textContent="—";diagnosticBody.innerHTML=`<tr><td colspan="7">${result.reason}</td></tr>`;statusEl.textContent=result.reason;drawTraceGraph();return}pitchScoreEl.textContent=result.pitchScore;timingScoreEl.textContent=result.timingScore;coverageScoreEl.textContent=`${result.coverage}%`;diagnosticBody.innerHTML=result.notes.map(n=>`<tr><td>${n.index}</td><td>${n.targetSemitones>=0?"+":""}${n.targetSemitones} st</td><td>${fmtSigned(n.pitchErrorCents,"¢")}</td><td>${n.index===1||phrase().intervals[n.index-1]===phrase().intervals[n.index-2]?"occupancy":fmtSigned(n.timingErrorMs," ms")}</td><td>${Math.round(n.coverage*100)}%</td><td>${n.stabilityCents==null?"—":Math.round(n.stabilityCents)+"¢ SD"}</td><td>${n.samples}</td></tr>`).join("");statusEl.textContent=`v5 stable-tail analysis: pitch ${result.pitchScore}, timing ${result.timingScore}. Rate whether that feels fair.`;drawTraceGraph()}

function drawTraceGraph(){const w=traceCanvas.clientWidth,h=traceCanvas.clientHeight;if(!w||!h)return;tctx.clearRect(0,0,w,h);tctx.fillStyle="#121212";tctx.fillRect(0,0,w,h);const intervals=phrase().intervals,pad={l:42,r:14,t:18,b:30},pw=w-pad.l-pad.r,ph=h-pad.t-pad.b,vals=[...intervals];const trace=lastResult?.trace||currentTrace.map(p=>({beat:p.beat,relative:null,rawRelative:null}));for(const p of trace)if(p.relative!=null)vals.push(p.relative);let lo=Math.floor(Math.min(-2,...vals)/2)*2-2,hi=Math.ceil(Math.max(12,...vals)/2)*2+2;if(hi-lo<12)hi=lo+12;const x=b=>pad.l+pw*b/4,y=s=>pad.t+ph*(hi-s)/(hi-lo);tctx.font="12px system-ui";for(let s=Math.ceil(lo/2)*2;s<=hi;s+=2){const yy=y(s);tctx.strokeStyle=s===0?"#555":"#292929";tctx.beginPath();tctx.moveTo(pad.l,yy);tctx.lineTo(w-pad.r,yy);tctx.stroke();tctx.fillStyle="#888";tctx.textAlign="right";tctx.textBaseline="middle";tctx.fillText(`${s>0?"+":""}${s}`,pad.l-7,yy)}for(let b=0;b<=4;b++){const xx=x(b);tctx.strokeStyle="#393939";tctx.beginPath();tctx.moveTo(xx,pad.t);tctx.lineTo(xx,h-pad.b);tctx.stroke();if(b<4){tctx.fillStyle="#999";tctx.textAlign="center";tctx.textBaseline="top";tctx.fillText(`${b+1}`,x(b+.5),h-pad.b+7);tctx.fillStyle="rgba(255,255,255,.035)";tctx.fillRect(x(b),pad.t,x(b+TRANSITION_BEATS)-x(b),ph)}}tctx.strokeStyle="#bfbfbf";tctx.lineWidth=3;tctx.setLineDash([7,6]);for(let i=0;i<4;i++){tctx.beginPath();tctx.moveTo(x(i+.06),y(intervals[i]));tctx.lineTo(x(i+.94),y(intervals[i]));tctx.stroke()}tctx.setLineDash([]);
 if(lastResult?.valid){drawSeries(lastResult.trace.filter(p=>p.rawRelative!=null).map(p=>({beat:p.beat,v:p.rawRelative})),x,y,"#777",1,[2,4]);drawSeries(lastResult.trace.filter(p=>p.relative!=null).map(p=>({beat:p.beat,v:p.relative})),x,y,"#f4f4f4",2.5,[]);for(const n of lastResult.notes){if(n.stableTailStart!=null){tctx.strokeStyle="#8fd3a9";tctx.lineWidth=5;tctx.beginPath();tctx.moveTo(x(n.stableTailStart),y(n.targetSemitones));tctx.lineTo(x(n.stableTailEnd),y(n.targetSemitones));tctx.stroke()}}}
 if(exerciseRunning&&exercisePhase==="attempt"){const beat=clamp((audioContext.currentTime-attemptStartTime)/secondsPerBeat(),0,4);tctx.strokeStyle="#fff";tctx.lineWidth=2;tctx.beginPath();tctx.moveTo(x(beat),pad.t);tctx.lineTo(x(beat),h-pad.b);tctx.stroke()}}
function drawSeries(points,x,y,color,width,dash){if(!points.length)return;tctx.strokeStyle=color;tctx.lineWidth=width;tctx.setLineDash(dash);tctx.beginPath();let pen=false,last=null;for(const p of points){if(last!=null&&p.beat-last>.16)pen=false;const xx=x(p.beat),yy=y(p.v);if(!pen){tctx.moveTo(xx,yy);pen=true}else tctx.lineTo(xx,yy);last=p.beat}tctx.stroke();tctx.setLineDash([])}

function scheduleClick(time,accent=false){if(!audioContext||!metronomeToggle.checked)return;const o=audioContext.createOscillator(),g=audioContext.createGain();o.frequency.value=accent?1250:900;g.gain.setValueAtTime(.0001,time);g.gain.exponentialRampToValueAtTime(accent?.10:.065,time+.004);g.gain.exponentialRampToValueAtTime(.0001,time+.05);o.connect(g).connect(audioContext.destination);o.start(time);o.stop(time+.06);scheduledNodes.push(o)}
function scheduleTone(time,duration,midi){if(!audioContext||!targetAudioToggle.checked)return;const o=audioContext.createOscillator(),g=audioContext.createGain();o.type="sine";o.frequency.value=midiToFrequency(midi);g.gain.setValueAtTime(.0001,time);g.gain.exponentialRampToValueAtTime(.07,time+.02);g.gain.setValueAtTime(.07,time+Math.max(.03,duration-.05));g.gain.exponentialRampToValueAtTime(.0001,time+duration);o.connect(g).connect(audioContext.destination);o.start(time);o.stop(time+duration+.02);scheduledNodes.push(o)}
function startValidation(){if(!audioContext||exerciseRunning)return;lowPassMidi=null;liveReferenceMidi=null;guideHold=0;setGuide("muted","Pitch guide");bpmInput.value=clamp(Number(bpmInput.value)||72,40,160);lastResult=null;currentTrace=[];pitchScoreEl.textContent=timingScoreEl.textContent=coverageScoreEl.textContent="—";diagnosticBody.innerHTML='<tr><td colspan="7">Listening for this attempt…</td></tr>';fairnessPanel.classList.add("hidden");exerciseRunning=true;exercisePhase="preview";startExerciseButton.disabled=true;attemptLabel.textContent="Validation attempt";const spb=secondsPerBeat(),lead=.15,root=60,previewStart=audioContext.currentTime+lead,previewDur=targetAudioToggle.checked?4*spb:0;if(targetAudioToggle.checked){phrase().intervals.forEach((iv,i)=>scheduleTone(previewStart+i*spb,spb*.82,root+iv));statusEl.textContent="Listen to the target phrase…"}countInStart=previewStart+previewDur+(targetAudioToggle.checked?spb*.5:0);attemptStartTime=countInStart+COUNT_IN_BEATS*spb;for(let i=0;i<COUNT_IN_BEATS+4;i++)scheduleClick(countInStart+i*spb,i===COUNT_IN_BEATS);drawTraceGraph()}
function finishAttempt(){exerciseRunning=false;exercisePhase="complete";startExerciseButton.disabled=!audioContext;beatLights.forEach(x=>x.classList.remove("active"));beatLabel.textContent="Done";attemptLabel.textContent="Attempt complete";renderResult(analyzeAttempt())}
function cancelExercise(){exerciseRunning=false;exercisePhase="idle";for(const n of scheduledNodes){try{n.stop()}catch{}}scheduledNodes=[];currentTrace=[];startExerciseButton.disabled=!audioContext;beatLights.forEach(x=>x.classList.remove("active"));attemptLabel.textContent="Ready";beatLabel.textContent="—"}
function updateExerciseClock(){if(!exerciseRunning||!audioContext)return;const now=audioContext.currentTime,spb=secondsPerBeat();let active=-1;if(exercisePhase==="preview"&&now>=countInStart){exercisePhase="countin";statusEl.textContent="Count in…"}if(exercisePhase==="countin"){const pos=(now-countInStart)/spb;if(pos>=0&&pos<4){active=Math.floor(pos);beatLabel.textContent=`Count ${active+1}`}else if(pos>=4){exercisePhase="attempt";stableMidi=null;stableFrequency=null;pendingJumpMidi=null;pendingJumpCount=0;lowPassMidi=null;liveReferenceMidi=null;guideHold=0;currentConfidence=0;setGuide("muted","establishing reference…");statusEl.textContent="Reproduce the four-note phrase — color guide activates after settling"}}if(exercisePhase==="attempt"){const beat=(now-attemptStartTime)/spb;if(beat>=4)finishAttempt();else if(beat>=0){active=Math.floor(beat);beatLabel.textContent=`Beat ${active+1}`}}beatLights.forEach((el,i)=>el.classList.toggle("active",i===active));drawTraceGraph()}

function loop(now){analyzePitch(now);updateReadout();drawPitchCircle();updateExerciseClock();animationId=requestAnimationFrame(loop)}
async function startMicrophone(){try{statusEl.textContent="Requesting microphone access…";mediaStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});audioContext=new(window.AudioContext||window.webkitAudioContext)();await audioContext.resume();source=audioContext.createMediaStreamSource(mediaStream);analyser=audioContext.createAnalyser();analyser.fftSize=ANALYSIS_BUFFER_SIZE;analyser.smoothingTimeConstant=0;timeDomainBuffer=new Float32Array(analyser.fftSize);source.connect(analyser);stableMidi=stableFrequency=null;currentConfidence=0;lastAnalysisTime=0;startButton.disabled=true;stopButton.disabled=false;startExerciseButton.disabled=false;statusEl.textContent="Listening — sing, hum, or whistle";animationId=requestAnimationFrame(loop)}catch(e){console.error(e);statusEl.textContent="Could not use microphone. Check browser permission and HTTPS."}}
function stopMicrophone(){cancelExercise();if(animationId)cancelAnimationFrame(animationId);if(mediaStream)for(const t of mediaStream.getTracks())t.stop();if(audioContext)audioContext.close();audioContext=analyser=mediaStream=source=timeDomainBuffer=null;stableMidi=stableFrequency=null;currentConfidence=0;startButton.disabled=false;stopButton.disabled=true;startExerciseButton.disabled=true;statusEl.textContent="Microphone is off.";setGuide("muted","Pitch guide");updateReadout();drawPitchCircle()}
function setView(mode){const lab=mode==="lab";dialView.classList.toggle("hidden",lab);labView.classList.toggle("hidden",!lab);dialTab.classList.toggle("active",!lab);labTab.classList.toggle("active",lab);requestAnimationFrame(resizeCanvases)}

fairnessButtons.forEach(b=>b.addEventListener("click",()=>{if(!lastResult)return;lastResult.fairness=Number(b.dataset.fairness);fairnessButtons.forEach(x=>x.classList.toggle("selected",x===b));feedbackStatus.textContent=`Fairness rating ${lastResult.fairness}/5 recorded locally for this attempt.`}));
exportButton.addEventListener("click",async()=>{if(!lastResult)return;const data=JSON.stringify(lastResult,null,2);try{await navigator.clipboard.writeText(data);feedbackStatus.textContent="Validation data copied to clipboard."}catch{feedbackStatus.textContent="Clipboard unavailable; use browser developer tools to inspect the current result."}});
startButton.addEventListener("click",startMicrophone);stopButton.addEventListener("click",stopMicrophone);startExerciseButton.addEventListener("click",startValidation);dialTab.addEventListener("click",()=>setView("dial"));labTab.addEventListener("click",()=>setView("lab"));bpmInput.addEventListener("change",()=>bpmInput.value=clamp(Number(bpmInput.value)||72,40,160));phraseSelect.addEventListener("change",()=>{lastResult=null;drawTraceGraph()});difficultySelect.addEventListener("change",()=>{if(lastResult?.valid){lastResult=analyzeAttempt();renderResult(lastResult)}});
resizeCanvases();drawPitchCircle();drawTraceGraph();setGuide("muted","Pitch guide");