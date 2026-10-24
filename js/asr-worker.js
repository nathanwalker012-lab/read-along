// Runs the Whisper speech model on the phone, off the main thread.
// The model downloads once and is then kept by the browser for offline use.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6';

env.allowLocalModels = false;
env.useBrowserCache = true;

const MODELS = {
  fast: 'onnx-community/whisper-tiny.en_timestamped',
  accurate: 'onnx-community/whisper-base.en_timestamped',
};

let current = { key: null, pipe: null };

async function load(key) {
  if (current.key === key && current.pipe) return current.pipe;
  const files = new Map();
  const pipe = await pipeline('automatic-speech-recognition', MODELS[key], {
    device: 'wasm',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        self.postMessage({ type: 'download', loaded, total });
      }
    },
  });
  current = { key, pipe };
  return pipe;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await load(msg.model);
      self.postMessage({ type: 'loaded' });
    } else if (msg.type === 'transcribe') {
      const pipe = await load(msg.model);
      const out = await pipe(msg.samples, { return_timestamps: 'word' });
      const words = (out.chunks || [])
        .map((c) => ({
          w: String(c.text || '').trim(),
          s: (c.timestamp && c.timestamp[0] != null ? c.timestamp[0] : 0) + msg.offset,
          e: (c.timestamp && c.timestamp[1] != null ? c.timestamp[1] : c.timestamp ? c.timestamp[0] : 0) + msg.offset,
        }))
        .filter((w) => w.w && !/^\[.*\]$|^\(.*\)$/.test(w.w));
      self.postMessage({ type: 'words', id: msg.id, words });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
  }
};
