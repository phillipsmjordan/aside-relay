/* Unified-diff parsing for the diff viewer. Pure functions, no DOM. */

export type DiffLineKind = 'add' | 'del' | 'context' | 'note';
export type DiffLine = { kind: DiffLineKind; text: string; oldNo?: number; newNo?: number };
export type DiffHunk = { header: string; section: string; oldStart?: number; newStart?: number; lines: DiffLine[] };
export type DiffStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';
export type DiffFile = {
  path: string; oldPath?: string; newPath?: string; status: DiffStatus;
  additions: number; deletions: number; hunks: DiffHunk[]; raw: string;
};
export type DiffSegment = { kind: 'text'; text: string } | { kind: 'file'; file: DiffFile };
export type SplitCell = DiffLine | undefined;
export type SplitRow = { kind: 'pair'; left: SplitCell; right: SplitCell } | { kind: 'note'; line: DiffLine };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const LOOSE_HUNK = /^@@(?: (.*))?$/;
const GIT_HEADER = /^diff --git (?:"?a\/(.+?)"? "?b\/(.+?)"?|(\S+) (\S+))$/;
const PATHLIKE = /^[\w./@+-]+\.[\w-]+$|^[\w.@+-]+\/[\w./@+-]+$/;

/** True when the text contains at least one recognisable file diff. */
export function looksLikeDiff(text: string): boolean {
  if (/^diff --git /m.test(text)) return true;
  return /^--- \S/m.test(text) && /^\+\+\+ \S/m.test(text) && /^@@ /m.test(text);
}

function cleanPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let path = value.trim().replace(/\t.*$/, '').replace(/^"(.*)"$/, '$1');
  if (path === '/dev/null') return undefined;
  path = path.replace(/^[ab]\//, '');
  return path;
}

