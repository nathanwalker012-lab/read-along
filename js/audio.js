// Audio decoding, playback that skips cut parts, waveform data and WAV export.
import { keptSegments, toEdited, toOriginal, editedDuration } from './align.js';

let sharedCtx = null;
export function audioContext() {
  if (!sharedCtx) sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
  return sharedCtx;
}

// Decodes any recording the browser understands into one mono channel.
export async function decodeToMono(blob) {
  const ctx = audioContext();
  const data = await blob.arrayBuffer();
  const buf = await ctx.decodeAudioData(data);
  if (buf.numberOfChannels === 1) return buf;
  const mono = ctx.createBuffer(1, buf.length, buf.sampleRate);
  const out = mono.getChannelData(0);
  const chs = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  const k = 1 / chs.length;
  for (let i = 0; i < buf.length; i++) {
    let v = 0;
    for (const ch of chs) v += ch[i];
    out[i] = v * k;
  }
  return mono;
}

// 16 kHz mono samples, which is what the speech model expects.
export async function resampleTo16k(buffer) {
  const len = Math.ceil(buffer.duration * 16000);
  const off = new OfflineAudioContext(1, len, 16000);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

// Splits long recordings into pieces of at most ~28 s, cutting in the quietest
// spot so words are not chopped in half.
export function splitForSpeech(samples, rate = 16000) {
  const frame = Math.round(rate * 0.02);
  const nFrames = Math.floor(samples.length / frame);
  const rms = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let sum = 0;
    for (let i = f * frame, end = i + frame; i < end; i++) sum += samples[i] * samples[i];
    rms[f] = Math.sqrt(sum / frame);
  }
  const pieces = [];
  let start = 0; // in frames
  const total = nFrames;
  const fps = 1 / 0.02;
  while (start < total) {
    if (total - start <= 28 * fps) { pieces.push([start, total]); break; }
    const lo = start + Math.round(18 * fps), hi = Math.min(total - 1, start + Math.round(28 * fps));
    let best = hi, bestV = Infinity;
    for (let f = hi; f >= lo; f--) {
      // average over 0.2 s around the frame so one quiet sample does not win
      let v = 0;
      for (let k = -5; k <= 5; k++) v += rms[Math.min(total - 1, Math.max(0, f + k))];
      if (v < bestV - 1e-6) { bestV = v; best = f; }
    }
    pieces.push([start, best]);
    start = best;
  }
  return pieces.map(([a, b]) => {
    let peak = 0;
    for (let f = a; f < b; f++) peak = Math.max(peak, rms[f]);
    return { s: a * 0.02, e: b * 0.02, start: a * frame, end: Math.min(samples.length, b * frame), silent: peak < 0.004 };
  });
}

// Min/max pairs for drawing the waveform.
export function waveformPeaks(buffer, perSecond = 50) {
  const data = buffer.getChannelData(0);
  const n = Math.max(1, Math.ceil(buffer.duration * perSecond));
  const step = data.length / n;
  const peaks = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    let p = 0;
    const a = Math.floor(i * step), b = Math.min(data.length, Math.floor((i + 1) * step));
    for (let j = a; j < b; j += 4) { const v = Math.abs(data[j]); if (v > p) p = v; }
    peaks[i] = p;
    if (p > max) max = p;
  }
  if (max > 0) for (let i = 0; i < n; i++) peaks[i] /= max;
  return peaks;
}

const FADE = 0.008; // short fades at each cut to avoid clicks

// Plays the recording with the cut parts left out.
// Positions are reported in original time so the editor can follow along.
export class Player {
  constructor() {
    this.buffer = null;
    this.cuts = [];
    this.sources = [];
    this.playing = false;
    this.position = 0; // original time when paused
    this.onEnded = null;
    this.stopAt = null;
    this.rate = 1;
  }
  load(buffer, cuts) { this.stop(); this.buffer = buffer; this.cuts = cuts; this.position = 0; }
  setCuts(cuts) {
    const was = this.playing, at = this.currentTime();
    this.cuts = cuts;
    if (was) { this.pause(); this.play(at); }
  }
  get duration() { return this.buffer ? this.buffer.duration : 0; }

