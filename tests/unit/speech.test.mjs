import assert from 'node:assert/strict'
import test from 'node:test'
import { isFatalListenError, extractSpeak, setVoiceNoteOn, stripVoiceNote, withVoiceNote, listenErrorMessage, matchOption, matchVerdict, parseVoiceIntent, speakableText, speechChunks, splitHead, suspensionSpeech } from '../../web/src/speech.ts'

test('speakable text drops markdown syntax, code, tables and urls', () => {
  const md = [
    '## Summary',
    'The **build** passed on `main` and [the MR](https://gitlab.com/x/1) is <citation refs="a#1">ready</citation>',
    '',
    '- first item',
    '1. second item',
    '```bash',
    'rm -rf /tmp/x',
    '```',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    'See https://example.com/page for more.',
    '> quoted -> moved',
  ].join('\n')
  assert.equal(speakableText(md), 'Summary. The build passed on main and the MR is ready. first item. second item. Code omitted. Table shown on screen. See link for more. quoted to moved.')
})

test('speakable text describes visuals and drafts instead of reading them', () => {
  assert.equal(speakableText('Here:\n```visual\n<div>x</div>\n```'), 'Here: Visual shown on screen.')
  assert.equal(speakableText('```slack-draft\n{"text":"hi"}\n```'), 'There is a draft on screen to review.')
  assert.equal(speakableText('```mermaid\ngraph TD\n```'), 'Diagram shown on screen.')
})

test('speakable text keeps snake_case and long inline code is summarized', () => {
  assert.equal(speakableText('Set the_flag and *really* check `' + 'x'.repeat(50) + '`'), 'Set the_flag and really check code.')
})

test('speech chunks stay under the limit and keep every word', () => {
  const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ') + ' ' + 'word, '.repeat(80)
  const chunks = speechChunks(text, 120)
  assert.ok(chunks.every(chunk => chunk.length <= 120))
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text.trim().replace(/\s+/g, ' '))
})

test('split head keeps short replies whole and cuts long ones at a sentence', () => {
  assert.deepEqual(splitHead('Short reply.'), { head: 'Short reply.', rest: '' })
  const long = 'This is a sentence. '.repeat(100).trim()
  const { head, rest } = splitHead(long, 300)
  assert.ok(head.endsWith('.') && head.length <= 300)
  assert.equal(`${head} ${rest}`, long)
})

test('voice intents', () => {
  assert.equal(parseVoiceIntent('Stop voice mode.'), 'voice-off')
  assert.equal(parseVoiceIntent('voice off'), 'voice-off')
  assert.equal(parseVoiceIntent('Cancel'), 'cancel')
  assert.equal(parseVoiceIntent("Don't send"), 'cancel')
  assert.equal(parseVoiceIntent('yes please'), 'yes')
  assert.equal(parseVoiceIntent('keep going'), 'yes')
  assert.equal(parseVoiceIntent("No, that's enough"), undefined)
  assert.equal(parseVoiceIntent("that's enough"), 'no')
  assert.equal(parseVoiceIntent('say that again'), 'repeat')
  assert.equal(parseVoiceIntent('yes merge the branch'), undefined)
})

test('option matching by number, ordinal and label', () => {
  const labels = ['Ship it (Recommended)', 'Hold for review', 'Close the MR']
  assert.equal(matchOption('two', labels), 1)
  assert.equal(matchOption('Option 3', labels), 2)
  assert.equal(matchOption('the first one', labels), 0)
  assert.equal(matchOption('1', labels), 0)
  assert.equal(matchOption('hold for review', labels), 1)
  assert.equal(matchOption('lets close the MR', labels), 2)
  assert.equal(matchOption('five', labels), undefined)
  assert.equal(matchOption('something else entirely', labels), undefined)
})

test('approval verdicts', () => {
  assert.equal(matchVerdict('Allow', 'approval'), 'allow')
  assert.equal(matchVerdict('no', 'approval'), 'deny')
  assert.equal(matchVerdict('go ahead', 'action-confirmation'), 'confirm')
  assert.equal(matchVerdict('cancel it', 'action-confirmation'), 'cancel')
  assert.equal(matchVerdict('maybe later', 'approval'), undefined)
})

test('question speech lists numbered options', () => {
  const speech = suspensionSpeech({ kind: 'ask-user-question', title: 'Pick', questions: [{ prompt: 'Which **branch**?', options: [{ label: 'main' }, { label: 'dev' }] }] })
  assert.equal(speech, 'Which branch? Options. 1: main. 2: dev. Say a number, or say your own answer.')
  assert.equal(suspensionSpeech({ kind: 'approval', title: 'Run command', message: 'git push', questions: [] }), 'Run command. git push. Say allow or deny.')
})

