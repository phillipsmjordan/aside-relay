// Pure helpers for read-aloud and voice mode. No browser APIs here so they can be unit tested in Node.

export type SpokenQuestion = { prompt: string; title?: string; options: { label: string; description?: string }[]; allowsMultiple?: boolean };
export type SpokenSuspension = { kind: 'approval' | 'action-confirmation' | 'ask-user-question'; title: string; message?: string; questions: SpokenQuestion[] };
export type VoiceIntent = 'voice-off' | 'cancel' | 'yes' | 'no' | 'repeat';

const DRAFT_LANGUAGE = /draft$|^(?:tweet|x-post|x-tweet|linkedin-post)$/;
const SENTENCE_END = /[.!?:;,]$/;

function fenceSummary(language: string) {
  if (language === 'visual' || language === 'html') return 'Visual shown on screen.';
  if (language === 'mermaid') return 'Diagram shown on screen.';
  if (DRAFT_LANGUAGE.test(language)) return 'There is a draft on screen to review.';
  return 'Code omitted.';
}

/** Turns assistant markdown into plain text that sounds natural when spoken. */
export function speakableText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let fence: { marker: string; language: string } | undefined;
  let inTable = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})\s*([\w-]*)/);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.marker[0] && fenceMatch[1].length >= fence.marker.length && !fenceMatch[2]) fence = undefined;
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1], language: fenceMatch[2].toLowerCase() };
      out.push(fenceSummary(fence.language));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!inTable) out.push('Table shown on screen.');
      inTable = true;
      continue;
    }
    inTable = false;
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) continue;
    const text = inlineText(line.replace(/^\s*>+\s?/, '').replace(/^\s*#{1,6}\s+/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ''));
    if (!text) continue;
    out.push(SENTENCE_END.test(text) ? text : text + '.');
  }
  return out.join(' ').replace(/\s+/g, ' ').replace(/\.\s*\./g, '.').trim();
}

