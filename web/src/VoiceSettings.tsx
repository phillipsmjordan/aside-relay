import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from './Button';
import { styles as ui } from './ui';
import { tokens } from './tokens.stylex';
import { DEFAULT_RATE, automaticVoice, canSpeak, loadVoicePrefs, pageLanguages, saveVoicePrefs, speak, stopSpeaking, useSpeakingKey, useVoices, type VoicePrefs } from './voice';

const TEST_KEY = 'voice-test';
const SAMPLE = 'This is how replies will sound when they are read aloud.';

function languageName(lang: string) {
  try {
    const [language, region] = lang.replace(/_/g, '-').split('-');
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    const languages = new Intl.DisplayNames(['en'], { type: 'language' });
    return region ? `${languages.of(language)} (${names.of(region.toUpperCase())})` : languages.of(language) ?? lang;
  } catch { return lang; }
}

/** Read-aloud voice and speed, saved on this device. */
export function VoiceSettings() {
  const voices = useVoices();
  const speakingKey = useSpeakingKey();
  const [prefs, setPrefs] = useState<VoicePrefs>(loadVoicePrefs);
  if (!canSpeak) return null;
  const base = (pageLanguages()[0] ?? 'en').toLowerCase().split(/[-_]/)[0];
  const preferred = pageLanguages().map(lang => lang.toLowerCase());
  const options = voices
    .filter(voice => voice.lang.toLowerCase().replace(/_/g, '-').startsWith(base) || voice.voiceURI === prefs.voiceURI)
    .sort((left, right) => {
      const rank = (voice: SpeechSynthesisVoice) => { const index = preferred.indexOf(voice.lang.toLowerCase().replace(/_/g, '-')); return index < 0 ? 99 : index; };
      return rank(left) - rank(right) || left.lang.localeCompare(right.lang) || left.name.localeCompare(right.name);
    });
  const automatic = automaticVoice(voices);
  const isSelectedMissing = !!prefs.voiceURI && voices.length > 0 && !voices.some(voice => voice.voiceURI === prefs.voiceURI);
  function update(next: VoicePrefs) { setPrefs(next); saveVoicePrefs(next); }
  const isTesting = speakingKey === TEST_KEY;
  return <section>
    <h3 {...stylex.props(styles.heading)}>Read aloud</h3>
    <div {...stylex.props(styles.row)}>
      <label htmlFor="voice-picker">Voice</label>
      <select id="voice-picker" value={prefs.voiceURI ?? ''} onChange={event => update({ ...prefs, voiceURI: event.target.value || undefined })} {...stylex.props(styles.select)}>
        <option value="">Automatic{automatic ? ` · ${automatic.name}` : ''}</option>
        {options.map(voice => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name}{voice.name.toLowerCase().includes(languageName(voice.lang).toLowerCase()) ? '' : ` · ${languageName(voice.lang)}`}{voice.localService ? '' : ' · online'}</option>)}
      </select>
    </div>
    <div {...stylex.props(styles.row)}>
      <label htmlFor="voice-rate">Speed</label>
      <div {...stylex.props(styles.rate)}>
        <input id="voice-rate" type="range" min={0.75} max={1.5} step={0.05} value={prefs.rate} onChange={event => update({ ...prefs, rate: Number(event.target.value) })} {...stylex.props(styles.slider)} />
        <output htmlFor="voice-rate" {...stylex.props(styles.rateValue)}>{prefs.rate.toFixed(2)}×</output>
      </div>
    </div>
    <div {...stylex.props(styles.actions)}>
      <Button onClick={() => { if (isTesting) stopSpeaking(); else void speak(TEST_KEY, SAMPLE, { isMarkdown: false }); }}>{isTesting ? 'Stop' : 'Test voice'}</Button>
      <Button disabled={!prefs.voiceURI && prefs.rate === DEFAULT_RATE} onClick={() => update({ rate: DEFAULT_RATE })}>Reset</Button>
    </div>
    <p {...stylex.props(ui.muted)}>{isSelectedMissing ? 'The chosen voice is not on this device, so Automatic is used. ' : ''}Saved on this device only. Phones list the voices installed in their text-to-speech settings; on Android that is Settings, Text-to-speech output.</p>
  </section>;
}

const styles = stylex.create({
  heading: { fontSize: '0.875rem', fontWeight: 600, margin: '0 0 12px' },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44, paddingTop: 6, paddingBottom: 6, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border, fontSize: '0.875rem' },
  select: { minHeight: 44, maxWidth: '100%', borderWidth: 0, padding: '0 8px', borderRadius: 12, backgroundColor: tokens.surface, color: tokens.text },
  rate: { display: 'flex', alignItems: 'center', gap: 10, flexGrow: 1, justifyContent: 'flex-end', minWidth: 180 },
  slider: { flexGrow: 1, maxWidth: 220, accentColor: tokens.primary },
  rateValue: { minWidth: 48, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: tokens.muted },
  actions: { display: 'flex', gap: 8, marginTop: 12, marginBottom: 8 },
});
