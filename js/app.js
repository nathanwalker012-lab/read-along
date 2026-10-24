import * as A from './align.js';
import { decodeToMono, resampleTo16k, splitForSpeech, waveformPeaks, Player, Recorder, renderEdited, encodeWav, audioContext } from './audio.js';
import * as DB from './db.js';

// ---------------------------------------------------------------- helpers
const app = document.getElementById('app');
const layer = document.getElementById('layer');

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="4" width="4.5" height="16" rx="1.2" fill="currentColor"/><rect x="14" y="4" width="4.5" height="16" rx="1.2" fill="currentColor"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"/><text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" font-family="sans-serif" font-weight="700">5</text></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>',
  full: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M5 12h14"/></svg>',
};
const icon = (name) => h('span', { html: ICON[name], style: { display: 'inline-flex' } });

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
const secs = (t) => `${t.toFixed(1)} s`;

let toastTimer = null;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = h('div', { class: 'toast', role: 'status' }); document.body.append(el); }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

function openSheet(build) {
  const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
  const scrim = h('div', { class: 'scrim', onclick: (e) => { if (e.target === scrim) close(); } }, sheet);
  build(sheet, close);
  layer.append(scrim);
  document.addEventListener('keydown', onKey);
  const first = sheet.querySelector('button, input, textarea');
  if (first) first.focus();
  return close;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}
const slug = (s) => (s || 'lesson').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lesson';

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* not available */ }
}

// ---------------------------------------------------------------- state
const S = {
  lesson: null,      // the open lesson
  buffer: null,      // decoded recording
  peaks: null,
  player: new Player(),
  history: [],       // earlier cut lists, for Undo
  sel: null,
  flags: null,       // alignment results for the editor
  cleanup: [],
};
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; const b = document.getElementById('install'); if (b) b.hidden = false; });

function leaveView() {
  S.player.stop();
  S.cleanup.forEach((f) => f());
  S.cleanup = [];
  keepAwake(false);
}

// ---------------------------------------------------------------- home
async function showHome() {
  leaveView();
  S.lesson = null; S.buffer = null;
  const lessons = await DB.listLessons();
  app.replaceChildren();
  const fileIn = h('input', { type: 'file', accept: '.readalong,application/octet-stream', hidden: true, onchange: importLesson });
  app.append(
    h('header', { class: 'brand' },
      h('h1', null, h('span', { class: 'mark' }, 'Read'), '-Along'),
      h('p', { class: 'muted' }, 'Record a reading. Line it up with the text. Play it for your class.')),
    h('div', { class: 'row', style: { marginTop: '20px' } },
      h('button', { class: 'btn primary big', onclick: showNew }, icon('plus'), 'New lesson'),
      h('button', { class: 'btn', onclick: () => fileIn.click() }, 'Open lesson file'),
      h('button', { class: 'btn quiet', id: 'install', hidden: !installPrompt, onclick: async () => { if (installPrompt) { installPrompt.prompt(); installPrompt = null; document.getElementById('install').hidden = true; } } }, 'Install app'),
      fileIn),
  );
  if (!lessons.length) {
    app.append(h('div', { class: 'empty' },
      h('h2', null, 'Make your first lesson'),
      h('ol', null,
        h('li', null, 'Paste the text you will read.'),
        h('li', null, 'Record yourself reading it, or choose a recording you already have.'),
        h('li', null, 'The app finds when each word was spoken. Then you cut mistakes and long pauses by tapping words.'),
        h('li', null, 'Play it full screen. Each word lights up as you read it.'))));
  } else {
    const list = h('div', { class: 'lessons' });
    for (const l of lessons) {
      const dur = A.editedDuration(l.duration || 0, l.cuts || []);
      list.append(h('article', { class: 'lesson' },
        h('h2', null, l.title || 'Untitled lesson'),
        h('p', { class: 'meta muted small num' }, `${fmt(dur)} long · saved ${new Date(l.updatedAt).toLocaleDateString()}`),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => showEditor(l.id) }, 'Edit'),
          h('button', { class: 'btn primary', onclick: async () => { await showEditor(l.id); openPlayer(); } }, icon('play'), 'Play'))));
    }
    app.append(list);
  }
  app.append(h('p', { class: 'footnote muted small' },
    'Lessons are saved in this browser on this device only. To move one to another computer, open it and choose Save lesson file.'));
}

async function importLesson(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const lesson = await DB.lessonFromFile(file);
    lesson.id = DB.newId();
    await DB.saveLesson(lesson);
    toast(`Opened “${lesson.title}”`);
    showHome();
  } catch (err) {
    toast(err.message || 'That file could not be opened.');
  }
}

