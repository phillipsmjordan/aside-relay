import { useEffect, useState, useSyncExternalStore } from 'react';
import { chooseVoice, speakableText, speechChunks } from './speech';

// One shared speaker for the whole app, so a read-aloud button and voice mode never talk over each other.

type SpeakerState = { key?: string };
let speakerState: SpeakerState = {};
let speakToken = 0;
const listeners = new Set<() => void>();

function setSpeakerState(next: SpeakerState) { speakerState = next; listeners.forEach(listener => listener()); }

export const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

/** The phone's locale (for example en-US) when it matches the page language; the page's bare "en" is too vague. */
function preferredLanguages() {
  const page = (document.documentElement.lang || 'en').toLowerCase();
  const browser = (navigator.languages?.length ? navigator.languages : [navigator.language]).filter(Boolean);
  const matching = browser.filter(lang => lang.toLowerCase().split(/[-_]/)[0] === page.split('-')[0]);
  return matching.length ? matching : [page.includes('-') ? page : page === 'en' ? 'en-US' : page];
}

function language() { return preferredLanguages()[0]; }

// Per-device voice choice, saved in this browser.
export type VoicePrefs = { voiceURI?: string; rate: number };
const PREFS_KEY = 'aside-relay:voice-prefs';
export const DEFAULT_RATE = 1.05;

export function loadVoicePrefs(): VoicePrefs {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    if (typeof value !== 'object' || value === null) return { rate: DEFAULT_RATE };
    const voiceURI = Reflect.get(value, 'voiceURI');
    const rate = Number(Reflect.get(value, 'rate'));
    return { voiceURI: typeof voiceURI === 'string' && voiceURI ? voiceURI : undefined, rate: Number.isFinite(rate) && rate >= 0.5 && rate <= 2 ? rate : DEFAULT_RATE };
  } catch { return { rate: DEFAULT_RATE }; }
}

export function saveVoicePrefs(prefs: VoicePrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
}

/** The voices this device offers. Chrome loads them asynchronously, so listen for voiceschanged. */
export function useVoices() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => canSpeak ? window.speechSynthesis.getVoices() : []);
  useEffect(() => {
    if (!canSpeak) return;
    const update = () => setVoices(window.speechSynthesis.getVoices());
    update();
    window.speechSynthesis.addEventListener('voiceschanged', update);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', update);
  }, []);
  return voices;
}

/** The voice "Automatic" resolves to on this device. */
export function automaticVoice(voices = canSpeak ? window.speechSynthesis.getVoices() : []) {
  const index = chooseVoice(voices, preferredLanguages());
  return index >= 0 ? voices[index] : undefined;
}

export function pageLanguages() { return preferredLanguages(); }

function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  const { voiceURI } = loadVoicePrefs();
  return (voiceURI ? voices.find(voice => voice.voiceURI === voiceURI) : undefined) ?? automaticVoice(voices);
}

/** Speaks text. Resolves true when it finished, false when it was stopped or replaced. */
export function speak(key: string, text: string, { isMarkdown = true } = {}): Promise<boolean> {
  if (!canSpeak) return Promise.resolve(false);
  const synth = window.speechSynthesis;
  const token = ++speakToken;
  synth.cancel();
  const chunks = speechChunks(isMarkdown ? speakableText(text) : text);
  if (!chunks.length) { setSpeakerState({}); return Promise.resolve(true); }
  setSpeakerState({ key });
  const voice = pickVoice();
  const { rate } = loadVoicePrefs();
  return new Promise(resolve => {
    let index = 0;
    const finish = (completed: boolean) => {
      if (token === speakToken) setSpeakerState({});
      resolve(completed);
    };
    const next = () => {
      if (token !== speakToken) { resolve(false); return; }
      if (index >= chunks.length) { finish(true); return; }
      const utterance = new SpeechSynthesisUtterance(chunks[index++]);
      utterance.lang = voice?.lang ?? language();
      if (voice) utterance.voice = voice;
      utterance.rate = rate;
      utterance.onend = next;
      utterance.onerror = event => { if (event.error === 'interrupted' || event.error === 'canceled') { if (token === speakToken) finish(false); else resolve(false); } else next(); };
      synth.speak(utterance);
      // Chrome can leave the queue paused after the page was backgrounded.
      if (synth.paused) synth.resume();
    };
    next();
  });
}

export function stopSpeaking() {
  speakToken++;
  if (canSpeak) window.speechSynthesis.cancel();
  setSpeakerState({});
}

export function useSpeakingKey() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => speakerState.key, () => undefined);
}

// Speech recognition (Chrome sends the audio to Google's recognizer, the same as the dictation button).

type RecognitionResult = { isFinal?: boolean; 0?: { transcript?: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type Recognition = { continuous: boolean; interimResults: boolean; lang: string; onresult?: (event: RecognitionEvent) => void; onend?: () => void; onerror?: (event: { error?: string }) => void; start: () => void; stop: () => void; abort: () => void };
type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  const browser = window as typeof window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

export const canListen = !!recognitionConstructor();

export type ListenResult = { transcript: string; error?: string };

/** Listens for one utterance. Returns the final transcript, or an empty one on silence. */
export function listen(onInterim: (text: string) => void): { result: Promise<ListenResult>; stop: () => void } {
  const Constructor = recognitionConstructor();
  if (!Constructor) return { result: Promise.resolve({ transcript: '', error: 'unsupported' }), stop: () => {} };
  const recognition = new Constructor();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = language();
  let finalText = '';
  let error: string | undefined;
  const result = new Promise<ListenResult>(resolve => {
    recognition.onresult = event => {
      let interim = '';
      finalText = '';
      for (let index = 0; index < event.results.length; index++) {
        const item = event.results[index];
        const text = item[0]?.transcript ?? '';
        if (item.isFinal) finalText += text; else interim += text;
      }
      onInterim((finalText + ' ' + interim).trim());
    };
    recognition.onerror = event => { error = event.error; };
    recognition.onend = () => resolve({ transcript: finalText.trim(), error: error === 'no-speech' || error === 'aborted' ? undefined : error });
    try { recognition.start(); } catch { resolve({ transcript: '', error: 'start-failed' }); }
  });
  return { result, stop: () => { try { recognition.stop(); } catch { /* already stopped */ } } };
}
