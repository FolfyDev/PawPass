let ctx;
function getCtx() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!ctx) ctx = new AudioCtx();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(audioCtx, freq, startTime, duration, type, gainPeak) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.008);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
}

export function playCheckinSuccess() {
  const audioCtx = getCtx();
  if (!audioCtx) return;
  tone(audioCtx, 1568, audioCtx.currentTime, 0.14, 'sine', 0.3);
}

export function playCheckinError() {
  const audioCtx = getCtx();
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  tone(audioCtx, 320, now, 0.16, 'square', 0.22);
  tone(audioCtx, 220, now + 0.17, 0.22, 'square', 0.22);
}