// ---------------------------------------------------------------- new lesson
function showNew() {
  leaveView();
  const draft = { title: '', text: '', audio: null, model: 'fast' };
  const rec = new Recorder();
  let meterRaf = 0;
  S.cleanup.push(() => { cancelAnimationFrame(meterRaf); rec.cancel(); });

  const title = h('input', { type: 'text', id: 'title', placeholder: 'Amigo Brothers, part 1', oninput: () => { draft.title = title.value; check(); } });
  const text = h('textarea', { id: 'text', placeholder: 'Paste the exact text you will read aloud.', oninput: () => { draft.text = text.value; check(); } });
  const txtIn = h('input', { type: 'file', accept: '.txt,text/plain', hidden: true, onchange: async () => {
    const f = txtIn.files[0]; if (!f) return;
    text.value = await f.text(); draft.text = text.value;
    if (!title.value) { title.value = f.name.replace(/\.[^.]+$/, ''); draft.title = title.value; }
    check();
  } });

  // recording / file tabs
  const audioPreview = h('div', { class: 'stack', hidden: true });
  const recBox = h('div', { class: 'recorder' });
  const fileBox = h('div', { class: 'stack', hidden: true });
  const audioIn = h('input', { type: 'file', id: 'audiofile', accept: 'audio/*,video/mp4,.m4a,.mp3,.wav,.webm,.ogg,.aac', onchange: () => {
    const f = audioIn.files[0]; if (!f) return;
    setAudio(f, f.name);
  } });
  fileBox.append(h('label', { class: 'field' }, 'Choose a recording', audioIn),
    h('p', { class: 'muted small' }, 'MP3, M4A, WAV, WebM and most phone voice-memo files work.'));

  const tabRec = h('button', { role: 'tab', 'aria-selected': 'true', onclick: () => pick('rec') }, 'Record now');
  const tabFile = h('button', { role: 'tab', 'aria-selected': 'false', onclick: () => pick('file') }, 'Use a file');
  function pick(which) {
    tabRec.setAttribute('aria-selected', String(which === 'rec'));
    tabFile.setAttribute('aria-selected', String(which === 'file'));
    recBox.hidden = which !== 'rec' || !!draft.audio;
    fileBox.hidden = which !== 'file' || !!draft.audio;
  }

  const recTime = h('div', { class: 'rec-time' }, '0:00');
  const meter = h('div', { class: 'meter', 'aria-hidden': 'true' }, h('i'));
  const recBtn = h('button', { class: 'rec-btn', 'aria-label': 'Start recording', onclick: toggleRec }, h('span', { class: 'dot' }));
  const pauseBtn = h('button', { class: 'btn', hidden: true, onclick: () => {
    if (rec.paused) { rec.resume(); pauseBtn.textContent = 'Pause'; } else { rec.pause(); pauseBtn.textContent = 'Resume'; }
  } }, 'Pause');
  const recHint = h('p', { class: 'muted small' }, 'Tap the red button and start reading. Hold the phone about a hand’s length from your mouth. The screen stays on while you record.');
  const recErr = h('p', { class: 'error', hidden: true });
  if (!Recorder.supported()) { recBtn.disabled = true; recHint.textContent = 'This browser cannot record. Use a file instead.'; }
  recBox.append(h('div', { class: 'row', style: { gap: '16px' } }, recBtn, recTime, pauseBtn), meter, recHint, recErr);

  async function toggleRec() {
    if (!rec.rec || rec.rec.state === 'inactive') {
      try {
        await rec.start();
      } catch (err) {
        recErr.hidden = false;
        recErr.textContent = 'The microphone is blocked. Allow microphone access for this site in your browser settings, then try again.';
        return;
      }
      keepAwake(true);
      recBtn.classList.add('on'); recBtn.setAttribute('aria-label', 'Stop recording');
      pauseBtn.hidden = false;
      const tick = () => {
        recTime.textContent = fmt(rec.elapsed());
        meter.firstChild.style.width = `${Math.min(100, rec.readLevel() * 140)}%`;
        meterRaf = requestAnimationFrame(tick);
      };
      tick();
    } else {
      cancelAnimationFrame(meterRaf);
      const blob = await rec.stop();
      keepAwake(false);
      recBtn.classList.remove('on'); pauseBtn.hidden = true;
      if (blob && blob.size) setAudio(blob, `Recording, ${recTime.textContent}`);
    }
  }

  function setAudio(blob, label) {
    draft.audio = blob;
    const url = URL.createObjectURL(blob);
    S.cleanup.push(() => URL.revokeObjectURL(url));
    audioPreview.replaceChildren(
      h('p', null, h('strong', null, label)),
      h('audio', { controls: true, src: url, preload: 'metadata' }),
      h('div', null, h('button', { class: 'btn', onclick: () => { draft.audio = null; audioPreview.hidden = true; audioIn.value = ''; recTime.textContent = '0:00'; pick(tabRec.getAttribute('aria-selected') === 'true' ? 'rec' : 'file'); check(); } }, 'Use a different recording')));
    audioPreview.hidden = false;
    recBox.hidden = true; fileBox.hidden = true;
    check();
  }

  const modelFast = h('input', { type: 'radio', name: 'model', value: 'fast', checked: true, onchange: () => { draft.model = 'fast'; } });
  const modelAcc = h('input', { type: 'radio', name: 'model', value: 'accurate', onchange: () => { draft.model = 'accurate'; } });

  const go = h('button', { class: 'btn primary big', disabled: true, onclick: async () => {
    const lesson = {
      id: DB.newId(), title: draft.title.trim() || 'Untitled lesson', text: draft.text.trim(), audio: draft.audio,
      model: draft.model, cuts: [], heard: null, duration: 0, createdAt: Date.now(), view: { mode: 'word', scale: 1, theme: 'auto' },
    };
    await DB.saveLesson(lesson);
    DB.askPersistentStorage();
    runTimestamps(lesson.id, draft.model);
  } }, 'Make lesson');
  const goHint = h('p', { class: 'muted small' });
  function check() {
    go.disabled = !(draft.text.trim() && draft.audio);
    goHint.textContent = go.disabled ? (draft.text.trim() ? 'Add a recording to continue.' : 'Add the text to continue.') : '';
  }

  app.replaceChildren(
    h('div', { class: 'topbar' },
      h('button', { class: 'btn icon quiet', 'aria-label': 'Back to lessons', onclick: showHome }, icon('left')),
      h('h1', null, 'New lesson')),
    h('div', { class: 'section', style: { borderTop: '0', paddingTop: '0' } },
      h('label', { class: 'field', for: 'title' }, 'Lesson name', title)),
    h('div', { class: 'section' },
      h('h2', null, 'Text'),
      h('label', { class: 'field', for: 'text' }, h('span', { class: 'muted small' }, 'The words you will read. Paragraph breaks are kept.'), text),
      h('div', null, h('button', { class: 'btn', onclick: () => txtIn.click() }, 'Load a .txt file'), txtIn)),
    h('div', { class: 'section' },
      h('h2', null, 'Recording'),
      h('div', { class: 'tabs', role: 'tablist' }, tabRec, tabFile),
      recBox, fileBox, audioPreview),
    h('div', { class: 'section' },
      h('h2', null, 'Word timing'),
      h('label', { class: 'choice' }, modelFast, h('span', null, h('strong', null, 'Quick'), h('br'), h('span', { class: 'muted small' }, 'About a 40 MB download the first time. Good for clear readings.'))),
      h('label', { class: 'choice' }, modelAcc, h('span', null, h('strong', null, 'Careful'), h('br'), h('span', { class: 'muted small' }, 'About an 80 MB download the first time. Slower, catches more words.'))),
      h('p', { class: 'muted small' }, 'The timing runs on this device. Your recording is never uploaded. Use Wi-Fi for the first download.')),
    h('div', { class: 'section' }, go, goHint),
  );
  check();
}

// ---------------------------------------------------------------- word timing
let worker = null;
function getWorker() {
  if (!worker) worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
  return worker;
}
function workerCall(msg, onProgress) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const id = Math.random().toString(36).slice(2);
    const handler = (e) => {
      const m = e.data;
      if (m.type === 'download') { onProgress && onProgress(m); return; }
      if (m.id && m.id !== id) return;
      if (msg.type === 'load' && m.type === 'loaded') { w.removeEventListener('message', handler); resolve(); }
      else if (m.type === 'words' && m.id === id) { w.removeEventListener('message', handler); resolve(m.words); }
      else if (m.type === 'error') { w.removeEventListener('message', handler); reject(new Error(m.message)); }
    };
    w.addEventListener('message', handler);
    w.onerror = (e) => { w.removeEventListener('message', handler); reject(new Error(e.message || 'The speech model could not start.')); };
    const transfer = msg.samples ? [msg.samples.buffer] : [];
    w.postMessage({ ...msg, id }, transfer);
  });
}

