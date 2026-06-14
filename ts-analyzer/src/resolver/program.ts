/**
 * ts.Program + TypeChecker construction — the analog of the backend's
 * AnalysisSession.kt (which wraps the K1 compiler frontend). One Program per
 * project gives us cross-file symbol resolution (the TypeChecker is our
 * BindingContext). We honor the target's own tsconfig `paths`/`baseUrl` so
 * `@/...` aliases resolve, and fall back to vite.config alias parsing.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { SKIP_DIRS, SOURCE_EXTENSIONS } from '../classify';

export interface ProjectProgram {
  project: string; // .repo/<project> basename
  rootDir: string; // absolute project root
  program: ts.Program;
  checker: ts.TypeChecker;
  sourceFiles: ts.SourceFile[]; // project files only (no node_modules/lib)
  repoRoot: string; // absolute repo root, for repo-relative paths
}

/** Strip the synthetic ".ts" the Vue program appends to ".vue" files (foo.vue.ts → foo.vue). */
export function realFileName(file: string): string {
  return file.endsWith('.vue.ts') ? file.slice(0, -3) : file;
}

/** repo-relative path with forward slashes, e.g. "sample-shop-react/src/api/user.ts". */
export function repoRel(repoRoot: string, file: string): string {
  return path.relative(repoRoot, realFileName(file)).split(path.sep).join('/');
}

/** provenance: project = parts[0], module = parts[1] (if it looks like a module dir). */
export function provenance(rel: string): { project: string | null; module: string | null } {
  const parts = rel.split('/');
  return { project: parts[0] ?? null, module: parts.length > 2 ? parts[1] : null };
}

function isSourceFile(name: string, extraExts: string[]): boolean {
  if (name.endsWith('.d.ts')) return false;
  return SOURCE_EXTENSIONS.some((e) => name.endsWith(e)) || extraExts.some((e) => name.endsWith(e));
}

/** Recursively collect source files under a dir, skipping SKIP_DIRS. `extraExts` adds e.g. ['.vue']. */
export function collectSourceFiles(root: string, extraExts: string[] = []): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile() && isSourceFile(e.name, extraExts)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Heuristic: a React project has `react` in package.json deps OR any .tsx/.jsx file. */
export function isReactProject(rootDir: string): boolean {
  const pkgPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps.react || deps.next) return true;
      // explicit non-React frameworks → skip even if stray jsx present
      if (deps.vue || deps.nuxt || deps['@angular/core']) return false;
    } catch {
      /* ignore malformed package.json */
    }
  }
  return collectSourceFiles(rootDir).some((f) => f.endsWith('.tsx') || f.endsWith('.jsx'));
}

/** A Vue/Nuxt project: `vue`/`nuxt` in package.json deps, or any `.vue` file present. */
export function isVueProject(rootDir: string): boolean {
  const pkgPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps.vue || deps.nuxt) return true;
      if (deps.react || deps.next || deps['@angular/core']) return false;
    } catch {
      /* ignore */
    }
  }
  return collectSourceFiles(rootDir, ['.vue']).length > 0;
}

/**
 * True if `repoRoot` should be analyzed AS the single project (it declares a
 * framework dep, is NOT a monorepo workspace root, and any `--project` filter
 * matches its own basename). Workspaces are left to the split path, which
 * fragments them into member packages.
 */
function isSelfProject(repoRoot: string, deps: string[], projectFilter?: string | null): boolean {
  const pkgPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.workspaces) return false; // monorepo root → split into members instead
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (!deps.some((d) => all[d])) return false;
    return !projectFilter || projectFilter === path.basename(path.resolve(repoRoot));
  } catch {
    return false;
  }
}

/** Discover Vue project roots directly under repoRoot. */
export function discoverVueProjects(repoRoot: string, projectFilter?: string | null): string[] {
  // repoRoot may itself BE a Vue project (`--repo .repo/my-nuxt-app`) — analyze it
  // as one unit instead of fragmenting its components/, pages/, … into projects.
  if (isSelfProject(repoRoot, ['vue', 'nuxt'], projectFilter)) return [path.resolve(repoRoot)];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .filter((name) => !projectFilter || name === projectFilter)
    .map((name) => path.join(repoRoot, name))
    .filter((dir) => isVueProject(dir));
}