function inlineText(line: string) {
  return line
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => alt ? `Image: ${alt}.` : '')
    .replace(/\[([^\]]+)\]\((?:<[^>]*>|[^)\s]*)(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, 'link')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/`([^`]+)`/g, (_, code: string) => code.length > 40 ? 'code' : code)
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\s*(?:->|→)\s*/g, ' to ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits text into utterance-sized chunks. Long utterances stall on some Android voices. */
export function speechChunks(text: string, maxLength = 220): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/).flatMap(sentence => sentence.length <= maxLength ? [sentence] : splitLong(sentence, maxLength));
  const chunks: string[] = [];
  for (const sentence of sentences) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + sentence.length <= maxLength) chunks[chunks.length - 1] = `${last} ${sentence}`;
    else if (sentence.trim()) chunks.push(sentence.trim());
  }
  return chunks;
}

function splitLong(sentence: string, maxLength: number) {
  const parts: string[] = [];
  let current = '';
  for (const word of sentence.split(/(?<=,)\s+|\s+/)) {
    if (current && current.length + 1 + word.length > maxLength) { parts.push(current); current = word; }
    else current = current ? `${current} ${word}` : word;
  }
  if (current) parts.push(current);
  return parts;
}

/** Splits a long reply into a first part and the rest, at a sentence boundary. */
export function splitHead(text: string, limit = 700): { head: string; rest: string } {
  if (text.length <= limit * 1.4) return { head: text, rest: '' };
  const window = text.slice(0, limit);
  const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
  const index = cut > limit * 0.4 ? cut + 1 : limit;
  return { head: text.slice(0, index).trim(), rest: text.slice(index).trim() };
}

export function normalizeSpeech(transcript: string) {
  return transcript.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function parseVoiceIntent(transcript: string): VoiceIntent | undefined {
  const text = normalizeSpeech(transcript);
  if (/^(?:(?:stop|end|exit|turn off|quit|close) voice(?: mode)?|voice(?: mode)? off)$/.test(text)) return 'voice-off';
  if (/^(?:cancel|never ?mind|scratch that|dont send|do not send|forget it|stop)$/.test(text)) return 'cancel';
  if (/^(?:repeat(?: that)?|say (?:that|it) again|read (?:that|it) again|again)$/.test(text)) return 'repeat';
  if (/^(?:yes|yeah|yep|yup|sure|ok|okay|go on|go ahead|continue|more|keep going|read (?:it|the rest|more|on))(?: please)?$/.test(text)) return 'yes';
  if (/^(?:no|nope|skip(?: it)?|thats enough|enough|no thanks|stop reading)(?: thanks| thank you)?$/.test(text)) return 'no';
  return undefined;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, won: 1, first: 1, two: 2, to: 2, too: 2, second: 2, three: 3, third: 3, four: 4, for: 4, fourth: 4, five: 5, fifth: 5, six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9, ten: 10, tenth: 10 };

/** Maps a spoken answer to an option index: "two", "option 2", "the second one", or the option's label. */
export function matchOption(transcript: string, labels: string[]): number | undefined {
  const text = normalizeSpeech(transcript);
  if (!text || !labels.length) return undefined;
  const numeric = text.match(/^(?:(?:option|number|choice|pick|choose|the)\s+)?(\d{1,2}|[a-z]+)(?:\s+(?:one|option|please))?$/);
  if (numeric) {
    const value = /^\d+$/.test(numeric[1]) ? Number(numeric[1]) : NUMBER_WORDS[numeric[1]];
    if (value && value <= labels.length) return value - 1;
  }
  const normalized = labels.map(label => normalizeSpeech(label.replace(/\(recommended\)/i, '')));
  const exact = normalized.findIndex(label => label === text);
  if (exact >= 0) return exact;
  const contained = normalized.flatMap((label, index) => label.length >= 3 && (text.includes(label) || (text.length >= 4 && label.includes(text))) ? [index] : []);
  return contained.length === 1 ? contained[0] : undefined;
}

export function matchVerdict(transcript: string, kind: SpokenSuspension['kind']): string | undefined {
  const text = normalizeSpeech(transcript);
  if (kind === 'approval') {
    if (/^(?:allow|yes|approve|approved|ok|okay|sure|go ahead)(?: it)?(?: please)?$/.test(text)) return 'allow';
    if (/^(?:deny|no|reject|dont|do not|block)(?: it)?$/.test(text)) return 'deny';
  }
  if (kind === 'action-confirmation') {
    if (/^(?:confirm|yes|go ahead|do it|ok|okay|sure|proceed)(?: please)?$/.test(text)) return 'confirm';
    if (/^(?:cancel|no|dont|do not|stop)(?: it)?$/.test(text)) return 'cancel';
  }
  return undefined;
}

/** What to say when the agent is waiting on an answer. */
export function suspensionSpeech(suspension: SpokenSuspension, questionIndex = 0): string {
  if (suspension.kind === 'approval') return `${suspension.title}. ${suspension.message ? speakableText(suspension.message) + ' ' : ''}Say allow or deny.`;
  if (suspension.kind === 'action-confirmation') return `${suspension.title}. ${suspension.message ? speakableText(suspension.message) + ' ' : ''}Say confirm or cancel.`;
  const question = suspension.questions[questionIndex];
  if (!question) return suspension.title;
  const prefix = suspension.questions.length > 1 ? `Question ${questionIndex + 1} of ${suspension.questions.length}. ` : '';
  const options = question.options.map((option, index) => `${index + 1}: ${speakableText(option.label)}`).join(' ');
  return `${prefix}${speakableText(question.prompt || question.title || suspension.title)} ${options ? 'Options. ' + options + ' ' : ''}Say a number, or say your own answer.`;
}

export type VoiceLike = { lang: string; default?: boolean; localService?: boolean; name?: string };

function normalizeLang(lang: string) { return lang.replace(/_/g, '-').toLowerCase(); }

/**
 * Picks the voice to read with. Prefers the phone's own locale (en-US) over the first voice of the language,
 * because Android lists voices alphabetically and en-AU would otherwise win. Returns -1 when nothing fits.
 */
export function chooseVoice(voices: VoiceLike[], preferred: string[]): number {
  const wanted = preferred.map(normalizeLang).filter(Boolean);
  const primary = wanted[0] ?? 'en-us';
  const base = primary.split('-')[0];
  const regionFallback = base === 'en' ? 'en-us' : undefined;
  const score = (voice: VoiceLike) => {
    const lang = normalizeLang(voice.lang);
    if (lang.split('-')[0] !== base) return -1;
    let value = 0;
    const rank = wanted.indexOf(lang);
    if (rank === 0) value += 100;
    else if (rank > 0) value += 60 - rank;
    else if (lang === regionFallback) value += 40;
    if (voice.default) value += 10;
    if (voice.localService) value += 1;
    return value;
  };
  let best = -1;
  let bestScore = -1;
  voices.forEach((voice, index) => { const value = score(voice); if (value > bestScore) { best = index; bestScore = value; } });
  return best;
}

/** Plain-language reason a speech-recognition attempt failed, with what to do about it. */
export function listenErrorMessage(code: string | undefined, secure = true): string {
  if (!secure || code === 'unsupported') {
    return 'Voice input needs a secure (https) page in Chrome, Edge or Safari. Open the relay through its https address.';
  }
  switch (code) {
    case 'not-allowed':
      return 'Microphone is blocked for this site. Click the lock icon in the address bar and allow Microphone, then tap Talk. On a Mac also check System Settings, Privacy & Security, Microphone, for this browser.';
    case 'service-not-allowed':
      return 'This browser is not allowed to use speech recognition. In Safari turn on Siri or Dictation in System Settings; in Chrome allow Microphone for this site.';
    case 'audio-capture':
      return 'No working microphone found, or another app is using it. Check System Settings, Sound, Input, then tap Talk.';
    case 'network':
      return 'Speech recognition could not reach its online service. Check the connection. Chromium builds without Google speech access (some embedded browsers) cannot do this; use Chrome or Safari.';
    case 'language-not-supported':
      return 'This browser does not support speech recognition for your language.';
    case 'start-failed':
      return 'Voice input is already starting. Wait a moment and tap Talk again.';
    default:
      return `Could not listen (${code ?? 'unknown error'}). Tap Talk to try again.`;
  }
}