async function runTimestamps(id, model) {
  leaveView();
  const lesson = await DB.getLesson(id);
  let cancelled = false;
  const steps = [
    { key: 'decode', label: 'Opening the recording' },
    { key: 'model', label: 'Getting the speech model ready' },
    { key: 'listen', label: 'Finding when each word was spoken' },
    { key: 'line', label: 'Lining the words up with your text' },
  ];
  const items = steps.map((s) => {
    const detail = h('div', { class: 'muted small' });
    const bar = h('div', { class: 'bar', hidden: true }, h('i'));
    const li = h('li', null, h('span', { class: 'tick', 'aria-hidden': 'true' }), h('div', null, h('div', null, s.label), detail, bar));
    return { ...s, li, detail, bar };
  });
  const errBox = h('div', { class: 'error', hidden: true });
  const started = Date.now();
  const elapsed = h('p', { class: 'muted small num' });
  const timer = setInterval(() => { elapsed.textContent = `Working for ${fmt((Date.now() - started) / 1000)}. Keep this screen open.`; }, 500);
  S.cleanup.push(() => clearInterval(timer));
  app.replaceChildren(
    h('div', { class: 'topbar' },
      h('button', { class: 'btn icon quiet', 'aria-label': 'Stop and go back', onclick: () => { cancelled = true; if (worker) { worker.terminate(); worker = null; } showHome(); } }, icon('left')),
      h('h1', null, lesson.title)),
    h('ul', { class: 'steps' }, items.map((i) => i.li)),
    h('div', { style: { marginTop: '24px' } }, elapsed),
    errBox);
  keepAwake(true);
  const set = (key, state, detail, frac) => {
    const it = items.find((i) => i.key === key);
    it.li.className = state;
    if (state === 'done') it.li.querySelector('.tick').textContent = '✓';
    if (detail != null) it.detail.textContent = detail;
    if (frac != null) { it.bar.hidden = false; it.bar.firstChild.style.width = `${Math.round(frac * 100)}%`; }
    else if (state === 'done') it.bar.hidden = true;
  };

  try {
    set('decode', 'now');
    const buffer = await decodeToMono(lesson.audio);
    const samples = await resampleTo16k(buffer);
    const pieces = splitForSpeech(samples);
    set('decode', 'done', `${fmt(buffer.duration)} of audio`);
    if (cancelled) return;

    set('model', 'now', 'Checking for a saved copy…');
    if (!window.__mockTranscribe) {
      await workerCall({ type: 'load', model }, (p) => {
        const mb = (n) => (n / 1048576).toFixed(0);
        set('model', 'now', `Downloading ${mb(p.loaded)} of ${mb(p.total)} MB`, p.loaded / p.total);
      });
    }
    set('model', 'done', 'Ready');
    if (cancelled) return;

    set('listen', 'now', `Part 1 of ${pieces.length}`, 0);
    const heard = [];
    for (let k = 0; k < pieces.length; k++) {
      const p = pieces[k];
      set('listen', 'now', `Part ${k + 1} of ${pieces.length}`, k / pieces.length);
      if (p.silent) continue;
      const words = window.__mockTranscribe
        ? await window.__mockTranscribe(p.s, p.e)
        : await workerCall({ type: 'transcribe', model, samples: samples.slice(p.start, p.end), offset: p.s });
      if (cancelled) return;
      for (const w of words) heard.push({ w: w.w, s: Math.max(p.s, w.s), e: Math.min(p.e, Math.max(w.e, w.s + 0.02)) });
    }
    heard.sort((a, b) => a.s - b.s);
    set('listen', 'done', `${heard.length} words heard`);

    set('line', 'now');
    const tokens = A.tokenizeScript(lesson.text);
    const { scriptToHeard } = A.timeScript(tokens, heard);
    const matched = Array.from(scriptToHeard).filter((x) => x >= 0).length;
    set('line', 'done', `${matched} of ${tokens.length} words from your text found`);

    lesson.heard = heard;
    lesson.duration = buffer.duration;
    lesson.model = model;
    lesson.cuts = A.normalizeCuts(lesson.cuts || [], buffer.duration);
    await DB.saveLesson(lesson);
    keepAwake(false);
    if (!cancelled) setTimeout(() => showEditor(lesson.id, buffer), 600);
  } catch (err) {
    keepAwake(false);
    clearInterval(timer);
    errBox.hidden = false;
    const msg = String(err && err.message || err);
    errBox.replaceChildren(
      h('p', null, /fetch|network|Failed to load|import/i.test(msg)
        ? 'The speech model could not be downloaded. Check your internet connection and try again.'
        : /decode|EncodingError|Unable to decode/i.test(msg)
          ? 'This recording could not be opened. Try a different file, such as MP3 or M4A.'
          : `Something stopped the timing: ${msg}`),
      h('div', { class: 'row', style: { marginTop: '10px' } },
        h('button', { class: 'btn', onclick: () => runTimestamps(id, model) }, 'Try again'),
        h('button', { class: 'btn quiet', onclick: showHome }, 'Back to lessons')));
  }
}

// ---------------------------------------------------------------- editor
async function showEditor(id, preDecoded) {
  leaveView();
  const lesson = await DB.getLesson(id);
  if (!lesson) return showHome();
  if (!lesson.heard) return runTimestamps(id, lesson.model || 'fast');
  S.lesson = lesson;
  S.history = [];
  S.sel = null;
  app.replaceChildren(h('p', { class: 'muted' }, 'Opening…'));
  S.buffer = preDecoded || await decodeToMono(lesson.audio);
  S.peaks = waveformPeaks(S.buffer, 50);
  lesson.cuts = A.normalizeCuts(lesson.cuts || [], S.buffer.duration);
  S.player.load(S.buffer, lesson.cuts);
  realign();
  buildEditor();
}

// works out which heard words are extra and which text words were missed
function realign() {
  const L = S.lesson;
  const kept = [];
  const keptIdx = [];
  L.heard.forEach((w, k) => { if (!A.isCut((w.s + w.e) / 2, L.cuts)) { kept.push(w); keptIdx.push(k); } });
  const tokens = A.tokenizeScript(L.text);
  const r = A.timeScript(tokens, kept);
  const extra = new Uint8Array(L.heard.length);
  r.heardToScript.forEach((s, i) => { if (s < 0) extra[keptIdx[i]] = 1; });
  // missed text words, grouped by the heard word they come after (-1 = start)
  const missedAfter = new Map();
  let lastHeard = -1;
  tokens.forEach((t, i) => {
    const m = r.scriptToHeard[i];
    if (m >= 0) lastHeard = keptIdx[m];
    else {
      if (!missedAfter.has(lastHeard)) missedAfter.set(lastHeard, []);
      missedAfter.get(lastHeard).push(t.display);
    }
  });
  S.flags = { extra, missedAfter, tokens, times: r.times, missedCount: tokens.length - Array.from(r.scriptToHeard).filter((x) => x >= 0).length };
}