/** Splits text into diff files and the plain text around them, in order. */
export function parseDiff(text: string, { assumeDiff = false }: { assumeDiff?: boolean } = {}): DiffSegment[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const segments: DiffSegment[] = [];
  let pending: string[] = [];
  let file: DiffFile | undefined;
  let fileStart = 0;
  let hunk: DiffHunk | undefined;
  let oldLeft = 0, newLeft = 0;          // remaining counts for a numbered hunk
  let oldNo = 0, newNo = 0;
  let sawOldHeader = false;
  let fromGitHeader = false;

  const flushText = () => { if (pending.length) { segments.push({ kind: 'text', text: pending.join('\n') }); pending = []; } };
  const closeFile = (end: number) => {
    if (!file) return;
    file.raw = lines.slice(fileStart, end).join('\n');
    while (file.hunks.length && file.hunks.at(-1)!.lines.length && file.hunks.at(-1)!.lines.at(-1)!.kind === 'context' && file.hunks.at(-1)!.lines.at(-1)!.text === '' && !isNumbered(file.hunks.at(-1)!)) file.hunks.at(-1)!.lines.pop();
    segments.push({ kind: 'file', file });
    file = undefined; hunk = undefined; oldLeft = newLeft = 0; sawOldHeader = false; fromGitHeader = false;
  };
  const openFile = (index: number, init: Partial<DiffFile>) => {
    closeFile(index);
    flushText();
    file = { path: '', status: 'modified', additions: 0, deletions: 0, hunks: [], raw: '', ...init };
    fileStart = index;
  };
  const isNumbered = (value: DiffHunk) => value.oldStart !== undefined;
  const push = (kind: DiffLineKind, value: string) => {
    if (!file) return;
    if (!hunk) { hunk = { header: '', section: '', lines: [] }; file.hunks.push(hunk); }
    const line: DiffLine = { kind, text: value };
    if (isNumbered(hunk)) {
      if (kind === 'del' || kind === 'context') { line.oldNo = oldNo++; oldLeft--; }
      if (kind === 'add' || kind === 'context') { line.newNo = newNo++; newLeft--; }
    }
    if (kind === 'add') file.additions++;
    if (kind === 'del') file.deletions++;
    hunk.lines.push(line);
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const inCountedHunk = !!hunk && isNumbered(hunk) && (oldLeft > 0 || newLeft > 0);

    if (inCountedHunk) {
      if (line.startsWith('+')) { push('add', line.slice(1)); continue; }
      if (line.startsWith('-')) { push('del', line.slice(1)); continue; }
      if (line.startsWith(' ')) { push('context', line.slice(1)); continue; }
      if (line === '') { push('context', ''); continue; }
      if (line.startsWith('\\')) { push('note', line.slice(1).trim()); continue; }
      // A line that does not belong to the hunk ends it early.
      hunk = undefined; oldLeft = newLeft = 0;
    }

    const git = line.match(GIT_HEADER);
    if (git) {
      const oldPath = cleanPath(git[1] ?? git[3]);
      const newPath = cleanPath(git[2] ?? git[4]);
      openFile(index, { oldPath, newPath, path: newPath ?? oldPath ?? '' });
      fromGitHeader = true;
      continue;
    }

    if (file && !hunk) {
      if (/^new file mode /.test(line)) { file.status = 'added'; continue; }
      if (/^deleted file mode /.test(line)) { file.status = 'deleted'; continue; }
      if (/^rename from /.test(line)) { file.oldPath = line.slice(12); file.status = 'renamed'; continue; }
      if (/^rename to /.test(line)) { file.newPath = line.slice(10); file.path = file.newPath; file.status = 'renamed'; continue; }
      if (/^Binary files .* differ$/.test(line)) { file.status = 'binary'; continue; }
      if (/^(?:index |similarity index |dissimilarity index |old mode |new mode |copy from |copy to )/.test(line)) continue;
    }

    if (line.startsWith('--- ')) {
      const next = lines[index + 1] ?? '';
      const rest = line.slice(4);
      const strict = next.startsWith('+++ ');
      const loose = /^(\S+?)(?:\s+\(([^)]*)\))?$/.exec(rest.trim());
      const isHeader = strict || (!!loose && PATHLIKE.test(loose[1]));
      if (isHeader) {
        const belongsToCurrent = !!file && !sawOldHeader && file.hunks.length === 0;
        const oldPath = strict ? cleanPath(rest) : cleanPath(loose?.[1]);
        if (!belongsToCurrent) openFile(index, {});
        const current = file!;
        sawOldHeader = true;
        if (strict) {
          const newPath = cleanPath(next.slice(4));
          current.oldPath = current.oldPath ?? oldPath;
          current.newPath = current.newPath ?? newPath;
          if (!oldPath && newPath && current.status === 'modified') current.status = 'added';
          if (oldPath && !newPath && current.status === 'modified') current.status = 'deleted';
          current.path = current.path || newPath || oldPath || '';
          index++;
        } else {
          current.oldPath = oldPath; current.newPath = oldPath; current.path = oldPath ?? '';
          const tag = loose?.[2]?.trim().toLowerCase();
          if (tag === 'new' || tag === 'new file' || tag === 'added') current.status = 'added';
          else if (tag === 'deleted' || tag === 'removed') current.status = 'deleted';
        }
        hunk = undefined;
        continue;
      }
    }

    if (file) {
      const numbered = line.match(HUNK);
      if (numbered) {
        hunk = { header: line, section: numbered[5] ?? '', oldStart: Number(numbered[1]), newStart: Number(numbered[3]), lines: [] };
        oldNo = hunk.oldStart!; newNo = hunk.newStart!;
        oldLeft = numbered[2] === undefined ? 1 : Number(numbered[2]);
        newLeft = numbered[4] === undefined ? 1 : Number(numbered[4]);
        file.hunks.push(hunk);
        continue;
      }
      const loose = line.match(LOOSE_HUNK);
      if (loose) { hunk = { header: line, section: (loose[1] ?? '').replace(/\s*@@\s*$/, ''), lines: [] }; file.hunks.push(hunk); continue; }
      const hasHeader = sawOldHeader || file.hunks.length > 0 || fromGitHeader;
      if (hasHeader && /^(?:\.{3,}|…)$/.test(line.trim())) { push('note', 'lines omitted'); continue; }
      if (hasHeader && (!hunk || !isNumbered(hunk))) {
        if (line.startsWith('+')) { push('add', line.slice(1)); continue; }
        if (line.startsWith('-')) { push('del', line.slice(1)); continue; }
        if (line.startsWith(' ')) { push('context', line.slice(1)); continue; }
        if (line === '') { push('context', ''); continue; }
        if (line.startsWith('\\')) { push('note', line.slice(1).trim()); continue; }
      }
      if (file.hunks.length || sawOldHeader || file.status === 'binary' || file.status === 'renamed') { closeFile(index); }
    }
    // A diff block with no file header (a bare snippet of + and - lines).
    if (assumeDiff && !file && /^(?:[+\- \\]|@@)/.test(line)) { openFile(index, {}); sawOldHeader = true; index--; continue; }
    pending.push(line);
  }
  closeFile(lines.length);
  flushText();
  return segments.filter(segment => segment.kind === 'file' || segment.text.trim() !== '');
}

