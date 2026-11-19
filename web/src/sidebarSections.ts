export type SectionProject = { id: string; name: string };

/** One section per project (in the project list's own order, "No project" last); inside it pinned chats first, then the rest by date. */
export function projectSections<T extends { projectId?: string; isPinned?: boolean; mtime: number }>(sessions: T[], projects: SectionProject[], sort: 'newest' | 'oldest', isActiveView: boolean): { title: string; sessions: T[] }[] {
  const names = new Map(projects.map(project => [project.id, project.name]));
  const order = new Map(projects.map((project, index) => [project.id, index]));
  const groups = new Map<string, T[]>();
  for (const session of sessions) {
    const key = session.projectId ?? '';
    const list = groups.get(key);
    if (list) list.push(session); else groups.set(key, [session]);
  }
  const rank = (key: string) => key === '' ? Number.MAX_SAFE_INTEGER : order.get(key) ?? 1_000_000;
  const byDate = (left: T, right: T) => sort === 'oldest' ? left.mtime - right.mtime : right.mtime - left.mtime;
  return [...groups.entries()]
    .sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right))
    .map(([key, list]) => {
      const pinned = isActiveView ? list.filter(session => session.isPinned).sort(byDate) : [];
      const rest = list.filter(session => !pinned.includes(session)).sort(byDate);
      return { title: key === '' ? 'No project' : names.get(key) ?? key, sessions: [...pinned, ...rest] };
    });
}