/** Whether a project uses Next.js (so filesystem routing under pages/ or app/ applies). */
export function isNextProject(rootDir: string): boolean {
  const pkgPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return !!deps.next;
  } catch {
    return false;
  }
}

/** Discover project roots directly under repoRoot that are React projects. */
export function discoverProjects(repoRoot: string, projectFilter?: string | null): string[] {
  // repoRoot may itself BE a React project (`--repo .repo/my-app`) — analyze it
  // as one unit instead of fragmenting its src/components, src/pages, … .
  if (isSelfProject(repoRoot, ['react', 'next'], projectFilter)) return [path.resolve(repoRoot)];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .filter((name) => !projectFilter || name === projectFilter)
    .map((name) => path.join(repoRoot, name))
    .filter((dir) => isReactProject(dir));
}

/** Read tsconfig compilerOptions (paths/baseUrl) for the project, if present. */
function readTsconfigOptions(rootDir: string): ts.CompilerOptions {
  const tsconfigPath = ts.findConfigFile(rootDir, ts.sys.fileExists, 'tsconfig.json');
  if (!tsconfigPath || !tsconfigPath.startsWith(rootDir)) return {};
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error || !read.config) return {};
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfigPath));
  return parsed.options ?? {};
}

// ---- monorepo / pnpm-turbo workspace resolution ----

interface PkgJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

function readPkgJson(dir: string): PkgJson | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as PkgJson;
  } catch {
    return null;
  }
}

/** Nearest ancestor (incl. self) that is a workspace root: pnpm-workspace.yaml or a
 *  package.json `workspaces` field. */
function findWorkspaceRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (readPkgJson(dir)?.workspaces) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Member globs of a workspace (pnpm-workspace.yaml first, then package.json workspaces). */
function workspaceMemberGlobs(wsRoot: string): string[] {
  const pnpm = path.join(wsRoot, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpm)) {
    try {
      return parsePnpmPackages(fs.readFileSync(pnpm, 'utf8'));
    } catch {
      /* fall through */
    }
  }
  const ws = readPkgJson(wsRoot)?.workspaces;
  return Array.isArray(ws) ? ws : ws?.packages ?? [];
}

/** Minimal pnpm-workspace.yaml `packages:` list parser (no YAML dep). Skips `!` negations. */
function parsePnpmPackages(text: string): string[] {
  const out: string[] = [];
  let inList = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '');
    if (/^packages\s*:/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const m = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
    if (m) {
      const g = m[1].trim();
      if (!g.startsWith('!')) out.push(g);
    } else if (/^\S/.test(line)) break; // dedent to next top-level key
  }
  return out;
}

/** package name → absolute dir for every workspace member. */
function workspacePackageRegistry(wsRoot: string): Map<string, string> {
  const reg = new Map<string, string>();
  for (const glob of workspaceMemberGlobs(wsRoot)) {
    const star = glob.indexOf('*');
    const dirs: string[] = [];
    if (star === -1) {
      const abs = path.resolve(wsRoot, glob);
      if (fs.existsSync(path.join(abs, 'package.json'))) dirs.push(abs);
    } else {
      const base = path.resolve(wsRoot, glob.slice(0, star).replace(/\/$/, ''));
      try {
        for (const e of fs.readdirSync(base, { withFileTypes: true })) {
          if (e.isDirectory() && fs.existsSync(path.join(base, e.name, 'package.json'))) dirs.push(path.join(base, e.name));
        }
      } catch {
        /* missing base */
      }
    }
    for (const d of dirs) {
      const name = readPkgJson(d)?.name;
      if (name) reg.set(name, d);
    }
  }
  return reg;
}

