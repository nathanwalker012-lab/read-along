// Lines up the words of the lesson text with the words heard in the recording.
// Pure functions only, so they can be tested outside the browser.

const QUOTE_MAP = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '′': "'" };

export function normalizeWord(raw) {
  let s = String(raw).toLowerCase();
  s = s.replace(/[‘’‚‛“”′]/g, (c) => QUOTE_MAP[c] || '');
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  // keep letters, digits and inner apostrophes
  s = s.replace(/[^a-z0-9']+/g, '');
  s = s.replace(/^'+|'+$/g, '');
  return s;
}

const SENTENCE_END = /[.!?]["'”’)\]]*$/;

// Splits the lesson text into tokens the player can show and highlight.
// Each token keeps its original spelling and punctuation for display.
export function tokenizeScript(text) {
  const tokens = [];
  const paragraphs = String(text).replace(/\r\n?/g, '\n').split(/\n\s*\n|\n/);
  let sentence = 0;
  let para = 0;
  for (const p of paragraphs) {
    const pieces = p.split(/\s+/).filter(Boolean);
    if (!pieces.length) continue;
    for (const piece of pieces) {
      const norm = normalizeWord(piece);
      if (!norm && tokens.length && tokens[tokens.length - 1].para === para) {
        // stray punctuation such as a dash: attach it to the previous word
        tokens[tokens.length - 1].display += ' ' + piece;
        if (SENTENCE_END.test(piece)) sentence++;
        continue;
      }
      tokens.push({ display: piece, norm, para, sentence });
      if (SENTENCE_END.test(piece)) sentence++;
    }
    para++;
    // a paragraph break always ends a sentence
    if (tokens.length && tokens[tokens.length - 1].sentence === sentence) sentence++;
  }
  return tokens;
}

// Edit-distance similarity between two short strings, 0..1
export function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > Math.max(n, m) * 0.6) return 0;
  let prev = new Array(m + 1), cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[m] / Math.max(n, m);
}

const MATCH_MIN = 0.55;
const GAP = -1;

// Global alignment of script tokens (a) to heard words (b), banded around the
// diagonal so long stories stay fast on a phone.
// Returns pairs: array over script tokens with the matched heard index or -1.
export function alignSequences(a, b) {
  const n = a.length, m = b.length;
  const scriptToHeard = new Int32Array(n).fill(-1);
  const heardToScript = new Int32Array(m).fill(-1);
  if (!n || !m) return { scriptToHeard, heardToScript };

  const W = Math.min(Math.max(n, m), Math.max(250, Math.ceil(0.15 * Math.max(n, m))) + Math.abs(n - m));
  const width = 2 * W + 1;
  const center = (i) => Math.round((i * m) / n);
  const NEG = -1e9;
  const score = new Float32Array((n + 1) * width).fill(NEG);
  const trace = new Uint8Array((n + 1) * width); // 1 diag, 2 up (skip script), 3 left (skip heard)
  const idx = (i, j) => {
    const k = j - center(i) + W;
    return k < 0 || k >= width ? -1 : i * width + k;
  };
  // words become small integers so the inner loop compares numbers
  const vocab = new Map();
  const id = (w) => { let k = vocab.get(w); if (k === undefined) { k = vocab.size; vocab.set(w, k); } return k; };
  const ai = Int32Array.from(a, id), bi = Int32Array.from(b, id);
  const words = [...vocab.keys()];
  const simCache = new Map();
  const sim = (i, j) => {
    const x = ai[i], y = bi[j];
    if (x === y) return 1;
    const key = x * 1048576 + y;
    let v = simCache.get(key);
    if (v === undefined) { v = similarity(words[x], words[y]); simCache.set(key, v); }
    return v;
  };

  for (let i = 0; i <= n; i++) {
    const lo = Math.max(0, center(i) - W), hi = Math.min(m, center(i) + W);
    for (let j = lo; j <= hi; j++) {
      const here = idx(i, j);
      if (i === 0 && j === 0) { score[here] = 0; continue; }
      let best = NEG, from = 0;
      if (i > 0 && j > 0) {
        const p = idx(i - 1, j - 1);
        if (p >= 0 && score[p] > NEG) {
          const s = sim(i - 1, j - 1);
          const v = score[p] + (s >= MATCH_MIN ? 2 * s : -1.5);
          if (v > best) { best = v; from = 1; }
        }
      }
      if (i > 0) {
        const p = idx(i - 1, j);
        if (p >= 0 && score[p] > NEG) {
          const v = score[p] + GAP;
          if (v > best) { best = v; from = 2; }
        }
      }
      if (j > 0) {
        const p = idx(i, j - 1);
        // on ties keep the match, so a repeated take lines up with the later attempt
        if (p >= 0 && score[p] > NEG) {
          const v = score[p] + GAP;
          if (v > best) { best = v; from = 3; }
        }
      }
      score[here] = best;
      trace[here] = from;
    }
  }

  let i = n, j = m;
  if (idx(i, j) < 0) return fallbackProportional(n, m, scriptToHeard, heardToScript);
  while (i > 0 || j > 0) {
    const here = idx(i, j);
    if (here < 0) break;
    const t = trace[here];
    if (t === 1) {
      if (sim(i - 1, j - 1) >= MATCH_MIN) { scriptToHeard[i - 1] = j - 1; heardToScript[j - 1] = i - 1; }
      i--; j--;
    } else if (t === 2) i--;
    else if (t === 3) j--;
    else break;
  }
  return { scriptToHeard, heardToScript };
}

function fallbackProportional(n, m, s2h, h2s) {
  for (let i = 0; i < n; i++) { const j = Math.min(m - 1, Math.round((i * m) / n)); s2h[i] = j; h2s[j] = i; }
  return { scriptToHeard: s2h, heardToScript: h2s };
}

// Gives every script token a start and end time.
// heard: [{w, s, e}] in playback order (already excluding cut words)
export function timeScript(tokens, heard) {
  const a = tokens.map((t) => t.norm);
  const b = heard.map((h) => normalizeWord(h.w));
  const { scriptToHeard, heardToScript } = alignSequences(a, b);
  const times = tokens.map((t, i) => {
    const h = scriptToHeard[i];
    return h >= 0 ? { s: heard[h].s, e: heard[h].e, matched: true } : { s: NaN, e: NaN, matched: false };
  });
  // fill the gaps by spreading unmatched words between their matched neighbours
  const first = heard.length ? heard[0].s : 0;
  const last = heard.length ? heard[heard.length - 1].e : 0;
  let i = 0;
  while (i < times.length) {
    if (times[i].matched) { i++; continue; }
    let j = i;
    while (j < times.length && !times[j].matched) j++;
    const start = i > 0 ? times[i - 1].e : first;
    const end = j < times.length ? times[j].s : last;
    const span = Math.max(0, end - start);
    const weights = [];
    for (let k = i; k < j; k++) weights.push(Math.max(1, tokens[k].display.length));
    const total = weights.reduce((x, y) => x + y, 0);
    let t = start;
    for (let k = i; k < j; k++) {
      const d = (span * weights[k - i]) / total;
      times[k].s = t; times[k].e = t + d; t += d;
    }
    i = j;
  }
  return { times, scriptToHeard, heardToScript };
}

// ---- cuts ----------------------------------------------------------------

// Keeps cut list sorted and merged.
export function normalizeCuts(cuts, duration) {
  const list = cuts
    .map((c) => ({ s: Math.max(0, Math.min(c.s, c.e)), e: Math.min(duration, Math.max(c.s, c.e)) }))
    .filter((c) => c.e - c.s > 0.005)
    .sort((x, y) => x.s - y.s);
  const out = [];
  for (const c of list) {
    const last = out[out.length - 1];
    if (last && c.s <= last.e + 0.001) last.e = Math.max(last.e, c.e);
    else out.push({ ...c });
  }
  return out;
}

// Parts of the recording that are kept, in original time.
export function keptSegments(cuts, duration) {
  const segs = [];
  let t = 0;
  for (const c of cuts) {
    if (c.s > t) segs.push({ s: t, e: c.s });
    t = Math.max(t, c.e);
  }
  if (duration > t) segs.push({ s: t, e: duration });
  return segs;
}

// Original time -> edited time.
export function toEdited(t, cuts) {
  let removed = 0;
  for (const c of cuts) {
    if (t >= c.e) removed += c.e - c.s;
    else if (t > c.s) { removed += t - c.s; break; }
    else break;
  }
  return t - removed;
}

// Edited time -> original time.
export function toOriginal(t, cuts) {
  let acc = t;
  for (const c of cuts) {
    if (acc >= c.s) acc += c.e - c.s;
    else break;
  }
  return acc;
}

export function isCut(t, cuts) {
  return cuts.some((c) => t >= c.s && t < c.e);
}

export function editedDuration(duration, cuts) {
  return duration - cuts.reduce((x, c) => x + (c.e - c.s), 0);
}

// Cut boundaries for heard words i..j: halfway into the pauses on each side,
// so one natural pause remains where the words used to be.
export function cutRangeForWords(heard, i, j, duration) {
  const lo = Math.min(i, j), hi = Math.max(i, j);
  const prevEnd = lo > 0 ? heard[lo - 1].e : 0;
  const nextStart = hi < heard.length - 1 ? heard[hi + 1].s : duration;
  const s = lo > 0 ? (prevEnd + heard[lo].s) / 2 : Math.max(0, heard[lo].s - 0.05);
  const e = hi < heard.length - 1 ? (heard[hi].e + nextStart) / 2 : Math.min(duration, heard[hi].e + 0.15);
  return { s: Math.max(s, prevEnd), e: Math.min(e, nextStart) };
}

// Pauses between heard words that are longer than minGap seconds.
export function findPauses(heard, minGap, duration) {
  const out = [];
  const lead = heard.length ? heard[0].s : duration;
  if (lead >= minGap) out.push({ after: -1, s: 0, e: lead });
  for (let k = 0; k < heard.length - 1; k++) {
    const g = heard[k + 1].s - heard[k].e;
    if (g >= minGap) out.push({ after: k, s: heard[k].e, e: heard[k + 1].s });
  }
  return out;
}

// A cut that shortens a pause to `keep` seconds, centered in the pause.
export function cutForPause(p, keep) {
  const len = p.e - p.s;
  if (len <= keep) return null;
  if (p.after === -1) return { s: 0, e: Math.max(0, p.e - Math.min(keep, 0.3)) };
  const mid = (p.s + p.e) / 2;
  return { s: mid - (len - keep) / 2, e: mid + (len - keep) / 2 };
}
