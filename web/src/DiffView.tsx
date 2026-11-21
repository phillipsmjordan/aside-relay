import { createElement, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as stylex from '@stylexjs/stylex';
import { common, createLowlight } from 'lowlight';
import { Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, Code2, Columns2, Copy, FileDiff, Maximize2, Rows2, WrapText, X } from 'lucide-react';
import { tokens } from './tokens.stylex';
import { ICON_STROKE } from './ui';
import { diffFiles, diffTotals, inlineChanges, languageForPath, parseDiff, splitRows, type DiffFile, type DiffHunk, type DiffLine, type DiffSegment } from './diff';

const lowlight = createLowlight(common);
const PREFS_KEY = 'aside-relay:diff-prefs';
const SPLIT_MIN_WIDTH = 760;
const LARGE_FILE_LINES = 160;
const MAX_HIGHLIGHT_LENGTH = 600;

type Prefs = { view: 'split' | 'unified'; wrap: boolean };
type Notify = (text: string, kind?: 'success' | 'error') => void;

function loadPrefs(): Prefs {
  try { const value = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}'); return { view: value.view === 'unified' ? 'unified' : 'split', wrap: value.wrap !== false }; }
  catch { return { view: 'split', wrap: true }; }
}

function savePrefs(prefs: Prefs) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ } }

function fileLines(file: DiffFile) { return file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0); }

/** A proper diff viewer for unified diffs: per-file cards, line numbers, word-level changes, split view on wide screens, fullscreen. */
export function DiffView({ source, assumeDiff = false, variant = 'message', isStreaming = false, notify }: {
  source: string; assumeDiff?: boolean; variant?: 'message' | 'tool'; isStreaming?: boolean; notify?: Notify;
}) {
  const segments = useMemo(() => parseDiff(source, { assumeDiff }), [source, assumeDiff]);
  const files = useMemo(() => diffFiles(segments), [segments]);
  if (!files.length) return <pre {...stylex.props(styles.raw)}>{source}</pre>;
  return <DiffPanel segments={segments} files={files} source={source} variant={variant} isStreaming={isStreaming} notify={notify}
    onFullscreen={() => window.dispatchEvent(new CustomEvent<FullscreenRequest>(FULLSCREEN_EVENT, { detail: { source, assumeDiff } }))} />;
}

const FULLSCREEN_EVENT = 'aside:diff-fullscreen';
type FullscreenRequest = { source: string; assumeDiff: boolean };

/** Mounted once by the app, so the full-screen diff stays open even when its message scrolls out of the (virtualised) list. */
export function DiffFullscreenHost({ notify }: { notify?: Notify }) {
  const [request, setRequest] = useState<FullscreenRequest>();
  useEffect(() => {
    const open = (event: Event) => setRequest((event as CustomEvent<FullscreenRequest>).detail);
    window.addEventListener(FULLSCREEN_EVENT, open);
    return () => window.removeEventListener(FULLSCREEN_EVENT, open);
  }, []);
  const segments = useMemo(() => request ? parseDiff(request.source, { assumeDiff: request.assumeDiff }) : [], [request]);
  if (!request) return null;
  return createPortal(<Fullscreen segments={segments} files={diffFiles(segments)} source={request.source} notify={notify} onClose={() => setRequest(undefined)} />, document.body);
}

