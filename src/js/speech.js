// ============================================================================
//  speech.js — Text-to-speech for the AI Dispatcher (browser SpeechSynthesis).
//  Lets the agent *speak* its replies: an on-demand 🔊 button per message and a
//  persisted auto-speak toggle. Language follows the dictation setting (EN/ES)
//  so a Spanish-speaking crew hears Spanish. Pure-ish: no DOM, guards for SSR.
// ============================================================================
import { getDictationLang } from './voice.js';

const LS_AUTOSPEAK = 'cf.autospeak';

export function supportsSpeech() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

export function autoSpeakOn() {
  try { return localStorage.getItem(LS_AUTOSPEAK) === '1'; } catch { return false; }
}
export function setAutoSpeak(on) {
  try { localStorage.setItem(LS_AUTOSPEAK, on ? '1' : '0'); } catch { /* ignore */ }
  if (!on) cancelSpeech();
  return !!on;
}
export function toggleAutoSpeak() { return setAutoSpeak(!autoSpeakOn()); }

// Strip emoji, markdown emphasis and bullet glyphs so the spoken text is clean.
export function speakable(text) {
  return String(text || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}←-⇿⬀-⯿️]/gu, ' ')
    .replace(/[*_`#>•]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cancelSpeech() {
  try { if (supportsSpeech()) window.speechSynthesis.cancel(); } catch { /* ignore */ }
}

// Speak a string. Picks a voice matching the chosen language when available.
export function speak(text, lang) {
  if (!supportsSpeech()) return false;
  const clean = speakable(text);
  if (!clean) return false;
  try {
    window.speechSynthesis.cancel();                 // never stack utterances
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = lang || getDictationLang() || 'en-US';
    const voices = window.speechSynthesis.getVoices() || [];
    const v = voices.find((x) => x.lang === u.lang) || voices.find((x) => x.lang && x.lang.slice(0, 2) === u.lang.slice(0, 2));
    if (v) u.voice = v;
    u.rate = 1; u.pitch = 1;
    window.speechSynthesis.speak(u);
    return true;
  } catch { return false; }
}