test('voice choice prefers the phone locale over the first English voice', async () => {
  const { chooseVoice } = await import('../../web/src/speech.ts')
  const android = [{ lang: 'en-AU' }, { lang: 'en-GB' }, { lang: 'en-IN' }, { lang: 'en-US' }, { lang: 'es-ES' }]
  assert.equal(chooseVoice(android, ['en-US', 'en']), 3)
  assert.equal(chooseVoice(android, ['en-GB']), 1)
  assert.equal(chooseVoice(android, ['en']), 3)
  assert.equal(chooseVoice([{ lang: 'en_AU' }, { lang: 'en_US' }], ['en-US']), 1)
  assert.equal(chooseVoice([{ lang: 'en-AU' }, { lang: 'en-US', default: true }, { lang: 'en-US', localService: true }], ['en-US']), 1)
  assert.equal(chooseVoice([{ lang: 'en-AU' }, { lang: 'en-GB' }], ['en-US']), 0)
  assert.equal(chooseVoice([{ lang: 'fr-FR' }], ['en-US']), -1)
})

test('mic errors give a specific next step', () => {
  assert.match(listenErrorMessage('not-allowed'), /lock icon/)
  assert.match(listenErrorMessage('not-allowed'), /System Settings/)
  assert.match(listenErrorMessage('audio-capture'), /another app/)
  assert.match(listenErrorMessage('network'), /online service/)
  assert.match(listenErrorMessage('service-not-allowed'), /Siri|Dictation/)
  assert.match(listenErrorMessage('weird'), /weird/)
  assert.match(listenErrorMessage('not-allowed', false), /https/)
})

test('speak summaries: extracted, hidden while streaming, and requested only in voice mode', () => {
  const reply = 'Here is the long answer.\n\n<speak>Short version. It works.</speak>'
  assert.deepEqual(extractSpeak(reply), { display: 'Here is the long answer.', spoken: 'Short version. It works.' })
  assert.deepEqual(extractSpeak('Answer text\n\n<speak>Half a sum'), { display: 'Answer text', spoken: '' })
  assert.equal(extractSpeak('Answer <spe').display, 'Answer')
  assert.equal(extractSpeak('a < b and <speaker> x').display, 'a < b and <speaker> x')
  assert.equal(extractSpeak('No tag here').spoken, '')
  assert.equal(withVoiceNote('hello'), 'hello')
  setVoiceNoteOn(true)
  const sent = withVoiceNote('hello')
  assert.match(sent, /<speak>/)
  assert.equal(withVoiceNote(sent), sent)
  assert.equal(stripVoiceNote(sent), 'hello')
  setVoiceNoteOn(false)
  assert.equal(stripVoiceNote('plain'), 'plain')
})

test('fatal listen errors stop auto-listening, transient ones do not', () => {
  for (const code of ['network', 'not-allowed', 'service-not-allowed', 'audio-capture', 'unsupported']) assert.equal(isFatalListenError(code), true)
  for (const code of [undefined, 'no-speech', 'aborted', 'start-failed']) assert.equal(isFatalListenError(code), false)
})

test('speak tags mentioned inside code are left alone', () => {
  const inline = 'The rule ends every reply with a `<speak>...</speak>` block. More text after.'
  assert.deepEqual(extractSpeak(inline), { display: inline, spoken: '' })
  const open = 'Use `<speak>` as the opening tag, then more explanation here.'
  assert.deepEqual(extractSpeak(open), { display: open, spoken: '' })
  const fenced = 'Fenced:\n```\n<speak>x</speak>\n```\nAfter fence.\n\n<speak>Real summary.</speak>'
  assert.deepEqual(extractSpeak(fenced), { display: 'Fenced:\n```\n<speak>x</speak>\n```\nAfter fence.', spoken: 'Real summary.' })
  assert.deepEqual(extractSpeak('Mentions `<speak>` here.\n\n<speak>Real one.</speak>'), { display: 'Mentions `<speak>` here.', spoken: 'Real one.' })
  assert.equal(extractSpeak('Answer\n\n<speak>Half a sum').display, 'Answer')
})

test('a bare speak tag mid-sentence does not hide the rest; a streaming block on its own line still does', () => {
  const prose = 'Use the <speak> tag at the end, then keep writing normally after it.'
  assert.equal(extractSpeak(prose).display, prose)
  assert.equal(extractSpeak('Answer text.\n\n<speak>Half a sum').display, 'Answer text.')
  assert.equal(extractSpeak('Answer text.\n\n<spe').display, 'Answer text.')
  assert.equal(extractSpeak('Answer text.\n\n<speak>Done.</speak>').spoken, 'Done.')
})
