const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const frequencyEl = document.getElementById("frequency");
const noteNameEl = document.getElementById("noteName");
const centsEl = document.getElementById("cents");
const statusEl = document.getElementById("status");

const canvas = document.getElementById("pitchCanvas");
const ctx = canvas.getContext("2d");

let audioContext = null;
let analyser = null;
let mediaStream = null;
let source = null;
let timeDomainBuffer = null;
let animationId = null;

let currentFrequency = null;
let smoothedFrequency = null;

// Display range. C3 to C6 is comfortable for a first experiment.
const MIN_MIDI = 48; // C3
const MAX_MIDI = 84; // C6

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

function frequencyToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function midiToNoteName(midiFloat) {
  const noteNames = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const midi = Math.round(midiFloat);
  const note = noteNames[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

function centsOffNearestNote(freq) {
  const midiFloat = frequencyToMidi(freq);
  return 100 * (midiFloat - Math.round(midiFloat));
}

// Simple autocorrelation pitch detector.
// This is intentionally dependency-free for the first prototype.
function autoCorrelate(buffer, sampleRate) {
  const size = buffer.length;

  // RMS gate rejects silence and low-level background noise.
  let rms = 0;
  for (let i = 0; i < size; i++) {
    rms += buffer[i] * buffer[i];
  }
  rms = Math.sqrt(rms / size);

  if (rms < 0.012) {
    return null;
  }

  // Trim quiet edges to make autocorrelation a little more stable.
  let r1 = 0;
  let r2 = size - 1;
  const threshold = 0.2;

  for (let i = 0; i < size / 2; i++) {
    if (Math.abs(buffer[i]) < threshold) {
      r1 = i;
    } else {
      break;
    }
  }

  for (let i = 1; i < size / 2; i++) {
    if (Math.abs(buffer[size - i]) < threshold) {
      r2 = size - i;
    } else {
      break;
    }
  }

  const trimmed = buffer.slice(r1, r2);
  const n = trimmed.length;
  const correlations = new Array(n).fill(0);

  for (let lag = 0; lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) {
      sum += trimmed[i] * trimmed[i + lag];
    }
    correlations[lag] = sum;
  }

  let dip = 0;
  while (dip + 1 < n && correlations[dip] > correlations[dip + 1]) {
    dip++;
  }

  let peak = -1;
  let peakValue = -Infinity;

  for (let lag = dip; lag < n; lag++) {
    if (correlations[lag] > peakValue) {
      peakValue = correlations[lag];
      peak = lag;
    }
  }

  if (peak <= 0) {
    return null;
  }

  // Parabolic interpolation around the correlation peak.
  let betterPeak = peak;
  if (peak > 0 && peak < n - 1) {
    const x1 = correlations[peak - 1];
    const x2 = correlations[peak];
    const x3 = correlations[peak + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;

    if (a !== 0) {
      betterPeak = peak - b / (2 * a);
    }
  }

  const freq = sampleRate / betterPeak;

  // Reject implausible values for singing/whistling in this first version.
  if (freq < 70 || freq > 1800) {
    return null;
  }

  return freq;
}

function updatePitch() {
  analyser.getFloatTimeDomainData(timeDomainBuffer);

  const detected = autoCorrelate(timeDomainBuffer, audioContext.sampleRate);

  if (detected) {
    if (smoothedFrequency == null) {
      smoothedFrequency = detected;
    } else {
      // Light smoothing makes the display easier to read.
      smoothedFrequency = 0.82 * smoothedFrequency + 0.18 * detected;
    }

    currentFrequency = smoothedFrequency;

    const midi = frequencyToMidi(currentFrequency);
    const cents = centsOffNearestNote(currentFrequency);

    frequencyEl.textContent = currentFrequency.toFixed(1);
    noteNameEl.textContent = midiToNoteName(midi);
    centsEl.textContent = `${cents >= 0 ? "+" : ""}${cents.toFixed(0)} cents`;
    statusEl.textContent = "Listening…";
  } else {
    currentFrequency = null;
    frequencyEl.textContent = "—";
    noteNameEl.textContent = "—";
    centsEl.textContent = "— cents";
    statusEl.textContent = "Listening — sing or whistle a steady note.";
  }

  drawPitchDisplay();
  animationId = requestAnimationFrame(updatePitch);
}

function midiToY(midi, height) {
  const t = (midi - MIN_MIDI) / (MAX_MIDI - MIN_MIDI);
  return height - t * height;
}

function drawPitchDisplay() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = "#181818";
  ctx.fillRect(0, 0, width, height);

  ctx.font = "13px system-ui";
  ctx.textBaseline = "middle";

  // Draw semitone grid, emphasizing natural C notes.
  for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi++) {
    const y = midiToY(midi, height);
    const isC = midi % 12 === 0;

    ctx.strokeStyle = isC ? "#555" : "#2b2b2b";
    ctx.lineWidth = isC ? 1.5 : 1;

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();

    if (isC) {
      ctx.fillStyle = "#aaa";
      ctx.fillText(midiToNoteName(midi), 10, y - 10);
    }
  }

  if (currentFrequency) {
    const midi = frequencyToMidi(currentFrequency);
    const y = midiToY(midi, height);

    if (midi >= MIN_MIDI - 2 && midi <= MAX_MIDI + 2) {
      ctx.beginPath();
      ctx.arc(width * 0.5, y, 13, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(width * 0.5, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#111111";
      ctx.fill();
    }
  }
}

async function startMicrophone() {
  try {
    statusEl.textContent = "Requesting microphone access…";

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();

    source = audioContext.createMediaStreamSource(mediaStream);

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;

    timeDomainBuffer = new Float32Array(analyser.fftSize);

    source.connect(analyser);

    startButton.disabled = true;
    stopButton.disabled = false;

    updatePitch();
  } catch (error) {
    console.error(error);
    statusEl.textContent =
      "Could not use the microphone. Check browser microphone permission and use HTTPS.";
  }
}

function stopMicrophone() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
  }

  if (audioContext) {
    audioContext.close();
  }

  mediaStream = null;
  audioContext = null;
  analyser = null;
  source = null;
  timeDomainBuffer = null;
  currentFrequency = null;
  smoothedFrequency = null;

  frequencyEl.textContent = "—";
  noteNameEl.textContent = "—";
  centsEl.textContent = "— cents";
  statusEl.textContent = "Microphone is off.";

  startButton.disabled = false;
  stopButton.disabled = true;

  drawPitchDisplay();
}

startButton.addEventListener("click", startMicrophone);
stopButton.addEventListener("click", stopMicrophone);

drawPitchDisplay();
