const startButton=document.getElementById("startButton");
const stopButton=document.getElementById("stopButton");
const frequencyEl=document.getElementById("frequency");
const noteNameEl=document.getElementById("noteName");
const centsEl=document.getElementById("cents");
const confidenceText=document.getElementById("confidenceText");
const confidenceFill=document.getElementById("confidenceFill");
const statusEl=document.getElementById("status");
const canvas=document.getElementById("pitchCanvas");
const ctx=canvas.getContext("2d");

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

function frequencyToMidi(f){return 69+12*Math.log2(f/440)}
function midiToFrequency(m){return 440*Math.pow(2,(m-69)/12)}
function midiToNoteName(m){
  const r=Math.round(m),n=NOTE_NAMES[((r%12)+12)%12],o=Math.floor(r/12)-1;
  return `${n}${o}`;
}
function centsOffNearestNote(m){return 100*(m-Math.round(m))}
function wrappedPitchClass(m){return ((m%12)+12)%12}

function resizeCanvas(){
  const r=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  canvas.width=Math.round(r.width*dpr); canvas.height=Math.round(r.height*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener("resize",resizeCanvas);
resizeCanvas();

/* YIN-style pitch estimator.
   The first strong periodic minimum is preferred over the largest spectral
   component, helping identify the fundamental when voice overtones are strong. */
function detectPitchYIN(buffer,sampleRate){
  let rms=0;
  for(let i=0;i<buffer.length;i++) rms+=buffer[i]*buffer[i];
  rms=Math.sqrt(rms/buffer.length);
  if(rms<.008) return null;

  const minTau=Math.max(2,Math.floor(sampleRate/MAX_FREQ));
  const maxTau=Math.min(Math.floor(sampleRate/MIN_FREQ),Math.floor(buffer.length/2));
  const diff=new Float64Array(maxTau+1),cmnd=new Float64Array(maxTau+1);

  for(let tau=1;tau<=maxTau;tau++){
    let sum=0,limit=buffer.length-tau;
    for(let i=0;i<limit;i++){
      const d=buffer[i]-buffer[i+tau];
      sum+=d*d;
    }
    diff[tau]=sum;
  }

  cmnd[0]=1;
  let running=0;
  for(let tau=1;tau<=maxTau;tau++){
    running+=diff[tau];
    cmnd[tau]=running>0?diff[tau]*tau/running:1;
  }

  let tauEstimate=-1;
  for(let tau=minTau;tau<=maxTau;tau++){
    if(cmnd[tau]<YIN_THRESHOLD){
      while(tau+1<=maxTau&&cmnd[tau+1]<cmnd[tau]) tau++;
      tauEstimate=tau; break;
    }
  }

  if(tauEstimate<0){
    let bestTau=minTau,best=cmnd[minTau];
    for(let tau=minTau+1;tau<=maxTau;tau++){
      if(cmnd[tau]<best){best=cmnd[tau];bestTau=tau}
    }
    if(best>.35) return null;
    tauEstimate=bestTau;
  }

  let betterTau=tauEstimate;
  if(tauEstimate>1&&tauEstimate<maxTau){
    const s0=cmnd[tauEstimate-1],s1=cmnd[tauEstimate],s2=cmnd[tauEstimate+1];
    const den=2*(2*s1-s2-s0);
    if(Math.abs(den)>1e-12) betterTau=tauEstimate+(s2-s0)/den;
  }

  const frequency=sampleRate/betterTau;
  const confidence=Math.max(0,Math.min(1,1-cmnd[tauEstimate]));
  if(frequency<MIN_FREQ||frequency>MAX_FREQ) return null;
  return {frequency,confidence};
}

/* Small changes are smoothed in musical (MIDI/cents) space.
   A large jump has to appear in two consecutive analyses (~90 ms) before
   acceptance. This rejects many one-frame octave mistakes without preventing
   a real sung interval from registering quickly. */
function updateStablePitch(measuredMidi,confidence){
  if(stableMidi==null){
    stableMidi=measuredMidi; pendingJumpMidi=null; pendingJumpCount=0; return;
  }

  const diffCents=Math.abs(measuredMidi-stableMidi)*100;

  if(diffCents<140){
    const alpha=.34;
    stableMidi+=alpha*(measuredMidi-stableMidi);
    pendingJumpMidi=null; pendingJumpCount=0; return;
  }

  if(pendingJumpMidi!=null&&Math.abs(measuredMidi-pendingJumpMidi)<.45){
    pendingJumpCount++;
    pendingJumpMidi+=.45*(measuredMidi-pendingJumpMidi);
  }else{
    pendingJumpMidi=measuredMidi; pendingJumpCount=1;
  }

  if(pendingJumpCount>=2&&confidence>=MIN_CONFIDENCE){
    stableMidi=pendingJumpMidi; pendingJumpMidi=null; pendingJumpCount=0;
  }
}

function analyzePitch(now){
  if(!analyser||!audioContext||now-lastAnalysisTime<ANALYSIS_INTERVAL_MS) return;
  lastAnalysisTime=now;
  analyser.getFloatTimeDomainData(timeDomainBuffer);
  const r=detectPitchYIN(timeDomainBuffer,audioContext.sampleRate);

  if(!r){
    currentConfidence*=.82;
    if(currentConfidence<.1) stableFrequency=null;
    return;
  }

  currentConfidence=.55*currentConfidence+.45*r.confidence;

  if(r.confidence>=MIN_CONFIDENCE){
    updateStablePitch(frequencyToMidi(r.frequency),r.confidence);
    stableFrequency=midiToFrequency(stableMidi);
  }
}

function updateReadout(){
  const p=Math.round(currentConfidence*100);
  confidenceText.textContent=`${p}%`;
  confidenceFill.style.width=`${p}%`;

  if(stableFrequency&&currentConfidence>=.28){
    const midi=frequencyToMidi(stableFrequency),c=centsOffNearestNote(midi);
    frequencyEl.textContent=stableFrequency.toFixed(1);
    noteNameEl.textContent=midiToNoteName(midi);
    centsEl.textContent=`${c>=0?"+":""}${c.toFixed(0)} cents`;
    statusEl.textContent=currentConfidence>=MIN_CONFIDENCE?"Stable pitch":"Pitch uncertain — hold the note steadily";
  }else{
    frequencyEl.textContent="—"; noteNameEl.textContent="—"; centsEl.textContent="— cents";
    statusEl.textContent=analyser?"Listening — sing, hum, or whistle a steady note":"Microphone is off.";
  }
}

function drawPitchCircle(){
  const w=canvas.clientWidth,h=canvas.clientHeight,size=Math.min(w,h);
  ctx.clearRect(0,0,w,h); ctx.fillStyle="#181818"; ctx.fillRect(0,0,w,h);

  const cx=w/2,cy=h/2,r=size*.34,nr=size*.425;
  ctx.strokeStyle="#444"; ctx.lineWidth=Math.max(1.5,size*.004);
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.stroke();

  ctx.font=`600 ${Math.max(13,size*.045)}px system-ui`;
  ctx.textAlign="center"; ctx.textBaseline="middle";

  for(let pc=0;pc<12;pc++){
    const a=-Math.PI/2+pc*Math.PI*2/12;
    const x1=cx+Math.cos(a)*r*.92,y1=cy+Math.sin(a)*r*.92;
    const x2=cx+Math.cos(a)*r*1.08,y2=cy+Math.sin(a)*r*1.08;
    ctx.strokeStyle="#555"; ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
    ctx.fillStyle="#bdbdbd";
    ctx.fillText(NOTE_NAMES[pc],cx+Math.cos(a)*nr,cy+Math.sin(a)*nr);
  }

  const ir=size*.145;
  ctx.strokeStyle="#333";ctx.lineWidth=Math.max(5,size*.018);
  ctx.beginPath();ctx.arc(cx,cy,ir,0,Math.PI*2);ctx.stroke();

  if(currentConfidence>.01){
    ctx.strokeStyle="#e8e8e8";ctx.globalAlpha=.25+.75*currentConfidence;
    ctx.beginPath();
    ctx.arc(cx,cy,ir,-Math.PI/2,-Math.PI/2+Math.PI*2*currentConfidence);
    ctx.stroke();ctx.globalAlpha=1;
  }

  if(stableFrequency&&currentConfidence>=.20){
    const midi=frequencyToMidi(stableFrequency),pc=wrappedPitchClass(midi);
    const a=-Math.PI/2+pc*Math.PI*2/12;
    const x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r,mr=Math.max(8,size*.028);

    ctx.globalAlpha=.28+.72*currentConfidence;
    ctx.fillStyle="#fff";ctx.beginPath();ctx.arc(x,y,mr,0,Math.PI*2);ctx.fill();
    ctx.fillStyle="#111";ctx.beginPath();ctx.arc(x,y,mr*.38,0,Math.PI*2);ctx.fill();
    ctx.globalAlpha=1;

    ctx.fillStyle="#f5f5f5";ctx.font=`800 ${Math.max(20,size*.075)}px system-ui`;
    ctx.fillText(midiToNoteName(midi),cx,cy-size*.02);
    ctx.fillStyle="#aaa";ctx.font=`500 ${Math.max(11,size*.035)}px system-ui`;
    ctx.fillText(`${Math.round(currentConfidence*100)}%`,cx,cy+size*.07);
  }else{
    ctx.fillStyle="#888";ctx.font=`600 ${Math.max(15,size*.05)}px system-ui`;
    ctx.fillText("listen",cx,cy);
  }
}

function loop(now){
  analyzePitch(now); updateReadout(); drawPitchCircle();
  animationId=requestAnimationFrame(loop);
}

async function startMicrophone(){
  try{
    statusEl.textContent="Requesting microphone access…";
    mediaStream=await navigator.mediaDevices.getUserMedia({audio:{
      echoCancellation:false,noiseSuppression:false,autoGainControl:false
    }});
    audioContext=new (window.AudioContext||window.webkitAudioContext)();
    source=audioContext.createMediaStreamSource(mediaStream);
    analyser=audioContext.createAnalyser();
    analyser.fftSize=ANALYSIS_BUFFER_SIZE; analyser.smoothingTimeConstant=0;
    timeDomainBuffer=new Float32Array(analyser.fftSize);
    source.connect(analyser);

    stableMidi=null;stableFrequency=null;currentConfidence=0;
    pendingJumpMidi=null;pendingJumpCount=0;lastAnalysisTime=0;
    startButton.disabled=true;stopButton.disabled=false;
    animationId=requestAnimationFrame(loop);
  }catch(e){
    console.error(e);
    statusEl.textContent="Could not use microphone. Check browser permission and HTTPS.";
  }
}

function stopMicrophone(){
  if(animationId){cancelAnimationFrame(animationId);animationId=null}
  if(mediaStream) for(const track of mediaStream.getTracks()) track.stop();
  if(audioContext) audioContext.close();

  mediaStream=null;audioContext=null;analyser=null;source=null;timeDomainBuffer=null;
  stableMidi=null;stableFrequency=null;currentConfidence=0;
  pendingJumpMidi=null;pendingJumpCount=0;

  frequencyEl.textContent="—";noteNameEl.textContent="—";centsEl.textContent="— cents";
  confidenceText.textContent="—";confidenceFill.style.width="0%";
  statusEl.textContent="Microphone is off.";
  startButton.disabled=false;stopButton.disabled=true;
  drawPitchCircle();
}

startButton.addEventListener("click",startMicrophone);
stopButton.addEventListener("click",stopMicrophone);
drawPitchCircle();
