import { useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { FolderOpen } from 'lucide-react';
import { parseProjects } from './responses';
import { tokens } from './tokens.stylex';
import { ICON_STROKE } from './ui';
import type { UseChat } from './types';

type Project = { id: string; name: string };

/** Lets a brand-new chat start inside a project instead of moving it afterwards. */
export function ProjectPicker({ chat, value, onChange }: { chat: UseChat; value?: string; onChange: (projectId?: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void chat.request('/api/native/projects', { cache: 'no-store', signal: controller.signal })
      .then(response => response.json())
      .then(result => { if (!controller.signal.aborted) setProjects(parseProjects(result).filter(project => !project.archivedAt)); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [chat.request]);
  if (!projects.length) return null;
  return <label {...stylex.props(styles.picker)}>
    <FolderOpen size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
    <span className="sr-only">Project for new chat</span>
    <select aria-label="Project for new chat" value={value ?? ''} {...stylex.props(styles.select)} onChange={event => onChange(event.target.value || undefined)}>
      <option value="">No project</option>
      {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select>
  </label>;
}

const styles = stylex.create({
  picker: { display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 16, padding: '0 12px', height: 40, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 999, backgroundColor: tokens.canvas, color: tokens.text },
  select: { maxWidth: 'min(240px, 60vw)', borderWidth: 0, backgroundColor: 'transparent', color: tokens.text, fontFamily: tokens.font, fontSize: '0.875rem', outline: 'none' },
});