function DiffPanel({ segments, files, source, variant, isStreaming, notify, onFullscreen, isFullscreen = false }: {
  segments: DiffSegment[]; files: DiffFile[]; source: string; variant: 'message' | 'tool'; isStreaming: boolean; notify?: Notify;
  onFullscreen?: () => void; isFullscreen?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [width, setWidth] = useState(0);
  const [isRaw, setRaw] = useState(false);
  const [closed, setClosed] = useState<Set<number>>(() => new Set(files.flatMap((file, index) => variant === 'tool' ? [index] : !isFullscreen && fileLines(file) > LARGE_FILE_LINES ? [index] : [])));
  useLayoutEffect(() => {
    const element = containerRef.current; if (!element) return;
    const observer = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(element); setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);
  const canSplit = width >= SPLIT_MIN_WIDTH;
  const view = canSplit ? prefs.view : 'unified';
  const totals = diffTotals(files);
  const allClosed = closed.size === files.length;
  function update(next: Partial<Prefs>) { const value = { ...prefs, ...next }; setPrefs(value); savePrefs(value); }
  function toggle(index: number) { setClosed(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; }); }
  let fileIndex = -1;
  const { className, ...panelStyle } = stylex.props(styles.panel, isFullscreen && styles.panelFullscreen);
  return <section ref={containerRef} aria-label="Diff" className={`diff-view ${className ?? ''}`} {...panelStyle}>
    <div {...stylex.props(styles.toolbar, isFullscreen && styles.toolbarFullscreen)}>
      <span {...stylex.props(styles.summary)}><FileDiff size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />{files.length} {files.length === 1 ? 'file' : 'files'}<span {...stylex.props(styles.added)}>+{totals.additions}</span><span {...stylex.props(styles.removed)}>−{totals.deletions}</span>{isStreaming && <span {...stylex.props(styles.muted)}>writing…</span>}</span>
      <span {...stylex.props(styles.tools)}>
        {canSplit && <ToolButton label={view === 'split' ? 'Unified view' : 'Split view'} onClick={() => update({ view: view === 'split' ? 'unified' : 'split' })}>{view === 'split' ? <Rows2 size={16} strokeWidth={ICON_STROKE} /> : <Columns2 size={16} strokeWidth={ICON_STROKE} />}</ToolButton>}
        <ToolButton label={prefs.wrap ? 'Do not wrap lines' : 'Wrap lines'} isPressed={prefs.wrap} onClick={() => update({ wrap: !prefs.wrap })}><WrapText size={16} strokeWidth={ICON_STROKE} /></ToolButton>
        {files.length > 1 && <ToolButton label={allClosed ? 'Expand all files' : 'Collapse all files'} onClick={() => setClosed(allClosed ? new Set() : new Set(files.map((_, index) => index)))}>{allClosed ? <ChevronsUpDown size={16} strokeWidth={ICON_STROKE} /> : <ChevronsDownUp size={16} strokeWidth={ICON_STROKE} />}</ToolButton>}
        <ToolButton label={isRaw ? 'Show diff' : 'Show raw text'} isPressed={isRaw} onClick={() => setRaw(!isRaw)}><Code2 size={16} strokeWidth={ICON_STROKE} /></ToolButton>
        <CopyTool text={source} label="Copy patch" notify={notify} />
        {onFullscreen && <ToolButton label="Open full screen" onClick={onFullscreen}><Maximize2 size={16} strokeWidth={ICON_STROKE} /></ToolButton>}
      </span>
    </div>
    <div>
      {isRaw ? <pre {...stylex.props(styles.raw)}>{source}</pre> : segments.map((segment, index) => {
        if (segment.kind === 'text') return <pre key={'t' + index} {...stylex.props(styles.between)}>{segment.text}</pre>;
        fileIndex++;
        const current = fileIndex;
        return <FileCard key={'f' + index + segment.file.path} id={`diff-file-${current}`} file={segment.file} view={view} wrap={prefs.wrap} isOpen={!closed.has(current)} onToggle={() => toggle(current)} notify={notify} />;
      })}
    </div>
  </section>;
}

function Fullscreen({ segments, files, source, notify, onClose }: { segments: DiffSegment[]; files: DiffFile[]; source: string; notify?: Notify; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); previous?.focus({ preventScroll: true }); };
  }, [onClose]);
  const totals = diffTotals(files);
  return <div role="dialog" aria-modal="true" aria-label="Diff" {...stylex.props(styles.overlay)}>
    <header {...stylex.props(styles.overlayHeader)}>
      <strong {...stylex.props(styles.overlayTitle)}>Changes · {files.length} {files.length === 1 ? 'file' : 'files'} <span {...stylex.props(styles.added)}>+{totals.additions}</span> <span {...stylex.props(styles.removed)}>−{totals.deletions}</span></strong>
      <button ref={closeRef} type="button" aria-label="Close" title="Close" {...stylex.props(styles.tool)} onClick={onClose}><X size={20} strokeWidth={ICON_STROKE} /></button>
    </header>
    <div {...stylex.props(styles.overlayBody)}>
      {files.length > 1 && <nav aria-label="Files" {...stylex.props(styles.index)}>{files.map((file, index) => <button key={index} type="button" {...stylex.props(styles.indexItem)} onClick={() => document.getElementById(`diff-file-${index}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>
        <span {...stylex.props(styles.indexName)} title={file.path}>{displayName(file)}</span><span {...stylex.props(styles.indexStats)}><span {...stylex.props(styles.added)}>+{file.additions}</span> <span {...stylex.props(styles.removed)}>−{file.deletions}</span></span>
      </button>)}</nav>}
      <div {...stylex.props(styles.overlayMain)}><DiffPanel segments={segments} files={files} source={source} variant="message" isStreaming={false} notify={notify} isFullscreen /></div>
    </div>
  </div>;
}

function displayName(file: DiffFile) { return file.path ? file.path.split('/').at(-1)! : 'Snippet'; }

function FileCard({ id, file, view, wrap, isOpen, onToggle, notify }: { id: string; file: DiffFile; view: 'split' | 'unified'; wrap: boolean; isOpen: boolean; onToggle: () => void; notify?: Notify }) {
  const lines = fileLines(file);
  const directory = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
  const badge = file.status === 'added' ? 'New' : file.status === 'deleted' ? 'Deleted' : file.status === 'renamed' ? 'Renamed' : file.status === 'binary' ? 'Binary' : '';
  const language = languageForPath(file.path);
  return <div id={id} {...stylex.props(styles.file)}>
    <div {...stylex.props(styles.fileHeader)}>
      <button type="button" aria-expanded={isOpen} {...stylex.props(styles.fileToggle)} onClick={onToggle}>
        <ChevronRight size={16} strokeWidth={ICON_STROKE} aria-hidden="true" {...stylex.props(styles.chevron, isOpen && styles.chevronOpen)} />
        <span {...stylex.props(styles.path)} title={file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.status === 'renamed' && file.oldPath ? <span {...stylex.props(styles.directory)}>{file.oldPath} → </span> : directory && <span {...stylex.props(styles.directory)}>{directory}</span>}
          <span {...stylex.props(styles.basename)}>{displayName(file)}</span>
        </span>
        {badge && <span {...stylex.props(styles.badge, file.status === 'added' && styles.badgeAdded, file.status === 'deleted' && styles.badgeDeleted)}>{badge}</span>}
        <span {...stylex.props(styles.fileStats)}><span {...stylex.props(styles.added)}>+{file.additions}</span><span {...stylex.props(styles.removed)}>−{file.deletions}</span><StatBar file={file} /></span>
      </button>
      <CopyTool text={file.raw} label={`Copy ${displayName(file)} diff`} notify={notify} />
    </div>
    {isOpen ? file.status === 'binary' ? <p {...stylex.props(styles.empty)}>Binary file changed.</p>
      : !lines ? <p {...stylex.props(styles.empty)}>{file.status === 'renamed' ? 'Renamed without content changes.' : 'No content changes.'}</p>
      : <div {...stylex.props(styles.scroll, !wrap && styles.scrollX)}>{view === 'split' ? <SplitTable file={file} wrap={wrap} language={language} /> : <UnifiedTable file={file} wrap={wrap} language={language} />}</div>
      : lines > LARGE_FILE_LINES ? <button type="button" {...stylex.props(styles.showMore)} onClick={onToggle}>Show {lines} lines</button> : null}
  </div>;
}

function StatBar({ file }: { file: DiffFile }) {
  const total = file.additions + file.deletions;
  const greens = total ? Math.round((file.additions / total) * 5) : 0;
  const reds = total ? Math.min(5 - greens, Math.max(file.deletions ? 1 : 0, Math.round((file.deletions / total) * 5))) : 0;
  return <span aria-hidden="true" {...stylex.props(styles.bar)}>{Array.from({ length: 5 }, (_, index) => <span key={index} {...stylex.props(styles.barCell, index < greens ? styles.barAdd : index < greens + reds ? styles.barDel : styles.barNone)} />)}</span>;
}

function numberWidth(file: DiffFile) {
  let max = 0;
  for (const hunk of file.hunks) for (const line of hunk.lines) max = Math.max(max, line.oldNo ?? 0, line.newNo ?? 0);
  return max ? `${String(max).length + 2}ch` : '0';
}

function hunkGap(previous: DiffHunk | undefined, hunk: DiffHunk) {
  if (!previous || previous.oldStart === undefined || hunk.oldStart === undefined) return false;
  const last = [...previous.lines].reverse().find(line => line.oldNo !== undefined)?.oldNo ?? previous.oldStart;
  return hunk.oldStart > last + 1;
}

function HunkHeader({ hunk, colSpan }: { hunk: DiffHunk; colSpan: number }) {
  const label = hunk.oldStart !== undefined ? hunk.header : hunk.section;
  if (!label) return null;
  return <tr><td colSpan={colSpan} {...stylex.props(styles.hunk)}><code>{label}</code></td></tr>;
}

function UnifiedTable({ file, wrap, language }: { file: DiffFile; wrap: boolean; language?: string }) {
  const width = numberWidth(file);
  const hasNumbers = width !== '0';
  return <table {...stylex.props(styles.table, wrap && styles.tableWrap)}>
    <colgroup>{hasNumbers && <><col style={{ width }} /><col style={{ width }} /></>}<col style={{ width: '1.6ch' }} /><col /></colgroup>
    <tbody>{file.hunks.map((hunk, hunkIndex) => {
      const changes = inlineChanges(hunk.lines);
      return <Fragment key={hunkIndex}>
        {hunkGap(file.hunks[hunkIndex - 1], hunk) && !hunk.header && <tr><td colSpan={hasNumbers ? 4 : 2} {...stylex.props(styles.gap)}>⋯</td></tr>}
        <HunkHeader hunk={hunk} colSpan={hasNumbers ? 4 : 2} />
        {hunk.lines.map((line, index) => line.kind === 'note'
          ? <tr key={index}><td colSpan={hasNumbers ? 4 : 2} {...stylex.props(styles.note)}>{line.text}</td></tr>
          : <tr key={index} {...stylex.props(line.kind === 'add' && styles.rowAdd, line.kind === 'del' && styles.rowDel)}>
            {hasNumbers && <><td {...stylex.props(styles.num, line.kind === 'add' && styles.numAdd, line.kind === 'del' && styles.numDel)}>{line.oldNo ?? ''}</td><td {...stylex.props(styles.num, line.kind === 'add' && styles.numAdd, line.kind === 'del' && styles.numDel)}>{line.newNo ?? ''}</td></>}
            <td {...stylex.props(styles.sign, line.kind === 'add' && styles.signAdd, line.kind === 'del' && styles.signDel)}>{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</td>
            <td {...stylex.props(styles.code, wrap && styles.codeWrap)}><code>{renderCode(line, language, changes.get(line))}</code></td>
          </tr>)}
      </Fragment>;
    })}</tbody>
  </table>;
}

function SplitTable({ file, wrap, language }: { file: DiffFile; wrap: boolean; language?: string }) {
  const width = numberWidth(file);
  const hasNumbers = width !== '0';
  const side = (line: DiffLine | undefined, which: 'old' | 'new', changes: Map<DiffLine, [number, number]>) => {
    const kind = !line ? 'empty' : line.kind;
    const number = which === 'old' ? line?.oldNo : line?.newNo;
    return <>
      {hasNumbers && <td {...stylex.props(styles.num, kind === 'add' && styles.numAdd, kind === 'del' && styles.numDel, kind === 'empty' && styles.cellEmpty)}>{number ?? ''}</td>}
      <td {...stylex.props(styles.sign, kind === 'add' && styles.signAdd, kind === 'del' && styles.signDel, kind === 'add' && styles.rowAdd, kind === 'del' && styles.rowDel, kind === 'empty' && styles.cellEmpty)}>{kind === 'add' ? '+' : kind === 'del' ? '−' : ''}</td>
      <td {...stylex.props(styles.code, wrap && styles.codeWrap, kind === 'add' && styles.rowAdd, kind === 'del' && styles.rowDel, kind === 'empty' && styles.cellEmpty, which === 'old' && styles.splitDivider)}>{line && <code>{renderCode(line, language, line.kind === 'context' ? undefined : changes.get(line))}</code>}</td>
    </>;
  };
  const columns = hasNumbers ? 6 : 4;
  return <table {...stylex.props(styles.table, styles.tableSplit)}>
    <colgroup>{hasNumbers && <col style={{ width }} />}<col style={{ width: '1.6ch' }} /><col style={{ width: '50%' }} />{hasNumbers && <col style={{ width }} />}<col style={{ width: '1.6ch' }} /><col style={{ width: '50%' }} /></colgroup>
    <tbody>{file.hunks.map((hunk, hunkIndex) => {
      const changes = inlineChanges(hunk.lines);
      return <Fragment key={hunkIndex}>
        <HunkHeader hunk={hunk} colSpan={columns} />
        {splitRows(hunk.lines).map((row, index) => row.kind === 'note'
          ? <tr key={index}><td colSpan={columns} {...stylex.props(styles.note)}>{row.line.text}</td></tr>
          : <tr key={index}>{side(row.left, 'old', changes)}{side(row.right, 'new', changes)}</tr>)}
      </Fragment>;
    })}</tbody>
  </table>;
}

type HastNode = { type: string; value?: string; tagName?: string; properties?: { className?: string[] | string }; children?: HastNode[] };

function hastToReact(nodes: HastNode[] | undefined, key = ''): ReactNode[] {
  return (nodes ?? []).map((node, index) => node.type === 'text' ? node.value ?? ''
    : node.type === 'element' ? createElement(node.tagName ?? 'span', { key: key + index, className: Array.isArray(node.properties?.className) ? node.properties.className.join(' ') : node.properties?.className }, hastToReact(node.children, key + index + '-'))
    : null);
}

function renderCode(line: DiffLine, language: string | undefined, change: [number, number] | undefined): ReactNode {
  const text = line.text;
  if (!text) return ' ';
  if (change) {
    const [start, end] = change;
    return <>{text.slice(0, start)}<mark {...stylex.props(styles.word, line.kind === 'add' ? styles.wordAdd : styles.wordDel)}>{text.slice(start, end)}</mark>{text.slice(end)}</>;
  }
  if (language && text.length <= MAX_HIGHLIGHT_LENGTH) {
    try { return hastToReact(lowlight.highlight(language, text).children as HastNode[]); } catch { /* unknown language */ }
  }
  return text;
}

function ToolButton({ label, isPressed, onClick, children }: { label: string; isPressed?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} aria-pressed={isPressed} {...stylex.props(styles.tool, isPressed && styles.toolPressed)} onClick={onClick}>{children}</button>;
}

function CopyTool({ text, label, notify }: { text: string; label: string; notify?: Notify }) {
  const [isCopied, setCopied] = useState(false);
  useEffect(() => { if (!isCopied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer); }, [isCopied]);
  return <ToolButton label={isCopied ? 'Copied' : label} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); notify?.('Copied to clipboard', 'success'); }
    catch { notify?.('Could not copy. Use Show raw text and select it.', 'error'); }
  }}>{isCopied ? <Check size={16} strokeWidth={ICON_STROKE} /> : <Copy size={16} strokeWidth={ICON_STROKE} />}</ToolButton>;
}

const styles = stylex.create({
  panel: { minWidth: 0, maxWidth: '100%', marginTop: 16, marginBottom: 20, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 16, backgroundColor: tokens.surface, overflow: 'hidden' },
  panelFullscreen: { marginTop: 0, marginBottom: 0, borderWidth: 0, borderRadius: 0, backgroundColor: 'transparent', overflow: 'visible', '--diff-sticky-top': '43px' },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '2px 4px 2px 14px', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border, fontSize: '0.75rem', color: tokens.muted, flexWrap: 'wrap' },
  toolbarFullscreen: { position: 'sticky', top: 0, zIndex: 2, backgroundColor: tokens.canvas, padding: '4px 4px 4px 12px' },
  summary: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, fontWeight: 500 },
  tools: { display: 'inline-flex', alignItems: 'center', gap: 0, marginLeft: 'auto' },
  tool: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderWidth: 0, borderRadius: 10, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, color: tokens.muted, cursor: 'pointer', flexShrink: 0 },
  toolPressed: { color: tokens.primary },
  added: { color: 'var(--diff-add-fg)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  removed: { color: 'var(--diff-del-fg)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  muted: { color: tokens.muted, fontWeight: 400 },
  raw: { margin: 0, padding: '12px 16px', overflowX: 'auto', fontSize: '0.78rem', lineHeight: 'var(--code-line-height)', whiteSpace: 'pre', maxHeight: '70vh' },
  between: { margin: 0, padding: '8px 14px', fontSize: '0.75rem', lineHeight: 'var(--code-line-height)', color: tokens.muted, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border },
  file: { borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border, scrollMarginTop: 48, ':last-child': { borderBottomWidth: 0 } },
  fileHeader: { display: 'flex', alignItems: 'center', gap: 2, paddingRight: 4, backgroundColor: tokens.canvas, position: 'sticky', top: 'var(--diff-sticky-top, 0px)', zIndex: 1 },
  fileToggle: { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, minHeight: 44, padding: '6px 6px 6px 10px', borderWidth: 0, backgroundColor: 'transparent', color: tokens.text, textAlign: 'left', cursor: 'pointer', fontSize: '0.8125rem' },
  chevron: { flexShrink: 0, color: tokens.muted, transition: 'transform 120ms ease' },
  chevronOpen: { transform: 'rotate(90deg)' },
  path: { display: 'flex', minWidth: 0, flex: 1, whiteSpace: 'nowrap', fontFamily: 'var(--font-code)' },
  directory: { color: tokens.muted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 },
  basename: { fontWeight: 600, flexShrink: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' },
  badge: { flexShrink: 0, padding: '1px 8px', borderRadius: 999, fontSize: '0.6875rem', color: tokens.muted, backgroundColor: tokens.hover },
  badgeAdded: { color: 'var(--diff-add-fg)', backgroundColor: 'var(--diff-add-bg)' },
  badgeDeleted: { color: 'var(--diff-del-fg)', backgroundColor: 'var(--diff-del-bg)' },
  fileStats: { display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, fontSize: '0.75rem' },
  bar: { display: 'inline-flex', gap: 1 },
  barCell: { width: 7, height: 7, borderRadius: 1.5 },
  barAdd: { backgroundColor: 'var(--diff-add-fg)' },
  barDel: { backgroundColor: 'var(--diff-del-fg)' },
  barNone: { backgroundColor: tokens.border },
  empty: { margin: 0, padding: '10px 16px', fontSize: '0.8125rem', color: tokens.muted },
  showMore: { display: 'block', width: '100%', padding: '8px 16px', borderWidth: 0, backgroundColor: 'transparent', color: tokens.primary, fontSize: '0.8125rem', textAlign: 'left', cursor: 'pointer' },
  scroll: { overflowX: 'hidden', overscrollBehaviorX: 'none', touchAction: 'pan-x pan-y' },
  scrollX: { overflowX: 'auto' },
  table: { borderCollapse: 'collapse', borderSpacing: 0, minWidth: '100%', fontFamily: 'var(--font-code)', fontSize: '0.78rem', lineHeight: 'var(--code-line-height)' },
  tableWrap: { width: '100%', tableLayout: 'fixed' },
  tableSplit: { width: '100%', tableLayout: 'fixed' },
  num: { padding: '0 8px 0 4px', textAlign: 'right', color: tokens.muted, opacity: 0.75, verticalAlign: 'top', whiteSpace: 'nowrap', userSelect: 'none', fontVariantNumeric: 'tabular-nums' },
  numAdd: { backgroundColor: 'var(--diff-add-gutter)', opacity: 1 },
  numDel: { backgroundColor: 'var(--diff-del-gutter)', opacity: 1 },
  sign: { textAlign: 'center', verticalAlign: 'top', userSelect: 'none', color: tokens.muted },
  signAdd: { color: 'var(--diff-add-fg)' },
  signDel: { color: 'var(--diff-del-fg)' },
  code: { padding: '0 12px 0 2px', whiteSpace: 'pre', verticalAlign: 'top' },
  codeWrap: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  rowAdd: { backgroundColor: 'var(--diff-add-bg)' },
  rowDel: { backgroundColor: 'var(--diff-del-bg)' },
  cellEmpty: { backgroundColor: 'var(--diff-empty-bg)' },
  splitDivider: { borderRightWidth: 1, borderRightStyle: 'solid', borderRightColor: tokens.border },
  word: { color: 'inherit', borderRadius: 3, padding: '0 1px' },
  wordAdd: { backgroundColor: 'var(--diff-add-word)' },
  wordDel: { backgroundColor: 'var(--diff-del-word)' },
  hunk: { padding: '4px 12px', color: tokens.muted, backgroundColor: 'var(--diff-hunk-bg)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  gap: { padding: '2px 12px', color: tokens.muted, backgroundColor: 'var(--diff-hunk-bg)', textAlign: 'center' },
  note: { padding: '0 12px', color: tokens.muted, fontStyle: 'italic' },
  overlay: { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', flexDirection: 'column', backgroundColor: tokens.canvas, color: tokens.text, paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' },
  overlayHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 8px 8px 16px', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border },
  overlayTitle: { fontSize: '0.9375rem', fontWeight: 600 },
  overlayBody: { display: 'flex', flex: 1, minHeight: 0 },
  index: { display: 'flex', flexDirection: 'column', gap: 1, width: 'clamp(200px, 22vw, 320px)', flexShrink: 0, padding: 8, overflowY: 'auto', borderRightWidth: 1, borderRightStyle: 'solid', borderRightColor: tokens.border, '@media (max-width: 820px)': { display: 'none' } },
  indexItem: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 34, padding: '4px 8px', borderWidth: 0, borderRadius: 8, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, color: tokens.text, fontSize: '0.8125rem', textAlign: 'left', cursor: 'pointer' },
  indexName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-code)' },
  indexStats: { flexShrink: 0, fontSize: '0.75rem' },
  overlayMain: { flex: 1, minWidth: 0, overflowY: 'auto' },
});
