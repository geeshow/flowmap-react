/**
 * Generic project-root discovery for memory-bounded analysis. Unlike
 * `discoverProjects` (which only looks one level under repoRoot), this walks the
 * tree and splits monorepo workspaces into their member packages, so a single
 * huge "workspace" project becomes many small `ts.Program`s — each analyzable in
 * its own child process. The split is structure-agnostic: it keys off
 * package.json (workspaces field / framework deps), not hardcoded directory names.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SKIP_DIRS } from '../classify';
import { collectSourceFiles } from './program';

const MAX_DEPTH = 6;

type PkgKind = 'workspace' | 'app' | null;

interface Pkg {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

function readPkg(dir: string): Pkg | null {
  const p = path.join(dir, 'package.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Pkg;
  } catch {
    return null;
  }
}

const FRAMEWORK_DEPS = ['react', 'next', 'vue', 'nuxt'];

function pkgKind(dir: string): PkgKind {
  const pkg = readPkg(dir);
  if (!pkg) return null;
  // A workspace root (npm/yarn/pnpm `workspaces`) is split into members, even if
  // it also declares a framework dep at the root.
  if (pkg.workspaces) return 'workspace';
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (FRAMEWORK_DEPS.some((d) => deps[d])) return 'app';
  return null;
}

/** Immediate child directories, skipping SKIP_DIRS. */
function childDirs(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name));
}

/** Does this dir hold analyzable source directly within it (cheap-ish fallback)? */
function isProjectBySource(dir: string): boolean {
  return collectSourceFiles(dir, ['.vue']).some(
    (f) => f.endsWith('.tsx') || f.endsWith('.jsx') || f.endsWith('.vue'),
  );
}

/** Expand a workspace root's member globs into existing absolute directories. */
function expandWorkspaceMembers(dir: string, pkg: Pkg): string[] {
  const patterns = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : pkg.workspaces?.packages ?? [];
  const out = new Set<string>();
  for (const pattern of patterns) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      const abs = path.resolve(dir, pattern);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) out.add(abs);
      continue;
    }
    // `prefix/*` or `prefix/**` → list immediate subdirs of prefix.
    const prefix = pattern.slice(0, star).replace(/\/$/, '');
    const base = path.resolve(dir, prefix);
    for (const sub of childDirs(base)) out.add(sub);
  }
  return [...out];
}

function collect(dir: string, depth: number, roots: Set<string>): void {
  const kind = pkgKind(dir);
  if (kind === 'app') {
    roots.add(dir); // leaf project — do not descend into its own subpackages
    return;
  }
  if (kind === 'workspace') {
    const members = expandWorkspaceMembers(dir, readPkg(dir)!);
    if (members.length) {
      for (const m of members) collect(m, depth + 1, roots);
      return;
    }
    // workspaces field present but unresolvable — fall through to a plain scan
  }
  if (depth >= MAX_DEPTH) {
    if (isProjectBySource(dir)) roots.add(dir);
    return;
  }
  const before = roots.size;
  for (const sub of childDirs(dir)) collect(sub, depth + 1, roots);
  // Source-only fallback ONLY at the top level — never split an app's own
  // src/components, src/pages, … into separate "projects".
  if (roots.size === before && depth === 0 && isProjectBySource(dir)) roots.add(dir);
}

/**
 * Discover analyzable project roots under `repoRoot`. If `repoRoot` is itself a
 * project (or workspace) — e.g. `--repo .repo/my-app` — it is treated as the one
 * root rather than fragmented into its source subdirs. Otherwise `repoRoot` is a
 * container of project dirs (the `.repo/<project>` convention); `filter`
 * restricts to the child of that name (matching `--project`). Workspaces split
 * into member packages. Returns absolute dirs, sorted.
 */
export function discoverProjectRoots(repoRoot: string, filter?: string | null): string[] {
  const root = path.resolve(repoRoot);

  // repoRoot is itself an app/workspace → collect it directly (no child scan).
  if (pkgKind(root) !== null) {
    const roots = new Set<string>();
    collect(root, 0, roots);
    return [...roots].sort();
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots = new Set<string>();
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    if (filter && e.name !== filter) continue;
    collect(path.join(root, e.name), 0, roots);
  }
  return [...roots].sort();
}