  play(fromOriginal = this.position, untilOriginal = null) {
    if (!this.buffer) return;
    const ctx = audioContext();
    if (ctx.state === 'suspended') ctx.resume();
    this.stopSources();
    let from = Math.max(0, Math.min(fromOriginal, this.duration - 0.01));
    // if starting inside a cut, jump to its end
    for (const c of this.cuts) if (from >= c.s && from < c.e) from = c.e;
    const segs = keptSegments(this.cuts, this.duration)
      .map((s) => ({ s: Math.max(s.s, from), e: untilOriginal != null ? Math.min(s.e, untilOriginal) : s.e }))
      .filter((s) => s.e - s.s > 0.002);
    if (!segs.length) { this.position = from; this.playing = false; this.onEnded && this.onEnded(); return; }
    const t0 = ctx.currentTime + 0.05;
    let t = t0;
    const r = this.rate;
    segs.forEach((seg, k) => {
      const src = ctx.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = r;
      const g = ctx.createGain();
      const len = (seg.e - seg.s) / r;
      const fade = Math.min(FADE, len / 3);
      g.gain.setValueAtTime(k === 0 && seg.s === from ? 1 : 0, t);
      if (!(k === 0 && seg.s === from)) g.gain.linearRampToValueAtTime(1, t + fade);
      g.gain.setValueAtTime(1, t + len - fade);
      g.gain.linearRampToValueAtTime(0, t + len);
      src.connect(g).connect(ctx.destination);
      src.start(t, seg.s, seg.e - seg.s);
      this.sources.push({ src, g, start: t, end: t + len, s: seg.s, e: seg.e });
      if (k === segs.length - 1) {
        src.onended = () => {
          if (!this.sources.length || this.sources[this.sources.length - 1].src !== src) return;
          // a preview returns to where it started; the full lesson rewinds
          this.position = untilOriginal != null ? fromOriginal : 0;
          this.sources = [];
          this.playing = false;
          this.onEnded && this.onEnded();
        };
      }
      t += len;
    });
    this.playing = true;
  }

  currentTime() {
    if (!this.playing || !this.sources.length) return this.position;
    const now = audioContext().currentTime;
    const first = this.sources[0];
    if (now < first.start) return first.s;
    for (const p of this.sources) {
      if (now < p.end) return p.s + (now - p.start) * this.rate;
    }
    return this.sources[this.sources.length - 1].e;
  }

  pause() {
    if (!this.playing) return;
    this.position = this.currentTime();
    this.stopSources();
    this.playing = false;
  }
  stop() { this.stopSources(); this.playing = false; this.position = 0; }
  seek(t) {
    const was = this.playing;
    this.pause();
    this.position = Math.max(0, Math.min(t, this.duration));
    if (was) this.play(this.position);
  }
  stopSources() {
    for (const p of this.sources) { p.src.onended = null; try { p.src.stop(); } catch (e) { /* already stopped */ } }
    this.sources = [];
  }
  // edited-timeline helpers for the lesson player
  editedTime() { return toEdited(this.currentTime(), this.cuts); }
  editedDuration() { return editedDuration(this.duration, this.cuts); }
  seekEdited(t) { this.seek(toOriginal(t, this.cuts)); }
}

// Renders the edited recording (cuts removed) to a mono AudioBuffer.
export async function renderEdited(buffer, cuts) {
  const segs = keptSegments(cuts, buffer.duration);
  const total = segs.reduce((x, s) => x + (s.e - s.s), 0);
  const rate = buffer.sampleRate;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(total * rate)), rate);
  let t = 0;
  segs.forEach((seg, k) => {
    const src = off.createBufferSource();
    src.buffer = buffer;
    const g = off.createGain();
    const len = seg.e - seg.s;
    const fade = Math.min(FADE, len / 3);
    g.gain.setValueAtTime(k === 0 ? 1 : 0, t);
    if (k > 0) g.gain.linearRampToValueAtTime(1, t + fade);
    g.gain.setValueAtTime(1, t + len - fade);
    g.gain.linearRampToValueAtTime(k === segs.length - 1 ? 1 : 0, t + len);
    src.connect(g).connect(off.destination);
    src.start(t, seg.s, len);
    t += len;
  });
  return off.startRendering();
}

// 16-bit PCM WAV file from a mono AudioBuffer.
export function encodeWav(buffer) {
  const data = buffer.getChannelData(0);
  const rate = buffer.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + data.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + data.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(-1, Math.min(1, data[i]));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

// Microphone recording with a live level meter.
export class Recorder {
  constructor() { this.chunks = []; this.rec = null; this.stream = null; this.level = 0; this.startedAt = 0; this.elapsedBefore = 0; }
  static supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder); }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
    this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType, audioBitsPerSecond: 96000 } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
    const ctx = audioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const srcNode = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    srcNode.connect(this.analyser);
    this.levelBuf = new Float32Array(this.analyser.fftSize);
    this.startedAt = performance.now();
    this.elapsedBefore = 0;
  }
  readLevel() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let p = 0;
    for (const v of this.levelBuf) p = Math.max(p, Math.abs(v));
    return p;
  }
  get paused() { return this.rec && this.rec.state === 'paused'; }
  pause() { if (this.rec && this.rec.state === 'recording') { this.rec.pause(); this.elapsedBefore += performance.now() - this.startedAt; } }
  resume() { if (this.rec && this.rec.state === 'paused') { this.rec.resume(); this.startedAt = performance.now(); } }
  elapsed() {
    if (!this.rec) return 0;
    return (this.elapsedBefore + (this.rec.state === 'recording' ? performance.now() - this.startedAt : 0)) / 1000;
  }
  stop() {
    return new Promise((resolve) => {
      if (!this.rec) return resolve(null);
      this.rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' });
        this.cleanup();
        resolve(blob);
      };
      this.rec.stop();
    });
  }
  cancel() { if (this.rec && this.rec.state !== 'inactive') { this.rec.onstop = null; this.rec.stop(); } this.cleanup(); }
  cleanup() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null; this.analyser = null;
  }
}