let realignTimer = 0;
function scheduleRealign() {
  clearTimeout(realignTimer);
  realignTimer = setTimeout(() => { realign(); renderTranscript(); renderStats(); }, 350);
}

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => DB.saveLesson(S.lesson), 500);
}

function setCuts(next, label) {
  S.history.push(S.lesson.cuts.map((c) => ({ ...c })));
  if (S.history.length > 100) S.history.shift();
  S.lesson.cuts = A.normalizeCuts(next, S.buffer.duration);
  S.player.setCuts(S.lesson.cuts);
  saveSoon();
  renderTranscript(); drawWave(); renderStats(); renderActionBar(); tickEditor();
  undoBtn.disabled = false;
  if (label) toast(label);
  scheduleRealign();
}

let E = {}; // editor elements
let undoBtn;
function buildEditor() {
  const L = S.lesson;
  E = {};
  E.time = h('span', { class: 'time num' });
  E.play = h('button', { class: 'btn primary icon', 'aria-label': 'Play', onclick: togglePlay }, icon('play'));
  undoBtn = h('button', { class: 'btn', disabled: true, onclick: () => {
    const prev = S.history.pop();
    if (!prev) return;
    S.lesson.cuts = prev; S.player.setCuts(prev); saveSoon(); S.sel = null;
    renderTranscript(); drawWave(); renderStats(); renderActionBar(); scheduleRealign();
    undoBtn.disabled = !S.history.length;
    toast('Undone');
  } }, 'Undo');

  // waveform
  E.canvas = h('canvas', { 'aria-label': 'Recording timeline. Tap to move the play position.' });
  E.spacer = h('div', { style: { height: '1px' } });
  E.scroll = h('div', { class: 'wave-scroll' }, E.spacer);
  E.waveWrap = h('div', { class: 'wave-wrap' },
    h('div', { style: { position: 'relative' } }, E.scroll, E.canvas),
    h('div', { class: 'wave-tools' },
      h('button', { class: 'btn icon quiet', 'aria-label': 'Zoom out', onclick: () => zoom(0.5) }, icon('minus')),
      h('button', { class: 'btn icon quiet', 'aria-label': 'Zoom in', onclick: () => zoom(2) }, icon('plus')),
      h('span', { class: 'muted small' }, 'Tap the timeline to jump. Red stripes are cut.')));
  Object.assign(E.canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });
  E.scroll.style.height = '96px';
  E.zoom = 1;
  E.userScrollAt = 0;
  E.scroll.addEventListener('scroll', () => { drawWave(); }, { passive: true });
  E.scroll.addEventListener('pointerdown', () => { E.userScrollAt = performance.now(); });
  E.scroll.addEventListener('click', (e) => {
    const rect = E.scroll.getBoundingClientRect();
    const t = (E.scroll.scrollLeft + e.clientX - rect.left) / pps();
    const ci = L.cuts.findIndex((c) => t >= c.s && t < c.e);
    if (ci >= 0) { S.sel = { type: 'cut', index: ci }; renderTranscript(); renderActionBar(); }
    S.player.seek(t);
    tickEditor();
  });

  E.stats = h('div', { class: 'statline' });
  E.transcript = h('div', { class: 'transcript', role: 'list' });
  E.transcript.addEventListener('click', onTranscriptTap);
  E.action = h('div', { class: 'actionbar', hidden: true }, h('div', { class: 'inner' }));

  app.replaceChildren(
    h('div', { class: 'topbar', style: { marginBottom: '8px' } },
      h('button', { class: 'btn icon quiet', 'aria-label': 'Back to lessons', onclick: showHome }, icon('left')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn icon quiet', 'aria-label': 'Lesson options', onclick: lessonMenu }, icon('more')),
      h('button', { class: 'btn primary', onclick: openPlayer }, icon('play'), 'Play lesson')),
    h('h1', { class: 'lesson-title' }, L.title),
    E.stats,
    E.waveWrap,
    h('div', { class: 'transport' },
      E.play,
      h('button', { class: 'btn icon', 'aria-label': 'Back 5 seconds', onclick: () => { S.player.seek(S.player.currentTime() - 5); tickEditor(); } }, icon('back')),
      E.time,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: shortenPauses }, 'Shorten long pauses'),
      undoBtn),
    h('div', { class: 'legend' },
      h('span', null, h('i', { style: { background: 'var(--flag)' } }), 'Not in your text (repeats, slips)'),
      h('span', null, h('i', { style: { border: '1.5px dashed var(--ink-soft)' } }), 'In your text, not heard'),
      h('span', null, h('i', { style: { border: '1.5px dotted var(--flag)' } }), 'Long pause')),
    h('p', { class: 'muted small', style: { marginTop: '8px' } }, 'Tap a word, then tap another to select everything between. Then choose Cut.'),
    E.transcript,
    E.action,
  );

  const ro = new ResizeObserver(() => layoutWave());
  ro.observe(E.waveWrap);
  S.cleanup.push(() => ro.disconnect());
  const onKey = (e) => {
    if (e.target.closest && e.target.closest('input, textarea')) return;
    if (document.querySelector('.player, .scrim')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  };
  document.addEventListener('keydown', onKey);
  S.cleanup.push(() => document.removeEventListener('keydown', onKey));
  S.player.onEnded = () => { updatePlayBtn(); tickEditor(); };

  layoutWave();
  renderStats();
  renderTranscript();
  tickEditor();
}

function renderStats() {
  if (!E.stats) return;
  const L = S.lesson;
  const extraCount = S.flags ? S.flags.extra.reduce((x, v) => x + v, 0) : 0;
  const missed = S.flags ? S.flags.missedCount : 0;
  const removed = L.cuts.reduce((x, c) => x + c.e - c.s, 0);
  E.stats.replaceChildren(
    h('span', { class: 'chip num', title: 'Length after cuts' }, `${fmt(L.duration - removed)} long`, removed > 0.05 ? h('span', { class: 'muted' }, ` (${secs(removed)} cut)`) : null),
    h('button', { class: 'chip flag', disabled: !extraCount, onclick: () => jumpTo('.w.extra') }, `${extraCount} not in text`),
    h('button', { class: 'chip miss', disabled: !missed, onclick: () => jumpTo('.missed') }, `${missed} not heard`),
  );
}

let jumpIndex = 0;
function jumpTo(selector) {
  const els = [...E.transcript.querySelectorAll(selector)].filter((el) => !el.classList.contains('cut'));
  if (!els.length) return;
  const el = els[jumpIndex++ % els.length];
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (el.dataset.k != null) { const k = +el.dataset.k; S.sel = { type: 'words', a: k, b: k }; renderTranscript(); renderActionBar(); }
}

function wordIsCut(k) { const w = S.lesson.heard[k]; return A.isCut((w.s + w.e) / 2, S.lesson.cuts); }

