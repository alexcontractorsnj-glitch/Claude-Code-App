// ============================================================================
//  voice.js — browser voice helpers (no framework). Two capabilities:
//   • Voice notes: record mic audio via MediaRecorder → { mime, b64, dur }.
//   • Dictation:   speech-to-text via the Web Speech API (on-device).
//  Both degrade gracefully where the browser lacks support (feature-detected),
//  so callers can hide the buttons. Used by the desktop monitor + Corefield.
// ============================================================================

export function supportsRecording() {
  return typeof navigator !== 'undefined' && !!(navigator.mediaDevices
    && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
}
export function supportsDictation() {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// Dictation language — the Web Speech API recognises one language per session,
// so we let the user toggle (preference persisted). English + US Spanish cover
// most field crews; add more codes here as needed.
export const DICTATION_LANGS = [{ code: 'en-US', label: 'EN' }, { code: 'es-US', label: 'ES' }];
const LANG_KEY = 'buildflow.dictlang';
export function getDictationLang() {
  try { return localStorage.getItem(LANG_KEY) || 'en-US'; } catch { return 'en-US'; }
}
export function setDictationLang(code) {
  try { localStorage.setItem(LANG_KEY, code); } catch { /* non-fatal */ }
}
export function dictationLabel(code) {
  const c = code || getDictationLang();
  const m = DICTATION_LANGS.find((l) => l.code === c);
  return m ? m.label : c.slice(0, 2).toUpperCase();
}
// Toggle to the next configured language and return its code.
export function cycleDictationLang() {
  const cur = getDictationLang();
  const i = DICTATION_LANGS.findIndex((l) => l.code === cur);
  const next = DICTATION_LANGS[(i + 1) % DICTATION_LANGS.length].code;
  setDictationLang(next);
  return next;
}

function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return cands.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}
function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// Begin recording; resolves to a controller with stop()/cancel(). stop() returns
// the captured clip { mime, b64, dur(seconds) }.
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  const t0 = Date.now();
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start();
  const cleanup = () => stream.getTracks().forEach((t) => t.stop());
  return {
    elapsed: () => Math.round((Date.now() - t0) / 1000),
    cancel: () => { try { rec.stop(); } catch { /* ignore */ } cleanup(); },
    stop: () => new Promise((resolve) => {
      rec.onstop = async () => {
        cleanup();
        const type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
        const blob = new Blob(chunks, { type });
        resolve({ mime: type, b64: await blobToB64(blob), dur: Math.max(1, Math.round((Date.now() - t0) / 1000)) });
      };
      try { rec.stop(); } catch { cleanup(); resolve(null); }
    }),
  };
}

// Start dictation. onText(finalSoFar, interim) fires as speech is recognised;
// onEnd(finalText) fires when it stops. Returns the recogniser (has .stop()).
export function startDictation(onText, onEnd, lang) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = lang || getDictationLang(); r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
  let final = '';
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const tr = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += tr; else interim += tr;
    }
    onText(final, interim);
  };
  r.onerror = () => { /* swallow; onend still fires */ };
  r.onend = () => { if (onEnd) onEnd(final.trim()); };
  try { r.start(); } catch { return null; }
  return r;
}

// mm:ss for a duration in seconds.
export function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