export function diffFiles(segments: DiffSegment[]): DiffFile[] {
  return segments.flatMap(segment => segment.kind === 'file' ? [segment.file] : []);
}

/** Pairs removed and added lines side by side, the way split views show them. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.kind === 'note') { rows.push({ kind: 'note', line }); index++; continue; }
    if (line.kind === 'context') { rows.push({ kind: 'pair', left: line, right: line }); index++; continue; }
    const dels: DiffLine[] = []; const adds: DiffLine[] = [];
    while (index < lines.length && lines[index].kind === 'del') dels.push(lines[index++]);
    while (index < lines.length && lines[index].kind === 'add') adds.push(lines[index++]);
    for (let pair = 0; pair < Math.max(dels.length, adds.length); pair++) rows.push({ kind: 'pair', left: dels[pair], right: adds[pair] });
  }
  return rows;
}

/** The changed middle of a line edit, as [start, endFromStart] ranges in each line, or undefined when most of the line changed. */
export function inlineChange(before: string, after: string): { before: [number, number]; after: [number, number] } | undefined {
  if (before === after) return undefined;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const changed = Math.max(before.length, after.length) - start - end;
  if (changed > 0.7 * Math.max(before.length, after.length) && Math.max(before.length, after.length) > 8) return undefined;
  return { before: [start, before.length - end], after: [start, after.length - end] };
}

/** For each removed/added line that has a counterpart, where the edit is. Keyed by line object. */
export function inlineChanges(lines: DiffLine[]): Map<DiffLine, [number, number]> {
  const result = new Map<DiffLine, [number, number]>();
  for (const row of splitRows(lines)) {
    if (row.kind !== 'pair' || !row.left || !row.right || row.left === row.right) continue;
    const change = inlineChange(row.left.text, row.right.text);
    if (!change) continue;
    result.set(row.left, change.before);
    result.set(row.right, change.after);
  }
  return result;
}

const LANGUAGES: Record<string, string> = {
  py: 'python', pyi: 'python', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'bash', bash: 'bash', zsh: 'bash', css: 'css', scss: 'scss', html: 'xml', xml: 'xml', svg: 'xml',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', sql: 'sql', toml: 'ini', ini: 'ini', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift',
};

export function languageForPath(path: string): string | undefined {
  const name = path.split('/').at(-1) ?? '';
  if (name === 'Dockerfile') return undefined;
  if (name === 'Makefile') return 'makefile';
  return LANGUAGES[name.split('.').at(-1)?.toLowerCase() ?? ''];
}

export function diffTotals(files: DiffFile[]) {
  return files.reduce((total, file) => ({ additions: total.additions + file.additions, deletions: total.deletions + file.deletions }), { additions: 0, deletions: 0 });
}