function renderTranscript() {
  if (!E.transcript) return;
  const L = S.lesson;
  const H = L.heard;
  const frag = document.createDocumentFragment();
  const sel = S.sel;
  const lo = sel && sel.type === 'words' ? Math.min(sel.a, sel.b) : -1;
  const hi = sel && sel.type === 'words' ? Math.max(sel.a, sel.b) : -1;
  const selCut = sel && sel.type === 'cut' ? L.cuts[sel.index] : null;
  const missed = S.flags ? S.flags.missedAfter : new Map();
  const addMissed = (k) => {
    const list = missed.get(k);
    if (list && list.length) {
      frag.append(h('span', { class: 'missed', title: 'In your text, but not heard in the recording' }, 'not heard: ', h('b', null, list.slice(0, 8).join(' ') + (list.length > 8 ? ' …' : ''))), ' ');
    }
  };
  addMissed(-1);
  const lead = H.length ? H[0].s : 0;
  if (lead >= 0.8) frag.append(pauseChip(-1, 0, lead), ' ');
  for (let k = 0; k < H.length; k++) {
    const w = H[k];
    const cut = wordIsCut(k);
    let cls = 'w';
    if (S.flags && S.flags.extra[k] && !cut) cls += ' extra';
    if (cut) cls += ' cut';
    if (k >= lo && k <= hi) cls += ' sel';
    if (selCut && cut && (w.s + w.e) / 2 >= selCut.s && (w.s + w.e) / 2 < selCut.e) cls += ' sel';
    frag.append(h('span', { class: cls, 'data-k': k, role: 'listitem' }, w.w), ' ');
    addMissed(k);
    if (k < H.length - 1) {
      const gapS = w.e, gapE = H[k + 1].s;
      const eff = A.toEdited(gapE, L.cuts) - A.toEdited(gapS, L.cuts);
      if (eff >= 0.8) frag.append(pauseChip(k, gapS, gapE, eff), ' ');
    }
  }
  E.transcript.replaceChildren(frag);
  E.nowEl = null;
}

function pauseChip(k, s, e, eff = e - s) {
  const isSel = S.sel && S.sel.type === 'pause' && S.sel.k === k;
  return h('span', { class: 'pause' + (eff >= 1.5 ? ' long' : '') + (isSel ? ' sel' : ''), 'data-pause': k, 'data-s': s, 'data-e': e, title: 'Pause' }, secs(eff));
}

function onTranscriptTap(e) {
  const pauseEl = e.target.closest('.pause');
  if (pauseEl) {
    const k = +pauseEl.dataset.pause;
    S.sel = S.sel && S.sel.type === 'pause' && S.sel.k === k ? null : { type: 'pause', k, s: +pauseEl.dataset.s, e: +pauseEl.dataset.e };
    renderTranscript(); renderActionBar();
    return;
  }
  const wEl = e.target.closest('.w');
  if (!wEl) return;
  const k = +wEl.dataset.k;
  if (wordIsCut(k)) {
    const w = S.lesson.heard[k];
    const ci = S.lesson.cuts.findIndex((c) => (w.s + w.e) / 2 >= c.s && (w.s + w.e) / 2 < c.e);
    S.sel = S.sel && S.sel.type === 'cut' && S.sel.index === ci ? null : { type: 'cut', index: ci };
  } else if (S.sel && S.sel.type === 'words' && S.sel.a === S.sel.b) {
    if (S.sel.a === k) S.sel = null;
    else {
      // do not stretch a selection across words that are already cut
      S.sel = { type: 'words', a: S.sel.a, b: k };
    }
  } else {
    S.sel = { type: 'words', a: k, b: k };
  }
  renderTranscript(); renderActionBar(); drawWave();
}

function selectionRange() {
  const sel = S.sel;
  const H = S.lesson.heard;
  if (!sel) return null;
  if (sel.type === 'words') return A.cutRangeForWords(H, sel.a, sel.b, S.lesson.duration);
  if (sel.type === 'cut') return S.lesson.cuts[sel.index] || null;
  if (sel.type === 'pause') return { s: sel.s, e: sel.e };
  return null;
}

function renderActionBar() {
  const bar = E.action;
  if (!bar) return;
  const inner = bar.firstChild;
  const sel = S.sel;
  const L = S.lesson;
  if (!sel || (sel.type === 'cut' && !L.cuts[sel.index])) { bar.hidden = true; S.sel = null; return; }
  bar.hidden = false;
  const done = h('button', { class: 'btn quiet', onclick: () => { S.sel = null; renderTranscript(); renderActionBar(); drawWave(); } }, 'Done');
  if (sel.type === 'words') {
    const lo = Math.min(sel.a, sel.b), hi = Math.max(sel.a, sel.b);
    const r = A.cutRangeForWords(L.heard, lo, hi, L.duration);
    const n = hi - lo + 1;
    inner.replaceChildren(
      h('div', { class: 'row' }, h('strong', null, n === 1 ? '1 word selected' : `${n} words selected`), h('span', { class: 'muted small num' }, secs(r.e - r.s)),
        n === 1 ? h('span', { class: 'muted small' }, 'Tap another word to select a stretch.') : null),
      h('div', { class: 'row' },
        h('button', { class: 'btn danger solid', onclick: () => { setCuts([...L.cuts, r], n === 1 ? 'Cut 1 word' : `Cut ${n} words`); S.sel = null; renderTranscript(); renderActionBar(); } }, 'Cut'),
        h('button', { class: 'btn', onclick: () => { S.player.play(Math.max(0, r.s - 1), r.e + 1); updatePlayBtn(); loopEditor(); } }, 'Listen'),
        h('button', { class: 'btn', onclick: () => { S.player.seek(L.heard[lo].s); if (!S.player.playing) S.player.play(L.heard[lo].s); updatePlayBtn(); loopEditor(); } }, 'Play from here'),
        done));
  } else if (sel.type === 'cut') {
    const c = L.cuts[sel.index];
    const nudge = (which, d) => {
      const next = L.cuts.map((x) => ({ ...x }));
      next[sel.index][which] = Math.max(0, Math.min(L.duration, next[sel.index][which] + d));
      if (next[sel.index].e - next[sel.index].s < 0.02) return;
      const keepS = next[sel.index].s;
      setCuts(next);
      S.sel = { type: 'cut', index: Math.max(0, L.cuts.findIndex((x) => Math.abs(x.s - keepS) < 0.0011 || (keepS >= x.s && keepS <= x.e))) };
      renderTranscript(); renderActionBar(); drawWave();
    };
    inner.replaceChildren(
      h('div', { class: 'row' }, h('strong', null, 'Cut part'), h('span', { class: 'muted small num' }, `${secs(c.e - c.s)} removed, at ${fmt(c.s)}`)),
      h('div', { class: 'row' },
        h('span', { class: 'nudge' }, h('span', { class: 'small muted' }, 'Start'),
          h('button', { class: 'btn icon', 'aria-label': 'Move start earlier', onclick: () => nudge('s', -0.05) }, icon('left')),
          h('button', { class: 'btn icon', 'aria-label': 'Move start later', onclick: () => nudge('s', 0.05) }, icon('right'))),
        h('span', { class: 'nudge' }, h('span', { class: 'small muted' }, 'End'),
          h('button', { class: 'btn icon', 'aria-label': 'Move end earlier', onclick: () => nudge('e', -0.05) }, icon('left')),
          h('button', { class: 'btn icon', 'aria-label': 'Move end later', onclick: () => nudge('e', 0.05) }, icon('right')))),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { S.player.play(Math.max(0, c.s - 2), c.e + 2); updatePlayBtn(); loopEditor(); } }, 'Listen across the cut'),
        h('button', { class: 'btn', onclick: () => { const next = L.cuts.filter((_, i) => i !== sel.index); S.sel = null; setCuts(next, 'Restored'); } }, 'Restore'),
        done));
  } else if (sel.type === 'pause') {
    const len = A.toEdited(sel.e, L.cuts) - A.toEdited(sel.s, L.cuts);
    const shorten = (keep) => {
      const c = A.cutForPause({ after: sel.k, s: sel.s, e: sel.e }, keep + (sel.e - sel.s - len));
      S.sel = null;
      if (c) setCuts([...L.cuts, c], `Pause shortened to ${secs(keep)}`);
      else { renderTranscript(); renderActionBar(); }
    };
    inner.replaceChildren(
      h('div', { class: 'row' }, h('strong', null, 'Pause'), h('span', { class: 'muted small num' }, secs(len))),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => shorten(0.6) }, 'Shorten to 0.6 s'),
        h('button', { class: 'btn', onclick: () => shorten(0.25) }, 'Almost remove'),
        h('button', { class: 'btn', onclick: () => { S.player.play(Math.max(0, sel.s - 1.5), sel.e + 1.5); updatePlayBtn(); loopEditor(); } }, 'Listen'),
        done));
  }
}