/** Workspace packages the app at `appDir` depends on, transitively (name → dir). */
function transitiveWorkspaceDeps(appDir: string, registry: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  const queue: string[] = [appDir];
  while (queue.length) {
    const dir = queue.shift()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    const pkg = readPkgJson(dir);
    if (!pkg) continue;
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
    for (const name of Object.keys(deps)) {
      const depDir = registry.get(name);
      if (depDir && depDir !== appDir && !out.has(name)) {
        out.set(name, depDir);
        queue.push(depDir);
      }
    }
  }
  return out;
}

/** tsconfig-style `paths` + extra source files so an app's workspace deps resolve
 *  WITHOUT node_modules (`@scope/common` → ../common/src), and their wrappers/components
 *  are in the project file set (cross-package tracing). */
function workspaceResolution(rootDir: string, baseUrl: string): { paths: ts.MapLike<string[]>; files: string[] } {
  const wsRoot = findWorkspaceRoot(rootDir);
  if (!wsRoot) return { paths: {}, files: [] };
  const registry = workspacePackageRegistry(wsRoot);
  if (!registry.size) return { paths: {}, files: [] };
  const deps = transitiveWorkspaceDeps(rootDir, registry);
  const paths: ts.MapLike<string[]> = {};
  const files: string[] = [];
  for (const [name, dir] of deps) {
    const src = fs.existsSync(path.join(dir, 'src')) ? path.join(dir, 'src') : dir;
    const rel = path.relative(baseUrl, src).split(path.sep).join('/') || '.';
    paths[name] = [`${rel}/index`, rel];
    paths[`${name}/*`] = [`${rel}/*`];
    files.push(...collectSourceFiles(dir));
  }
  return { paths, files };
}

/** Best-effort: parse `resolve.alias` from a vite config into tsconfig-style paths. */
function readViteAliases(rootDir: string): ts.MapLike<string[]> | undefined {
  const candidates = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'].map((f) => path.join(rootDir, f));
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const paths: ts.MapLike<string[]> = {};
  // matches: '@': path.resolve(__dirname, './src')   or   '@': '/abs/src'
  const re = /['"]([^'"]+)['"]\s*:\s*(?:path\.resolve\([^,]*,\s*)?['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const alias = m[1];
    const target = m[2].replace(/^\.\//, '');
    paths[`${alias}/*`] = [`${target}/*`];
    paths[alias] = [target];
  }
  return Object.keys(paths).length ? paths : undefined;
}

export interface BuildOptions {
  repoRoot: string;
  aliasOverride?: ts.MapLike<string[]>;
}

export function buildProjectProgram(rootDir: string, opts: BuildOptions): ProjectProgram {
  const tsconfig = readTsconfigOptions(rootDir);
  const viteAliases = readViteAliases(rootDir);
  const baseUrl = tsconfig.baseUrl ?? rootDir;

  // pnpm/turbo monorepo: pull in the app's workspace dependency packages so
  // `@scope/common` imports resolve (no node_modules) and cross-package wrappers trace.
  const ws = workspaceResolution(rootDir, baseUrl);
  const fileNames = [...new Set([...collectSourceFiles(rootDir), ...ws.files])];

  // explicit override wins, then the target's own tsconfig/vite aliases, then workspace paths.
  const ownPaths = opts.aliasOverride ?? tsconfig.paths ?? viteAliases;
  const mergedPaths = { ...ws.paths, ...(ownPaths ?? {}) };

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2021,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    allowNonTsExtensions: true,
    resolveJsonModule: true,
    baseUrl,
    paths: Object.keys(mergedPaths).length ? mergedPaths : undefined,
  };

  const program = ts.createProgram(fileNames, options);
  const checker = program.getTypeChecker();
  const fileSet = new Set(fileNames.map((f) => path.resolve(f)));
  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => fileSet.has(path.resolve(sf.fileName)));

  return {
    project: path.basename(rootDir),
    rootDir,
    program,
    checker,
    sourceFiles,
    repoRoot: opts.repoRoot,
  };
}
