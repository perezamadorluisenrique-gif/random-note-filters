// Pure logic: no `obsidian` import, so tests/ can run it under plain Node.

/** What the plugin knows about one note when it builds a pool to draw from. */
export interface Candidate {
  path: string;
  /** Tags with their `#`, as `getAllTags` returns them (body and front matter). */
  tags: string[];
  /** Number of other notes linking to this one. */
  backlinks: number;
  /** Front matter, or an empty object. */
  props: Record<string, unknown>;
}

export interface Filter {
  /** Vault-relative folder, without a trailing slash. `""` is the whole vault. */
  folder?: string;
  /** Tag with or without `#`. Nested tags match their parent: `project` matches `#project/x`. */
  tag?: string;
  property?: { key: string; value: string };
  /** Only notes that no other note links to. */
  orphansOnly?: boolean;
  /** Only these paths (the search results). */
  paths?: ReadonlySet<string>;
}

export interface Excludes {
  folders: string[];
  tags: string[];
}

/** Splits a comma- or line-separated setting into trimmed, non-empty entries. */
export function parseList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function normaliseFolder(folder: string): string {
  return folder.trim().replace(/^\/+|\/+$/g, '');
}

export function normaliseTag(tag: string): string {
  return tag.trim().replace(/^#/, '').toLowerCase();
}

export function inFolder(path: string, folder: string): boolean {
  const f = normaliseFolder(folder);
  if (!f) return true;
  return path.startsWith(f + '/');
}

/** `want` matches a tag equal to it or nested below it, ignoring case and `#`. */
export function hasTag(tags: readonly string[], want: string): boolean {
  const w = normaliseTag(want);
  if (!w) return false;
  return tags.some((t) => {
    const n = normaliseTag(t);
    return n === w || n.startsWith(w + '/');
  });
}

/** Strings a front matter value counts as: a list gives each item, a scalar itself. */
export function propertyValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return (value as unknown[]).reduce<string[]>((acc, v) => acc.concat(propertyValues(v)), []);
  if (typeof value === 'string') return [value.trim()];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  return [];
}

export function hasProperty(props: Record<string, unknown>, key: string, value: string): boolean {
  const k = Object.keys(props).find((p) => p.toLowerCase() === key.toLowerCase());
  if (k === undefined) return false;
  const want = value.trim().toLowerCase();
  return propertyValues(props[k]).some((v) => v.toLowerCase() === want);
}

export function isExcluded(c: Candidate, ex: Excludes): boolean {
  if (ex.folders.some((f) => normaliseFolder(f) && inFolder(c.path, f))) return true;
  return ex.tags.some((t) => hasTag(c.tags, t));
}

export function matches(c: Candidate, f: Filter): boolean {
  if (f.folder !== undefined && !inFolder(c.path, f.folder)) return false;
  if (f.tag !== undefined && !hasTag(c.tags, f.tag)) return false;
  if (f.property && !hasProperty(c.props, f.property.key, f.property.value)) return false;
  if (f.orphansOnly && c.backlinks > 0) return false;
  if (f.paths && !f.paths.has(c.path)) return false;
  return true;
}

/** The notes a draw can pick from: the filter applied, exclusions removed, the current note left out. */
export function buildPool(all: readonly Candidate[], f: Filter, ex: Excludes, currentPath?: string): Candidate[] {
  return all.filter((c) => c.path !== currentPath && !isExcluded(c, ex) && matches(c, f));
}

/**
 * Picks one path at random, avoiding the `recent` ones while anything else is left.
 * When the pool is smaller than the recent list the oldest repeats come back first, so
 * a small pool still cycles through everything before it repeats.
 * `rng` returns a number in [0, 1), like `Math.random`.
 */
export function pickRandom(pool: readonly string[], recent: readonly string[], rng: () => number): string | undefined {
  if (!pool.length) return undefined;
  const seen = new Set(recent);
  const fresh = pool.filter((p) => !seen.has(p));
  let from: readonly string[] = fresh;
  if (!fresh.length) {
    // Everything was seen lately: take the one seen longest ago, keeping a draw for ties of "never listed".
    const order = new Map(recent.map((p, i) => [p, i] as const));
    const oldest = Math.min(...pool.map((p) => order.get(p) ?? -1));
    from = pool.filter((p) => (order.get(p) ?? -1) === oldest);
  }
  const i = Math.min(from.length - 1, Math.floor(rng() * from.length));
  return from[i];
}

/** Adds a path to the end of the recent list, without duplicates, keeping at most `limit`. */
export function pushRecent(recent: readonly string[], path: string, limit: number): string[] {
  if (limit <= 0) return [];
  const next = recent.filter((p) => p !== path);
  next.push(path);
  return next.slice(-limit);
}

/** Follows a rename in the recent list. */
export function renameRecent(recent: readonly string[], from: string, to: string): string[] {
  return recent.map((p) => (p === from ? to : p));
}

/** Every `key: value` pair front matter holds, with how many notes carry it, most common first. */
export function propertyPairs(all: readonly Candidate[], limit = 500): { key: string; value: string; count: number }[] {
  const counts = new Map<string, { key: string; value: string; count: number }>();
  for (const c of all) {
    for (const [key, raw] of Object.entries(c.props)) {
      if (key === 'position') continue;
      for (const value of new Set(propertyValues(raw))) {
        if (!value || value.length > 80) continue;
        const id = `${key.toLowerCase()}\u0000${value.toLowerCase()}`;
        const e = counts.get(id);
        if (e) e.count++;
        else counts.set(id, { key, value, count: 1 });
      }
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key) || a.value.localeCompare(b.value)).slice(0, limit);
}

/** Folders that hold at least one note, with the count, fullest first. */
export function folderCounts(all: readonly Candidate[]): { folder: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of all) {
    const parts = c.path.split('/');
    parts.pop();
    for (let i = 1; i <= parts.length; i++) {
      const f = parts.slice(0, i).join('/');
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([folder, count]) => ({ folder, count })).sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));
}

/** Tags with the count of notes carrying each, nested tags counted under their parents too. */
export function tagCounts(all: readonly Candidate[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of all) {
    const seen = new Set<string>();
    for (const t of c.tags) {
      const parts = normaliseTag(t).split('/');
      for (let i = 1; i <= parts.length; i++) seen.add(parts.slice(0, i).join('/'));
    }
    for (const t of seen) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