function shortenPauses() {
  const L = S.lesson;
  const H = L.heard;
  const next = [...L.cuts];
  let count = 0;
  // ignore cut words when measuring gaps
  const kept = H.filter((w) => !A.isCut((w.s + w.e) / 2, L.cuts));
  if (!kept.length) return;
  if (kept[0].s > 0.6) { next.push({ s: 0, e: kept[0].s - 0.3 }); count++; }
  for (let i = 0; i < kept.length - 1; i++) {
    const s = kept[i].e, e = kept[i + 1].s;
    const eff = A.toEdited(e, L.cuts) - A.toEdited(s, L.cuts);
    if (eff >= 1.2) {
      const c = A.cutForPause({ after: i, s, e }, 0.6 + (e - s - eff));
      if (c) { next.push(c); count++; }
    }
  }
  const tail = L.duration - kept[kept.length - 1].e;
  if (tail > 1) { next.push({ s: kept[kept.length - 1].e + 0.6, e: L.duration }); count++; }
  if (!count) { toast('No pauses longer than 1.2 s'); return; }
  setCuts(next, count === 1 ? 'Shortened 1 pause' : `Shortened ${count} pauses`);
}

// ---- waveform drawing
function pps() { return Math.max(0.5, (E.scroll.clientWidth / Math.max(1, S.lesson.duration)) * E.zoom); }
function layoutWave() {
  if (!E.scroll) return;
  E.spacer.style.width = `${Math.max(E.scroll.clientWidth, Math.ceil(S.lesson.duration * pps()))}px`;
  drawWave();
}
function zoom(f) {
  const center = (E.scroll.scrollLeft + E.scroll.clientWidth / 2) / pps();
  E.zoom = Math.max(1, Math.min(64, E.zoom * f));
  layoutWave();
  E.scroll.scrollLeft = center * pps() - E.scroll.clientWidth / 2;
  drawWave();
}
function drawWave() {
  if (!E.canvas || !S.peaks) return;
  const cv = E.canvas;
  const w = E.scroll.clientWidth, hgt = 96;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(w * dpr) || cv.height !== hgt * dpr) {
    cv.width = Math.round(w * dpr); cv.height = hgt * dpr; cv.style.width = `${w}px`; cv.style.height = `${hgt}px`;
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  const p = pps();
  const x0 = E.scroll.scrollLeft;
  const tAt = (x) => (x0 + x) / p;
  const xAt = (t) => t * p - x0;
  const L = S.lesson;
  const mid = 52;

  // cut regions
  ctx.fillStyle = col('--cut-soft');
  for (const c of L.cuts) {
    const a = xAt(c.s), b = xAt(c.e);
    if (b < 0 || a > w) continue;
    ctx.fillRect(a, 16, Math.max(1, b - a), hgt - 16);
  }
  // selection
  const r = selectionRange();
  if (r) {
    ctx.globalAlpha = 0.22; ctx.fillStyle = col('--accent');
    ctx.fillRect(xAt(r.s), 16, Math.max(2, xAt(r.e) - xAt(r.s)), hgt - 16);
    ctx.globalAlpha = 1;
  }
  // bars
  const kept = col('--wave-kept'), gone = col('--cut');
  for (let x = 0; x < w; x += 2) {
    const t0 = tAt(x), t1 = tAt(x + 2);
    const i0 = Math.max(0, Math.floor(t0 * 50)), i1 = Math.min(S.peaks.length, Math.ceil(t1 * 50));
    let v = 0;
    for (let i = i0; i < i1; i++) v = Math.max(v, S.peaks[i]);
    if (i1 <= i0 && i0 < S.peaks.length) v = S.peaks[i0];
    const bh = Math.max(1, v * 34);
    const cut = A.isCut((t0 + t1) / 2, L.cuts);
    ctx.fillStyle = cut ? gone : kept;
    ctx.globalAlpha = cut ? 0.45 : 1;
    ctx.fillRect(x, mid - bh, 1.4, bh * 2);
  }
  ctx.globalAlpha = 1;
  // cut edges
  ctx.strokeStyle = gone; ctx.lineWidth = 1.5;
  for (const c of L.cuts) {
    for (const t of [c.s, c.e]) { const x = xAt(t); if (x >= -2 && x <= w + 2) { ctx.beginPath(); ctx.moveTo(x, 16); ctx.lineTo(x, hgt); ctx.stroke(); } }
  }
  // time ticks
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s * p >= 56) || 600;
  ctx.fillStyle = col('--ink-soft');
  ctx.font = '10px Lexend, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  for (let t = Math.floor(tAt(0) / step) * step; t <= tAt(w); t += step) {
    const x = xAt(t);
    if (x < -30) continue;
    ctx.fillRect(x, 0, 1, 5);
    ctx.fillText(fmt(t), x + 3, 3);
  }
  // playhead
  const ph = xAt(S.player.currentTime());
  if (ph >= -2 && ph <= w + 2) {
    ctx.fillStyle = col('--ink');
    ctx.fillRect(ph - 1, 14, 2, hgt - 14);
  }
}

