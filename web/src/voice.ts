import { useSyncExternalStore } from 'react';
import { speakableText, speechChunks } from './speech';

// One shared speaker for the whole app, so a read-aloud button and voice mode never talk over each other.

type SpeakerState = { key?: string };
let speakerState: SpeakerState = {};
let speakToken = 0;
const listeners = new Set<() => void>();

function setSpeakerState(next: SpeakerState) { speakerState = next; listeners.forEach(listener => listener()); }

export const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

function language() { return document.documentElement.lang || navigator.language || 'en-US'; }

function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  const lang = language().toLowerCase();
  const base = lang.split('-')[0];
  return voices.find(voice => voice.default && voice.lang.toLowerCase().startsWith(base))
    ?? voices.find(voice => voice.lang.toLowerCase() === lang && voice.localService)
    ?? voices.find(voice => voice.lang.toLowerCase().startsWith(base));
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
      utterance.rate = 1.05;
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