// ---- editor playback
function togglePlay() {
  if (S.player.playing) S.player.pause();
  else S.player.play();
  updatePlayBtn();
  loopEditor();
}
function updatePlayBtn() {
  if (!E.play) return;
  E.play.replaceChildren(icon(S.player.playing ? 'pause' : 'play'));
  E.play.setAttribute('aria-label', S.player.playing ? 'Pause' : 'Play');
}
let editorRaf = 0;
function loopEditor() {
  cancelAnimationFrame(editorRaf);
  const step = () => {
    tickEditor();
    if (S.player.playing) editorRaf = requestAnimationFrame(step);
    else updatePlayBtn();
  };
  step();
}
function tickEditor() {
  if (!E.time || !S.lesson) return;
  const L = S.lesson;
  const t = S.player.currentTime();
  E.time.textContent = `${fmt(A.toEdited(t, L.cuts))} / ${fmt(A.editedDuration(L.duration, L.cuts))}`;
  // keep the playhead in view while playing
  if (S.player.playing && performance.now() - E.userScrollAt > 3000) {
    const x = t * pps() - E.scroll.scrollLeft;
    if (x < 0 || x > E.scroll.clientWidth * 0.85) E.scroll.scrollLeft = t * pps() - E.scroll.clientWidth * 0.2;
  }
  drawWave();
  // highlight the word being spoken
  const H = L.heard;
  let lo = 0, hi = H.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (H[m].s <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  if (k >= 0 && t > H[k].e + 0.25) k = -1;
  if (!S.player.playing) k = -1;
  const el = k >= 0 ? E.transcript.querySelector(`.w[data-k="${k}"]`) : null;
  if (el !== E.nowEl) {
    if (E.nowEl) E.nowEl.classList.remove('now');
    if (el) {
      el.classList.add('now');
      const r = el.getBoundingClientRect();
      if (r.top < 80 || r.bottom > window.innerHeight - 160) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    E.nowEl = el;
  }
}

// ---- lesson menu
function lessonMenu() {
  const L = S.lesson;
  openSheet((sheet, close) => {
    const confirmRow = h('div', { class: 'row', hidden: true },
      h('span', null, 'Delete this lesson from this device?'),
      h('button', { class: 'btn danger solid', onclick: async () => { await DB.deleteLesson(L.id); close(); toast('Lesson deleted'); showHome(); } }, 'Delete'),
      h('button', { class: 'btn quiet', onclick: () => { confirmRow.hidden = true; } }, 'Keep it'));
    sheet.append(
      h('h2', null, L.title),
      h('button', { class: 'btn', onclick: () => { close(); renameLesson(); } }, 'Rename'),
      h('button', { class: 'btn', onclick: () => { close(); editText(); } }, 'Fix the lesson text'),
      h('button', { class: 'btn', onclick: async () => { close(); download(await DB.lessonToFile(L), `${slug(L.title)}.readalong`); toast('Saved lesson file'); } }, 'Save lesson file (to open on another device)'),
      h('button', { class: 'btn', onclick: async () => {
        close(); toast('Preparing audio…');
        const out = await renderEdited(S.buffer, L.cuts);
        download(encodeWav(out), `${slug(L.title)}-edited.wav`);
      } }, 'Save edited audio (WAV)'),
      h('button', { class: 'btn', onclick: () => { close(); redoTiming(); } }, 'Redo word timing'),
      h('button', { class: 'btn danger', onclick: () => { confirmRow.hidden = false; } }, 'Delete lesson'),
      confirmRow,
      h('button', { class: 'btn quiet', onclick: close }, 'Close'));
  });
}

function renameLesson() {
  const L = S.lesson;
  openSheet((sheet, close) => {
    const input = h('input', { type: 'text', id: 'rename', value: L.title });
    sheet.append(h('h2', null, 'Rename lesson'), h('label', { class: 'field', for: 'rename' }, 'Lesson name', input),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => { L.title = input.value.trim() || L.title; await DB.saveLesson(L); close(); buildEditor(); toast('Renamed'); } }, 'Save name'),
        h('button', { class: 'btn quiet', onclick: close }, 'Cancel')));
  });
}

function editText() {
  const L = S.lesson;
  openSheet((sheet, close) => {
    const ta = h('textarea', { id: 'fixtext', style: { minHeight: '45vh' } });
    ta.value = L.text;
    sheet.append(h('h2', null, 'Fix the lesson text'),
      h('p', { class: 'muted small' }, 'Change the text students see. Your recording and cuts stay the same.'),
      ta,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => { L.text = ta.value.trim(); await DB.saveLesson(L); close(); realign(); renderTranscript(); renderStats(); toast('Text saved'); } }, 'Save text'),
        h('button', { class: 'btn quiet', onclick: close }, 'Cancel')));
  });
}

function redoTiming() {
  const L = S.lesson;
  openSheet((sheet, close) => {
    sheet.append(h('h2', null, 'Redo word timing'),
      h('p', { class: 'muted small' }, 'Listens to the recording again. Your cuts are kept. Try Careful if many words were missed.'),
      h('button', { class: 'btn', onclick: () => { close(); runTimestamps(L.id, 'fast'); } }, 'Quick'),
      h('button', { class: 'btn', onclick: () => { close(); runTimestamps(L.id, 'accurate'); } }, 'Careful (larger download)'),
      h('button', { class: 'btn quiet', onclick: close }, 'Cancel'));
  });
}

// ---------------------------------------------------------------- lesson player
function openPlayer() {
  const L = S.lesson;
  if (!L || !S.buffer) return;
  S.player.pause();
  S.sel = null;
  if (E.action) E.action.hidden = true;
  realign();
  const tokens = S.flags.tokens;
  // word times on the edited timeline
  const starts = S.flags.times.map((t) => A.toEdited(t.s, L.cuts));
  const view = L.view || (L.view = { mode: 'word', scale: 1, theme: 'auto' });

  const textEl = h('div', { class: `stage-text mode-${view.mode}` });
  textEl.style.setProperty('--scale', view.scale);
  const spans = [];
  let para = null, paraIdx = -1;
  tokens.forEach((t, i) => {
    if (t.para !== paraIdx) { para = h('p'); textEl.append(para); paraIdx = t.para; }
    const s = h('span', { class: 't', 'data-i': i }, t.display);
    spans.push(s);
    para.append(s, ' ');
  });
  const stage = h('div', { class: 'stage' }, textEl);
  const playBtn = h('button', { class: 'btn primary play-big', 'aria-label': 'Play' }, icon('play'));
  const scrub = h('input', { type: 'range', class: 'scrub', min: 0, max: 1000, value: 0, 'aria-label': 'Position in lesson' });
  const time = h('span', { class: 'num muted small' });
  const modeBtns = ['word', 'sentence', 'off'].map((m) => h('button', { 'aria-pressed': String(view.mode === m), onclick: () => setMode(m) }, { word: 'Word', sentence: 'Sentence', off: 'None' }[m]));
  const themeBtn = h('button', { class: 'btn', onclick: () => cycleTheme() });
  const root = h('div', { class: 'player', role: 'dialog', 'aria-label': `${L.title}, read-along` },
    h('div', { class: 'player-top' },
      h('button', { class: 'btn icon quiet', 'aria-label': 'Close player', onclick: () => close() }, icon('close')),
      h('div', { class: 'player-title' }, L.title),
      h('span', { class: 'small muted label' }, 'Highlight'),
      h('div', { class: 'seg' }, modeBtns),
      h('button', { class: 'btn icon', 'aria-label': 'Smaller text', onclick: () => setScale(-0.1) }, 'A−'),
      h('button', { class: 'btn icon', 'aria-label': 'Larger text', onclick: () => setScale(0.1) }, 'A+'),
      themeBtn,
      document.fullscreenEnabled ? h('button', { class: 'btn icon', 'aria-label': 'Full screen', onclick: () => toggleFull() }, icon('full')) : null),
    stage,
    h('div', { class: 'player-bottom' },
      playBtn,
      h('button', { class: 'btn icon', 'aria-label': 'Back 5 seconds', onclick: () => { S.player.seekEdited(Math.max(0, S.player.editedTime() - 5)); tick(true); } }, icon('back')),
      scrub, time));
  layer.append(root);

  function applyTheme() {
    root.classList.toggle('dark-stage', view.theme === 'dark');
    root.classList.toggle('light-stage', view.theme === 'light');
    themeBtn.textContent = { auto: 'Theme: auto', light: 'Light', dark: 'Dark' }[view.theme];
  }
  function cycleTheme() { view.theme = { auto: 'dark', dark: 'light', light: 'auto' }[view.theme]; applyTheme(); saveSoon(); }
  function setMode(m) {
    view.mode = m;
    textEl.className = `stage-text mode-${m}`;
    modeBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(['word', 'sentence', 'off'][i] === m)));
    lastSentence = -2; tick(true); saveSoon();
  }
  function setScale(d) { view.scale = Math.max(0.6, Math.min(2.2, +(view.scale + d).toFixed(2))); textEl.style.setProperty('--scale', view.scale); saveSoon(); }
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else root.requestFullscreen().catch(() => {});
  }
  applyTheme();

  let raf = 0, current = -1, lastSentence = -2, userScrollAt = 0, idleTimer = 0;
  const total = S.player.editedDuration();
  function indexAt(t) {
    let lo = 0, hi = starts.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (starts[m] <= t + 0.03) { k = m; lo = m + 1; } else hi = m - 1; }
    return k;
  }
  function tick(force) {
    const t = S.player.editedTime();
    if (!scrub.matches(':active')) scrub.value = String(Math.round((t / Math.max(0.01, total)) * 1000));
    time.textContent = `${fmt(t)} / ${fmt(total)}`;
    const started = S.player.playing || t > 0.05;
    const k = started ? indexAt(t) : -1;
    if (k !== current || force) {
      if (current >= 0 && spans[current]) spans[current].classList.remove('now');
      current = k;
      if (k >= 0 && view.mode !== 'off') spans[k].classList.add('now');
      const sentence = k >= 0 && view.mode === 'sentence' ? tokens[k].sentence : -1;
      if (sentence !== lastSentence) {
        spans.forEach((sp, i) => sp.classList.toggle('sent', sentence >= 0 && tokens[i].sentence === sentence));
        lastSentence = sentence;
      }
      if (k >= 0 && performance.now() - userScrollAt > 4000) {
        const r = spans[k].getBoundingClientRect();
        const sr = stage.getBoundingClientRect();
        if (r.top < sr.top + sr.height * 0.18 || r.bottom > sr.top + sr.height * 0.62) {
          stage.scrollTop += r.top - (sr.top + sr.height * 0.33);
        }
      }
    }
  }
  function loop() { tick(); if (S.player.playing) raf = requestAnimationFrame(loop); else { playBtn.replaceChildren(icon('play')); playBtn.setAttribute('aria-label', 'Play'); } }
  function play() {
    if (S.player.playing) { S.player.pause(); keepAwake(false); root.classList.remove('idle'); }
    else { if (S.player.editedTime() >= total - 0.05) S.player.seekEdited(0); S.player.play(); keepAwake(true); scheduleIdle(); }
    playBtn.replaceChildren(icon(S.player.playing ? 'pause' : 'play'));
    playBtn.setAttribute('aria-label', S.player.playing ? 'Pause' : 'Play');
    cancelAnimationFrame(raf); loop();
  }
  function scheduleIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (S.player.playing) root.classList.add('idle'); }, 3500); }
  playBtn.addEventListener('click', play);
  scrub.addEventListener('input', () => { S.player.seekEdited((+scrub.value / 1000) * total); tick(true); });
  stage.addEventListener('wheel', () => { userScrollAt = performance.now(); }, { passive: true });
  stage.addEventListener('touchmove', () => { userScrollAt = performance.now(); }, { passive: true });
  stage.addEventListener('click', (e) => {
    const sp = e.target.closest('.t');
    if (root.classList.contains('idle')) { root.classList.remove('idle'); scheduleIdle(); return; }
    if (sp) { S.player.seekEdited(starts[+sp.dataset.i]); userScrollAt = 0; tick(true); }
  });
  root.addEventListener('pointermove', () => { if (root.classList.contains('idle')) { root.classList.remove('idle'); scheduleIdle(); } });
  const onKey = (e) => {
    if (e.code === 'Space') { e.preventDefault(); play(); }
    else if (e.key === 'ArrowLeft') { S.player.seekEdited(Math.max(0, S.player.editedTime() - 5)); tick(true); }
    else if (e.key === 'ArrowRight') { S.player.seekEdited(Math.min(total, S.player.editedTime() + 5)); tick(true); }
    else if (e.key === 'Escape' && !document.fullscreenElement) close();
  };
  document.addEventListener('keydown', onKey);
  const prevEnded = S.player.onEnded;
  S.player.onEnded = () => { root.classList.remove('idle'); keepAwake(false); tick(true); };
  S.player.seekEdited(0);
  tick(true);

  function close() {
    S.player.pause();
    cancelAnimationFrame(raf); clearTimeout(idleTimer);
    document.removeEventListener('keydown', onKey);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    S.player.onEnded = prevEnded;
    keepAwake(false);
    root.remove();
    updatePlayBtn(); tickEditor();
  }
}

// ---------------------------------------------------------------- start
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.player.playing) keepAwake(true); });
window.__readAlong = { S, DB, A };
showHome();
