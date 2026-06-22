#!/usr/bin/env node
/**
 * CLI mirroring the backend Cli.kt:
 *   analyze --repo <dir> [--project P] [--out f.json] [--env kv.txt]
 *   join    --graph front.json --backend backend.json [--out join.json]
 *   search  --method M [--graph g.json | --repo <dir>] [--direction both|callers|callees] [--depth N]
 *   stats   [--graph g.json | --repo <dir>]
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { bfs, Direction, findNodes } from './bfs';
import { GraphBuilder } from './graphBuilder';
import { join as joinGraphs, Affinity } from './join';
import * as jsonOutput from './jsonOutput';
import { CallGraph, CallEdge, MethodNode } from './model';
import { checkGraph, formatHealth } from './doctor';
import type { IrFile } from './ir';
import { TsResolver } from './resolver/irBuilder';
import { isReactProject, isVueProject, repoRel } from './resolver/program';
import { discoverProjectRoots } from './resolver/projectScan';
import { VueResolver } from './resolver/vue/vueIrBuilder';
import { buildScreens } from './screens';
import { ensureHeap, planWorkers, runProjectWorkersByRoot } from './workers';
import * as impact from './impact/impact';
import * as gitSource from './impact/git';
import * as putPulls from './impact/pulls';

interface Opts {
  flags: Record<string, string>;
}

function parseOpts(args: string[]): Opts {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const next = args[i + 1];
      // A flag whose next token is another flag (or absent) is boolean, e.g.
      // `--no-split`. This keeps boolean flags from swallowing the next option.
      if (next === undefined || next.startsWith('--')) {
        flags[a] = '';
      } else {
        flags[a] = next;
        i++;
      }
    }
  }
  return { flags };
}

function loadEnvFile(path?: string): Record<string, string> {
  if (!path || !fs.existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Analyze ONE project root in-process (React and/or Vue) → IrFile[]. */
function analyzeOneRoot(root: string, repoRoot: string, opts: Opts): IrFile[] {
  const common = {
    repoRoot,
    projectFilter: null,
    env: loadEnvFile(opts.flags['--env']),
    envProfile: opts.flags['--env-profile'] || null,
  };
  const files: IrFile[] = [];
  if (isReactProject(root)) files.push(...new TsResolver().analyzeRoot(root, repoRoot, common));
  if (isVueProject(root)) {
    files.push(...new VueResolver().analyzeRoot(root, repoRoot, { ...common, mode: opts.flags['--mode'] ?? 'development' }));
  }
  return files;
}

/** A discovered project root analyzed as its own service: a self-contained graph. */
interface ServiceResult {
  name: string; // service id (repo-relative path, sanitized): "sample-shop-react", "packages-nextjs"
  root: string; // repo-relative root dir
  graph: CallGraph;
  fileCount: number;
}

/**
 * Service id from a root dir: repo-relative path with separators → "-"
 * (collision-safe). A leading `<project>/` segment is dropped so per-root
 * filenames don't repeat the project name (the `<name>` prefix already carries
 * it): `<name>-<project>-<sub-root>.json` → `<name>-<sub-root>.json`.
 */
function serviceName(repoRoot: string, root: string, project?: string | null): string {
  let rel = path.relative(repoRoot, root).split(path.sep).join('/');
  if (project && (rel === project || rel.startsWith(`${project}/`))) {
    rel = rel.slice(project.length).replace(/^\//, '');
  }
  return (rel || path.basename(root)).replace(/\//g, '-');
}

/**
 * Output provenance for a service root → `{ namespace, repo, perRoot }`, driving the nested
 * layout `<out-dir>/<namespace>/<repo>/<perRoot>/`. Mirrors the spring/nexcore rule:
 *  - the service is its OWN cloned repo under `.repo` (its git root lives under repoRootAbs) →
 *    `(owner, repoName)` from its origin remote (falling back to the git-dir basename);
 *  - otherwise (a demo bundled inside the analyzer's own repo — its git root walks up past
 *    `.repo`) → namespace `"samples"`, repo = the root's basename.
 * perRoot is the flattened service id ([serviceName]).
 */
function serviceProvenance(
  repoRootAbs: string,
  root: string,
  perRoot: string,
): { namespace: string; repo: string; perRoot: string } {
  const target = gitSource.resolveGitTarget(repoRootAbs, root);
  const gitDir = target ? path.resolve(target.gitDir) : null;
  if (gitDir && gitDir.startsWith(repoRootAbs + path.sep)) {
    const nr = gitSource.namespaceRepo(gitDir);
    if (nr) return { ...nr, perRoot };
    const b = path.basename(gitDir);
    return { namespace: b, repo: b, perRoot };
  }
  return { namespace: 'samples', repo: path.basename(path.resolve(repoRootAbs, root)), perRoot };
}

/** Nested per-service dir under the output `projects` root: `<dir>/<namespace>/<repo>/<perRoot>/`. */
function serviceDirOf(dir: string, prov: { namespace: string; repo: string; perRoot: string }): string {
  return path.join(dir, prov.namespace, prov.repo, prov.perRoot);
}

/**
 * Analyze the repo into BOTH a combined graph and one self-contained graph per
 * project root (each root is treated as a distinct "service"). Per-root grouping
 * is preserved (workers return per-root IR), so a monorepo app's cross-package
 * deps land in that app's own service graph.
 */
async function analyzeRepoSplit(opts: Opts): Promise<{ combined: CallGraph; fileCount: number; repo: string; services: ServiceResult[] }> {
  const repo = opts.flags['--repo'] ?? '../.repo';
  const repoRoot = path.resolve(repo);
  const splitOff = '--no-split' in opts.flags;
  const w = parseInt(opts.flags['--workers'] ?? '', 10);
  const requestedWorkers = Number.isFinite(w) && w > 0 ? w : null; // ignore missing/NaN/<=0

  // Single source of truth for the project set, so output is IDENTICAL whether
  // we split into child processes or run in-process.
  const roots = discoverProjectRoots(repo, opts.flags['--project'] ?? null);
  let perRoot: IrFile[][];
  if (!splitOff && roots.length > 1 && (requestedWorkers ?? 2) > 1) {
    // Per-root child processes so each giant ts.Program's memory is freed on exit.
    const plan = planWorkers(roots.length, requestedWorkers);
    const batches = await runProjectWorkersByRoot(roots, plan, {
      entry: process.argv[1],
      repoRoot,
      envFile: opts.flags['--env'] || undefined,
      envProfile: opts.flags['--env-profile'] || undefined,
      mode: opts.flags['--mode'] || undefined,
    });
    perRoot = batches.map((b) => b ?? []);
  } else {
    perRoot = roots.map((root) => analyzeOneRoot(root, repoRoot, opts));
  }

  const services: ServiceResult[] = roots.map((root, i) => ({
    name: serviceName(repoRoot, root, opts.flags['--project'] ?? null),
    root: repoRel(repoRoot, root),
    graph: new GraphBuilder(perRoot[i]).build(),
    fileCount: perRoot[i].length,
  }));
  const allFiles = perRoot.flat();
  const combined = new GraphBuilder(allFiles).build();
  return { combined, fileCount: allFiles.length, repo, services };
}

async function analyzeRepo(opts: Opts): Promise<{ graph: CallGraph; fileCount: number; repo: string }> {
  const { combined, fileCount, repo } = await analyzeRepoSplit(opts);
  return { graph: combined, fileCount, repo };
}

/** Hidden worker entrypoint: analyze ONE project root and write IrFile[] JSON. */
function cmdIr(opts: Opts): void {
  const root = path.resolve(opts.flags['--root'] ?? '.');
  const repoRoot = path.resolve(opts.flags['--repo'] ?? '../.repo');
  const files = analyzeOneRoot(root, repoRoot, opts);
  const out = opts.flags['--out'];
  if (out) fs.writeFileSync(out, JSON.stringify(files));
  else process.stdout.write(JSON.stringify(files));
}

/**
 * Load a fe-svc → backend-project affinity map from a JSON file. Accepts either a
 * bare object (`{ "fe-svc": ["be-proj*"] }`) or one nested under an `affinity` key
 * (so a single `flowmap.affinity.json` can carry other settings too). A string
 * value is treated as a one-element list. Missing/unreadable file → empty map (no-op).
 */
function loadAffinity(file?: string): Affinity {
  const m = new Map<string, string[]>();
  if (!file || !fs.existsSync(file)) return m;
  try {
    const root = JSON.parse(fs.readFileSync(file, 'utf8'));
    const obj = root && typeof root.affinity === 'object' && root.affinity ? root.affinity : root;
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (Array.isArray(v)) m.set(k, v.map(String));
      else if (typeof v === 'string') m.set(k, [v]);
    }
  } catch (e) {
    process.stderr.write(`join: ignoring unreadable --affinity ${file}: ${(e as Error).message}\n`);
  }
  return m;
}

/** The service name a frontend graph records in `meta.project` — the affinity key. */
function readGraphMetaProject(graphPath: string): string | null {
  try {
    return JSON.parse(fs.readFileSync(graphPath, 'utf8')).meta?.project ?? null;
  } catch {
    return null;
  }
}

function readGraphFile(p: string): CallGraph {
  if (!fs.existsSync(p)) {
    process.stderr.write(`graph file not found: ${p}\n`);
    process.exit(1);
  }
  return jsonOutput.read(fs.readFileSync(p, 'utf8'));
}

/**
 * The analyzed root (repo-relative) a graph records in `meta.root` — e.g.
 * `front-official-desktop` for a standalone repo, `my-mono/packages/web` for a
 * monorepo package. Drives impact's git-target resolution. Falls back to
 * `meta.project`, then '' (the repo root).
 */
function readGraphMetaRoot(graphPath: string): string {
  try {
    const meta = JSON.parse(fs.readFileSync(graphPath, 'utf8')).meta ?? {};
    return String(meta.root ?? meta.project ?? '');
  } catch {
    return '';
  }
}

/** In-graph changed node ids recorded in an existing PR shard — for incremental aggregate union. */
function readShardChangedInGraph(shardDir: string, prNumber: number): string[] {
  try {
    const shard = JSON.parse(fs.readFileSync(path.join(shardDir, `${prNumber}.json`), 'utf8'));
    return ((shard.changedNodes as Array<{ id: string; inGraph?: boolean }>) ?? [])
      .filter((c) => c?.inGraph)
      .map((c) => c.id);
  } catch {
    return [];
  }
}

async function graphFromOpts(opts: Opts): Promise<CallGraph> {
  if (opts.flags['--graph']) return readGraphFile(opts.flags['--graph']);
  return (await analyzeRepo(opts)).graph;
}

function dump(graph: CallGraph, out: string | undefined, meta: Record<string, unknown>): void {
  const text = jsonOutput.write(graph, meta);
  if (out) {
    fs.writeFileSync(out, text);
    process.stderr.write(`wrote ${out}: ${graph.nodes.length} nodes, ${graph.edges.length} edges\n`);
  } else {
    process.stdout.write(text + '\n');
  }
}

/**
 * Graph files to join against the backend, derived from disk so it works even
 * when analyze didn't run this invocation (e.g. `pipeline --only join`). Each
 * service is a subdirectory holding its `<base>.json` graph (derived
 * .join/.screens/.openapi/.impact siblings live alongside but are not graphs).
 * Returns one `<dir>/<service>/<base>.json` path per service.
 */
function listGraphsToJoin(dir: string, base: string): string[] {
  const out: string[] = [];
  function rec(d: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    const g = path.join(d, `${base}.json`);
    if (fs.existsSync(g)) out.push(g);
    for (const e of entries) {
      if (e.isDirectory() && !e.name.endsWith('.impact') && !e.name.endsWith('.pulls')) rec(path.join(d, e.name));
    }
  }
  rec(dir);
  return out.sort();
}

/** Rescan the output directory of `out` and (re)write `_manifest.json`. */
function refreshManifest(out: string | undefined): void {
  if (!out) return;
  const dir = path.dirname(out) || '.';
  try {
    jsonOutput.writeManifest(dir);
    process.stderr.write(`wrote ${path.join(dir, '_manifest.json')}\n`);
  } catch (e) {
    process.stderr.write(`manifest: ${(e as Error).message}\n`);
  }
}

async function cmdAnalyze(opts: Opts): Promise<void> {
  const { combined, fileCount, repo, services } = await analyzeRepoSplit(opts);
  const out = opts.flags['--out'];

  // Each project root → its OWN self-contained graph under a per-service
  // directory: `<dir>/<service>/<name>.json`. We deliberately do NOT emit a
  // merged whole-repo graph: merging large independent services back into one
  // defeats the point of splitting them (and collapses same-id nodes across
  // services). Every analyzed node belongs to exactly one root. The
  // _manifest.json rescans the dir and catalogues each service graph.
  if (out && services.length >= 1) {
    const dir = path.dirname(out) || '.';
    const base = path.basename(out, '.json');
    const repoRootAbs = path.resolve(repo);
    for (const s of services) {
      // namespace/repo from the service's git origin (or "samples" for a bundled demo);
      // drives both the nested output dir and the manifest grouping (deploy/PR-impact).
      const prov = serviceProvenance(repoRootAbs, s.root, s.name);
      const svcDir = serviceDirOf(dir, prov);
      fs.mkdirSync(svcDir, { recursive: true });
      dump(s.graph, path.join(svcDir, `${base}.json`), {
        command: 'analyze',
        repo,
        project: s.name,
        root: s.root,
        gitNamespace: prov.namespace,
        gitRepo: prov.repo,
        files: s.fileCount,
        nodes: s.graph.nodes.length,
        edges: s.graph.edges.length,
      });
    }
    refreshManifest(out);
    return;
  }

  // No project roots discovered, or stdout (no --out): emit the combined graph.
  dump(combined, out, {
    command: 'analyze',
    repo,
    project: opts.flags['--project'] ?? null,
    files: fileCount,
    nodes: combined.nodes.length,
    edges: combined.edges.length,
    services: services.map((s) => s.name),
  });
  refreshManifest(out);
}

/** Split a `--backend`/BACKEND value into one or more graph paths (CSV). */
function backendPaths(arg: string): string[] {
  return arg.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Merge several backend graphs into one (nodes deduped by id, edges by
 * source/target/relation). The join only reads backend nodes, but edges are kept
 * coherent. Used to join a frontend against MULTIPLE backends (e.g. Spring +
 * nexcore) in a single pass so their providers/aliases share one index.
 */
function mergeGraphs(graphs: CallGraph[]): CallGraph {
  if (graphs.length === 1) return graphs[0];
  const nodes = new Map<string, MethodNode>();
  const edges: CallEdge[] = [];
  const seenEdge = new Set<string>();
  for (const g of graphs) {
    for (const n of g.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
    for (const e of g.edges) {
      const k = `${e.source} ${e.target} ${e.relation}`;
      if (!seenEdge.has(k)) { seenEdge.add(k); edges.push(e); }
    }
  }
  return { nodes: [...nodes.values()], edges };
}

function cmdJoin(opts: Opts): void {
  const graphPath = opts.flags['--graph'];
  const backendArg = opts.flags['--backend'];
  if (!graphPath || !backendArg) {
    process.stderr.write('join: --graph front.json --backend backend.json[,backend2.json] required\n');
    process.exit(2);
  }
  if (!fs.existsSync(graphPath)) {
    process.stderr.write(`join: --graph file not found: ${graphPath}\n`);
    process.exit(1);
  }
  const backends = backendPaths(backendArg);
  for (const p of backends) {
    if (!fs.existsSync(p)) {
      process.stderr.write(`join: --backend file not found: ${p}\n`);
      process.exit(1);
    }
  }
  const frontend = jsonOutput.read(fs.readFileSync(graphPath, 'utf8'));
  const backend = mergeGraphs(backends.map((p) => jsonOutput.read(fs.readFileSync(p, 'utf8'))));
  const affinity = loadAffinity(opts.flags['--affinity']);
  const frontendService = readGraphMetaProject(graphPath);
  const result = joinGraphs(frontend, backend, { affinity, frontendService });
  const doc = {
    meta: {
      command: 'join',
      frontendGraph: graphPath,
      backendGraph: backends.length === 1 ? backends[0] : backends,
      ...result.meta,
    },
    links: result.links,
  };
  const text = jsonOutput.writeValue(doc);
  if (opts.flags['--out']) {
    fs.writeFileSync(opts.flags['--out'], text);
    process.stderr.write(
      `wrote ${opts.flags['--out']}: ${result.meta.matched} matched ` +
        `(${result.meta.viaGateway} via gateway, ${result.meta.viaAffinity} via affinity), ` +
        `${result.meta.unmatched} unmatched, ${result.meta.ambiguous} ambiguous, ${result.meta.internal} internal\n`,
    );
    // The join output is a sibling of the graph inside the service dir; the
    // catalogue sits one level up at OUT_DIR. refreshManifest takes dirname, so
    // hand it the service dir → it rescans OUT_DIR.
    refreshManifest(path.dirname(opts.flags['--out']));
  } else {
    process.stdout.write(text + '\n');
  }
}

// ---- pipeline: refresh repo → analyze → screens → join, all from one config ----

/** Default config file searched in cwd when --config is not given. */
const DEFAULT_CONFIG_FILES = ['flowmap.config', 'flowmap.env', '.flowmaprc'];

/** Parse a KEY=VALUE config file (same format as --env), expanding $VARS. */
function loadConfig(file: string): Record<string, string> {
  const raw = loadEnvFile(file);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = v.replace(/\$\{?(\w+)\}?/g, (_m, name) => out[name] ?? process.env[name] ?? raw[name] ?? '');
  }
  return out;
}

function resolveConfigPath(flag?: string): string | null {
  if (flag) return fs.existsSync(flag) ? flag : null;
  if (process.env.FLOWMAP_CONFIG && fs.existsSync(process.env.FLOWMAP_CONFIG)) return process.env.FLOWMAP_CONFIG;
  for (const f of DEFAULT_CONFIG_FILES) if (fs.existsSync(f)) return f;
  return null;
}

/** Update the analyzed checkout(s) before analysis (best-effort, fast-forward only). */
function refreshRepo(repo: string, project: string | null, pull: boolean): void {
  if (!pull) return;
  const candidates = [project ? path.join(repo, project) : null, repo].filter(Boolean) as string[];
  const isGit = (dir: string) =>
    spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }).status === 0;
  const target = candidates.find((d) => fs.existsSync(d) && isGit(d));
  if (!target) {
    process.stderr.write(`pull: no git work tree under ${repo} — skipping refresh\n`);
    return;
  }
  process.stderr.write(`pull: git -C ${target} pull --ff-only\n`);
  const res = spawnSync('git', ['-C', target, 'pull', '--ff-only'], { stdio: 'inherit' });
  if (res.status !== 0) process.stderr.write(`pull: failed (exit ${res.status}) — continuing with current checkout\n`);
}

async function cmdPipeline(opts: Opts): Promise<void> {
  const cfgPath = resolveConfigPath(opts.flags['--config']);
  const cfg = cfgPath ? loadConfig(cfgPath) : {};
  if (cfgPath) process.stderr.write(`config: ${cfgPath}\n`);

  // Precedence: CLI flag > config file > default.
  const pick = (flag: string, key: string, def = ''): string => opts.flags[flag] ?? cfg[key] ?? def;

  const repo = pick('--repo', 'REPO', '../.repo');
  const project = pick('--project', 'PROJECT') || null;
  const outDir = pick('--out-dir', 'OUT_DIR', '.');
  const backend = pick('--backend', 'BACKEND');
  const affinity = pick('--affinity', 'AFFINITY');
  const mode = pick('--mode', 'MODE');
  const envFile = pick('--env', 'ENV');
  const envProfile = pick('--env-profile', 'ENV_PROFILE');
  const workers = pick('--workers', 'WORKERS');
  const noSplit = '--no-split' in opts.flags || /^(1|true|yes)$/i.test(cfg.NO_SPLIT ?? '');
  const pull = !(/^(0|false|no)$/i.test(pick('--pull', 'PULL', 'true')) || '--no-pull' in opts.flags);

  // `--only a,b` runs just those stages (reusing prior outputs for the rest).
  // e.g. `--only join` re-runs join against the existing graph.json without
  // re-analyzing. Default: all three stages.
  const ALL_STEPS = ['analyze', 'screens', 'join'] as const;
  const onlyRaw = pick('--only', 'ONLY');
  const steps = new Set<string>(ALL_STEPS);
  if (onlyRaw) {
    const requested = onlyRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = requested.filter((s) => !ALL_STEPS.includes(s as (typeof ALL_STEPS)[number]));
    if (bad.length) {
      process.stderr.write(`pipeline: unknown --only step(s): ${bad.join(', ')} (valid: ${ALL_STEPS.join(', ')})\n`);
      process.exit(2);
    }
    steps.clear();
    for (const s of requested) steps.add(s);
  }

  fs.mkdirSync(outDir, { recursive: true });
  // Output file base: explicit NAME, else PROJECT, else "graph" (whole-repo run).
  const base = pick('--name', 'NAME') || project || 'graph';
  const graphOut = path.join(outDir, `${base}.json`);
  const screensOut = path.join(outDir, `${base}.screens.json`);

  // Shared flags passed down to each step.
  const common: Record<string, string> = { '--repo': repo };
  if (project) common['--project'] = project;
  if (mode) common['--mode'] = mode;
  if (envFile) common['--env'] = envFile;
  if (envProfile) common['--env-profile'] = envProfile;
  if (workers) common['--workers'] = workers;
  if (noSplit) common['--no-split'] = '';

  // 0) refresh checkout (only meaningful when analyze runs)
  if (steps.has('analyze')) refreshRepo(path.resolve(repo), project, pull);

  // 1) analyze
  if (steps.has('analyze')) {
    process.stderr.write(`\n[1/3] analyze → ${graphOut}\n`);
    await cmdAnalyze({ flags: { ...common, '--out': graphOut } });
  } else {
    process.stderr.write(`\n[1/3] analyze skipped (--only ${[...steps].join(',')})\n`);
  }

  // 2) screens (no --workers/--no-split; screens has its own light path)
  if (steps.has('screens')) {
    process.stderr.write(`\n[2/3] screens → ${screensOut}\n`);
    const screensFlags: Record<string, string> = { '--repo': repo, '--out': screensOut };
    if (project) screensFlags['--project'] = project;
    cmdScreens({ flags: screensFlags });
  } else {
    process.stderr.write(`\n[2/3] screens skipped (--only ${[...steps].join(',')})\n`);
  }

  // 3) join — one join per front graph (per-root for a split repo), each written
  // as `<graph>.join.json`. Skipped if no backend graph configured/present.
  if (!steps.has('join')) {
    process.stderr.write(`\n[3/3] join skipped (--only ${[...steps].join(',')})\n`);
  } else if (!backend) {
    process.stderr.write(`\n[3/3] join skipped — set BACKEND in config (or --backend) to enable\n`);
  } else if (backendPaths(backend).some((p) => !fs.existsSync(p))) {
    const missing = backendPaths(backend).filter((p) => !fs.existsSync(p));
    process.stderr.write(`\n[3/3] join skipped — backend graph not found: ${missing.join(', ')}\n`);
  } else {
    const graphs = listGraphsToJoin(outDir, base);
    if (!graphs.length) {
      // join reuses the analyze output; without it there is nothing to join.
      process.stderr.write(`\n[3/3] join: no front graph found in ${outDir} — run analyze first (drop --only)\n`);
      process.exit(1);
    }
    process.stderr.write(`\n[3/3] join → ${graphs.length} graph(s)\n`);
    for (const g of graphs) {
      const joinOut = g.replace(/\.json$/, '.join.json');
      const joinFlags: Record<string, string> = { '--graph': g, '--backend': backend, '--out': joinOut };
      if (affinity) joinFlags['--affinity'] = affinity;
      cmdJoin({ flags: joinFlags });
    }
  }
  process.stderr.write(`\ndone.\n`);
}

async function cmdSearch(opts: Opts): Promise<void> {
  const method = opts.flags['--method'];
  if (!method) {
    process.stderr.write('--method required\n');
    process.exit(2);
  }
  const graph = await graphFromOpts(opts);
  const matches = findNodes(graph, method);
  if (!matches.length) {
    process.stderr.write(`no node matches '${method}'\n`);
    process.exit(1);
  }
  if (matches.length > 1) {
    process.stderr.write(`matched ${matches.length} nodes for '${method}':\n`);
    for (const m of matches) process.stderr.write(`  - ${m.id}  (${m.layer}, ${m.file}:${m.line})\n`);
  }
  const direction = (['callers', 'callees', 'both'].includes(opts.flags['--direction'])
    ? opts.flags['--direction']
    : 'both') as Direction;
  const depth = parseInt(opts.flags['--depth'] ?? '3', 10) || 3;
  const sub = bfs(graph, matches.map((m) => m.id), direction, depth);
  dump(sub, opts.flags['--out'], {
    command: 'search',
    query: method,
    roots: matches.map((m) => m.id),
    direction,
    depth,
    nodes: sub.nodes.length,
    edges: sub.edges.length,
  });
}

function cmdScreens(opts: Opts): void {
  const repo = opts.flags['--repo'] ?? '../.repo';
  const out = opts.flags['--out'];
  const project = opts.flags['--project'] ?? null;

  // Mirror analyze: ONE screens doc per root, written next to that root's graph
  // under the per-service directory (`<dir>/<service>/<name>.screens.json`), so
  // the manifest links each service graph to its own screens.
  const roots = discoverProjectRoots(repo, project);
  if (out && roots.length >= 1) {
    const repoRoot = path.resolve(repo);
    const dir = path.dirname(out) || '.';
    const stem = path.basename(out).replace(/\.screens\.json$/, '').replace(/\.json$/, '');
    for (const root of roots) {
      const prov = serviceProvenance(repoRoot, root, serviceName(repoRoot, root, project));
      const svcDir = serviceDirOf(dir, prov);
      fs.mkdirSync(svcDir, { recursive: true });
      const doc = buildScreens({ repoRoot: repo, roots: [root] });
      const outPath = path.join(svcDir, `${stem}.screens.json`);
      fs.writeFileSync(outPath, jsonOutput.writeValue(doc));
      process.stderr.write(`wrote ${outPath}: ${doc.meta.screens} screens, ${doc.meta.components} components\n`);
    }
    refreshManifest(out);
    return;
  }

  const doc = buildScreens({ repoRoot: repo, projectFilter: project });
  const text = jsonOutput.writeValue(doc);
  if (out) {
    fs.writeFileSync(out, text);
    process.stderr.write(`wrote ${out}: ${doc.meta.screens} screens, ${doc.meta.components} components\n`);
    refreshManifest(out);
  } else {
    process.stdout.write(text + '\n');
  }
}

async function cmdDoctor(opts: Opts): Promise<void> {
  const graph = await graphFromOpts(opts);
  const health = checkGraph(graph);
  process.stdout.write(formatHealth(health, { maxSample: parseInt(opts.flags['--sample'] ?? '15', 10) || 15 }) + '\n');
  const maxOrphans = parseInt(opts.flags['--max-orphans'] ?? '0', 10) || 0;
  if (health.danglingEdges > 0 || health.orphans.total > maxOrphans) process.exitCode = 1;
}

async function cmdStats(opts: Opts): Promise<void> {
  const graph = await graphFromOpts(opts);
  const layers = countBy(graph.nodes, (n) => n.layer);
  const kinds = countBy(graph.edges, (e) => e.kind);
  const relations = countBy(graph.edges, (e) => e.relation);
  const apiNodes = graph.nodes.filter((n) => n.layer === 'API' || n.layer === 'EXTERNAL');
  const conf = countBy(apiNodes, (n) => n.confidence ?? 'n/a');
  process.stdout.write(`nodes: ${graph.nodes.length}   edges: ${graph.edges.length}\n`);
  process.stdout.write(`layers: ${JSON.stringify(layers)}\n`);
  process.stdout.write(`edge kinds: ${JSON.stringify(kinds)}\n`);
  process.stdout.write(`relations: ${JSON.stringify(relations)}\n`);
  process.stdout.write(`api/external nodes: ${apiNodes.length}   confidence: ${JSON.stringify(conf)}\n`);
}

/**
 * Per-PR change-impact against a frontend graph (port of the Spring `impact`
 * command). Mines merged PRs from the `--git` repo (git-first, gh fallback),
 * attributes each PR's changed lines to graph node ids, and reports the SCREEN
 * nodes they reach. Writes a lean `<out>` index + heavy `<base>.impact/<n>.json`
 * shards (pruning shards for PRs no longer in the window).
 */
/**
 * Analyze PR change-impact for ONE git repo against [graph] (already merged across
 * the repo's sub-roots), writing the index + per-PR shards to [out]. Returns false
 * when there is nothing to write (no branch / no PR source) so a caller looping over
 * many repos can skip without aborting; true when it wrote or was already current.
 * Does not call process.exit. Mirrors the incremental contract of `impact`.
 */
function runImpact(
  graph: CallGraph,
  repo: string,
  prefix: string,
  out: string | undefined,
  o: {
    incremental: boolean;
    max: number;
    since: string | null;
    base: string | null;
    label?: string;
    noPullFiles?: boolean;
    refetchPullFiles?: boolean;
  },
): boolean {
  const base = gitSource.resolveBranch(repo, o.base);
  if (!base) {
    process.stderr.write(`impact: cannot resolve a branch to mine in ${repo} (pass --base)\n`);
    return false;
  }

  // Incremental: reuse the PRs already recorded in <out>, mining only those merged
  // SINCE the newest analyzed date (or an explicit since). The expensive per-PR
  // diff/parse then runs for NEW PRs only; existing rows + shards are kept and the
  // index merged. First run (no <out>) transparently falls back to a full run.
  const incremental = o.incremental && !!out;
  let existingIndex: Record<string, unknown> | null = null;
  const analyzedNumbers = new Set<number>();
  let since = o.since;
  if (incremental && out && fs.existsSync(out)) {
    try {
      existingIndex = JSON.parse(fs.readFileSync(out, 'utf8'));
      for (const p of ((existingIndex?.pulls as Array<{ number?: number; mergedAt?: string; status?: string }>) ?? [])) {
        // Open/draft rows are NOT "analyzed" — they change over time (and may later merge), so they
        //   must be re-analyzed every run rather than skipped by the incremental filter.
        const wasOpen = p?.status === 'open' || p?.status === 'draft';
        if (Number.isFinite(p?.number) && !wasOpen) analyzedNumbers.add(p.number as number);
        if (p?.mergedAt && (!since || String(p.mergedAt) > since)) since = String(p.mergedAt);
      }
    } catch {
      existingIndex = null; // unreadable prior index → full run
    }
  }

  // Incremental scans wide (the git log is one cheap call) and bounds by `since`
  // so no recent PR is missed; a full run honors max.
  const mined = gitSource.mergedPulls(repo, base, incremental ? 5000 : o.max, incremental ? since : null);
  if (mined == null) {
    process.stderr.write(`impact: no PR source for base ${base} (no git PR markers + gh unavailable)\n`);
    return false;
  }
  const mergedSel = incremental ? mined.filter((p) => !analyzedNumbers.has(p.number)) : mined;
  // Open (incl. draft) PRs targeting this base (gh-only; empty without a remote). Each head is
  //   fetched so the impact walk can read its blobs offline. Always analyzed (never reused), so an
  //   open PR's impact refreshes as it gains commits and when it eventually merges.
  const openMined = gitSource.openPulls(repo, base, o.max);
  for (const pr of openMined) if (pr.headOid) gitSource.fetchPullHead(repo, pr.number, pr.headOid);
  const pulls = [...mergedSel, ...openMined];

  // Nothing new since the last run — leave the existing index + shards untouched.
  if (incremental && existingIndex && pulls.length === 0) {
    process.stderr.write(`impact: ${out} already current — 0 new PRs since ${since ?? 'last run'}\n`);
    return true;
  }

  const result = impact.analyze(repo, base, prefix, pulls, graph, o.label ?? path.basename(repo));
  if (!out) {
    process.stdout.write(jsonOutput.writeValue(result.index) + '\n');
    return true;
  }

  const shardDir = impact.shardDirOf(out);
  fs.mkdirSync(shardDir, { recursive: true });

  // Index: merge into the existing one when running incrementally; else replace.
  const index =
    incremental && existingIndex
      ? impact.mergeIndex(existingIndex, result, (num) => readShardChangedInGraph(shardDir, num))
      : result.index;
  fs.writeFileSync(out, jsonOutput.writeValue(index));

  // Write this run's heavy per-PR shards. A full run also prunes shards no longer
  // referenced; an incremental run keeps the existing shards (they back retained PRs).
  for (const [number, shard] of result.shards) {
    fs.writeFileSync(path.join(shardDir, `${number}.json`), jsonOutput.writeValue(shard));
  }
  if (!incremental) {
    const keep = new Set([...result.shards.keys()].map((n) => `${n}.json`));
    try {
      for (const f of fs.readdirSync(shardDir)) if (f.endsWith('.json') && !keep.has(f)) fs.unlinkSync(path.join(shardDir, f));
      if (fs.readdirSync(shardDir).length === 0) fs.rmdirSync(shardDir);
    } catch {
      /* shard-dir prune is best-effort */
    }
  }

  process.stderr.write(
    `wrote ${out}: ${pulls.length}${incremental ? ' new' : ''} PRs, ${(index as { pullCount?: number }).pullCount} total, ` +
      `${(index as { changedNodeCount?: number }).changedNodeCount} changed nodes, ` +
      `${(index as { impactedEndpointCount?: number }).impactedEndpointCount} impacted screens\n`,
  );
  // Impact output is a sibling of the graph inside the service dir; the catalogue
  // sits one level up at OUT_DIR (refreshManifest takes dirname of its arg).
  refreshManifest(path.dirname(out));

  // Per-PR file diffs → `<base>.pulls.json` index + `<base>.pulls/<n>.json` shards (the
  // sibling other analyzers emit; the sync's manifest links it via each entry's `pulls`).
  // Best-effort: a failure here does NOT fail impact, which already succeeded.
  if (!o.noPullFiles) {
    try {
      const fileBase = impact.baseNameOf(out);
      const { fetched, reused } = putPulls.writePulls(path.dirname(out), fileBase, repo, base, pulls, {
        incremental,
        refetch: o.refetchPullFiles,
      });
      process.stderr.write(
        `wrote ${path.join(path.dirname(out), `${fileBase}.pulls.json`)}: ${fetched + reused} PRs (${fetched} fetched, ${reused} reused)\n`,
      );
    } catch (e) {
      process.stderr.write(`pull-files: ${(e as Error).message} (impact kept)\n`);
    }
  }
  return true;
}

function cmdImpact(opts: Opts): void {
  const graphArg = opts.flags['--graph'];
  if (!graphArg) {
    process.stderr.write('impact: --graph <graph.json[,graph2.json]> required\n');
    process.exit(2);
  }
  // Multiple graphs (CSV) are MERGED into one — used for a monorepo's sub-roots,
  // which share a git work tree + prefix; impact then maps each PR's changed files
  // to whichever sub-root owns them, in a single pass.
  const graphPaths = graphArg.split(',').map((s) => s.trim()).filter(Boolean);
  const graph = graphPaths.length === 1 ? readGraphFile(graphPaths[0]) : mergeGraphs(graphPaths.map(readGraphFile));

  // Resolve the git work tree to mine + the path prefix that maps its blob paths
  // onto the graph's repo-relative node ids:
  //  - explicit --git: use it as-is (prefix from --prefix, else the repo basename);
  //  - else --repo-root: derive from the (first) graph's meta.root, walking up to
  //    the nearest git work tree. A package split out of a MONOREPO thus mines the
  //    monorepo's git with the right prefix (its repo-relative dir) instead of
  //    looking for a standalone repo at the flattened service name (which fails).
  let repo: string;
  let prefix: string;
  if (opts.flags['--git']) {
    repo = path.resolve(opts.flags['--git']);
    prefix = opts.flags['--prefix'] ?? path.basename(repo);
  } else {
    const repoRoot = opts.flags['--repo-root'] ?? opts.flags['--repo'];
    if (!repoRoot) {
      process.stderr.write('impact: pass --git <repo>, or --repo-root <dir> with a graph carrying meta.root\n');
      process.exit(2);
    }
    const projectRel = readGraphMetaRoot(graphPaths[0]);
    const target = gitSource.resolveGitTarget(path.resolve(repoRoot), projectRel);
    if (!target) {
      process.stderr.write(`impact: no git work tree at/above ${path.join(repoRoot, projectRel) || repoRoot} — skipping\n`);
      process.exit(1);
    }
    repo = target.gitDir;
    prefix = opts.flags['--prefix'] ?? target.prefix;
  }
  if (!gitSource.isRepo(repo)) {
    process.stderr.write(`impact: ${repo} is not a git work tree\n`);
    process.exit(2);
  }

  const ok = runImpact(graph, repo, prefix, opts.flags['--out'], {
    incremental: '--incremental' in opts.flags,
    max: parseInt(opts.flags['--max'] ?? '10', 10) || 10,
    since: opts.flags['--since'] || null,
    base: opts.flags['--base'] ?? null,
    noPullFiles: '--no-pull-files' in opts.flags,
    refetchPullFiles: '--refetch-pull-files' in opts.flags,
  });
  if (!ok) process.exit(1);
}

/** Per-service graph files under the nested output root (`<out-dir>/<ns>/<repo>/<perRoot>/<base>.json`). */
function discoverServiceGraphs(outDir: string): string[] {
  const derived = /\.(join|screens|openapi|impact|pulls)\.json$/;
  const graphs: string[] = [];
  function rec(d: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    const g = entries.find((e) => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('_') && !derived.test(e.name));
    if (g) graphs.push(path.join(d, g.name));
    for (const e of entries) {
      if (e.isDirectory() && !e.name.endsWith('.impact') && !e.name.endsWith('.pulls')) rec(path.join(d, e.name));
    }
  }
  rec(outDir);
  return graphs.sort();
}

/** Remove a service's impact index + shard dir (used to clear non-representative sub-roots). */
function pruneImpactArtifacts(graphPath: string): void {
  const idx = graphPath.replace(/\.json$/, '.impact.json');
  const dir = graphPath.replace(/\.json$/, '.impact');
  try {
    if (fs.existsSync(idx)) fs.unlinkSync(idx);
  } catch {
    /* best-effort */
  }
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Repo-level PR change-impact over a per-service output dir: discover every service
 * graph, group them by their (namespace, repo) — the nested layout's `<ns>/<repo>` (so a
 * monorepo's sub-roots fall in one group) — and run impact ONCE per repo against the MERGED
 * graph of the group. A multi-root repo's result goes to a graph-less repo folder
 * `<out-dir>/<ns>/<repo>/<repo>/<base>.impact.json` (+ `<base>.impact/` shards), aligned with
 * spring/nexcore; the sub-roots' own stale impact artifacts are pruned. A single-root repo
 * keeps its impact next to its graph (the normal per-service variant).
 */
function cmdImpactRepos(opts: Opts): void {
  const repoRoot = opts.flags['--repo-root'] ?? opts.flags['--repo'];
  const outDir = opts.flags['--out-dir'];
  if (!repoRoot || !outDir) {
    process.stderr.write('impact-repos: --repo-root <.repo> and --out-dir <service-dir root> required\n');
    process.exit(2);
  }
  const repoRootAbs = path.resolve(repoRoot);
  const max = parseInt(opts.flags['--max'] ?? '10', 10) || 10;
  const incremental = '--incremental' in opts.flags;
  const since = opts.flags['--since'] || null;
  const noPullFiles = '--no-pull-files' in opts.flags;
  const refetchPullFiles = '--refetch-pull-files' in opts.flags;

  // group graphs by their (namespace, repo) — the nested layout `<out-dir>/<ns>/<repo>/<perRoot>/`
  // (a monorepo's sub-roots share one <ns>/<repo>, so they fall in one group). The git work tree
  // to MINE is still resolved per representative graph (its meta.root → nearest .git).
  const groups = new Map<string, { ns: string; repo: string; gitDir: string; prefix: string; graphs: string[] }>();
  for (const gp of discoverServiceGraphs(outDir)) {
    const rel = path.relative(outDir, gp).split(path.sep);   // [ns, repo, perRoot, <base>.json]
    if (rel.length < 4) continue;                            // not in the nested layout — skip
    const [ns, repo] = rel;
    const target = gitSource.resolveGitTarget(repoRootAbs, readGraphMetaRoot(gp));
    if (!target) {
      process.stderr.write(`  · ${path.basename(path.dirname(gp))}: skip (no git work tree at/above its checkout)\n`);
      continue;
    }
    const key = `${ns}/${repo}`;
    const grp = groups.get(key) ?? { ns, repo, gitDir: target.gitDir, prefix: target.prefix, graphs: [] };
    grp.graphs.push(gp);
    groups.set(key, grp);
  }

  let analyzed = 0;
  for (const grp of groups.values()) {
    const sorted = grp.graphs.slice().sort();
    const repr = sorted[0];
    // 표준 정렬(spring/nexcore 와 동일): 다중 sub-root repo 는 repo 단위 impact 를 graph-less
    //   <out-dir>/<ns>/<repo>/<repo>/ 폴더에 둔다(manifest 가 "graph 없는 repo 엔트리"로 잡음).
    //   단일 root 면 그 root 폴더(graph 옆)에 그대로 둔다(single-graph 변형).
    const repoName = grp.repo;
    const base = path.basename(repr, '.json');
    const repoDir = sorted.length === 1 ? path.dirname(repr) : path.join(outDir, grp.ns, grp.repo, grp.repo);
    const out = path.join(repoDir, `${base}.impact.json`);
    // impact 가 repoDir 로 모이므로, 다른 sub-root 폴더의 (이전 실행) impact 산출물은 정리한다.
    for (const g of sorted) {
      if (path.resolve(path.dirname(g)) !== path.resolve(repoDir)) pruneImpactArtifacts(g);
    }
    if (!gitSource.isRepo(grp.gitDir)) {
      process.stderr.write(`  · ${repoName}: skip (not a git work tree)\n`);
      continue;
    }
    fs.mkdirSync(repoDir, { recursive: true });
    const label = sorted.length > 1 ? `${repoName} (${sorted.length} sub-roots)` : path.basename(path.dirname(repr));
    process.stderr.write(`      ${label} → ${out}\n`);
    const merged = sorted.length === 1 ? readGraphFile(sorted[0]) : mergeGraphs(sorted.map(readGraphFile));
    if (runImpact(merged, grp.gitDir, grp.prefix, out, { incremental, max, since, base: opts.flags['--base'] ?? null, label, noPullFiles, refetchPullFiles })) analyzed++;
  }
  process.stderr.write(`impact-repos done: ${analyzed}/${groups.size} repo(s) analyzed\n`);
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function usage(): void {
  process.stderr.write(
    [
      'flowmap-react (TypeScript Compiler API)',
      '  pipeline [--config flowmap.config] [--only analyze,screens,join]   # refresh repo → analyze → screens → join, options from config',
      '          # --only join: re-run just join against the existing per-root graphs (no re-analyze)',
      '  analyze --repo <dir> [--project P] [--out f.json] [--env kv.txt] [--env-profile name] [--mode development|production]',
      '          [--workers N] [--no-split]   # large repos: split per project root into child processes',
      '  join    --graph front.json --backend backend.json [--out join.json] [--affinity aff.json]',
      '          # --affinity: fe-svc→backend-project hints {"fe-svc":["be-proj*"]} to break ambiguous (same-path) ties',
      '  search  --method M [--graph g.json | --repo <dir>] [--direction both|callers|callees] [--depth N] [--out f]',
      '  stats   [--graph g.json | --repo <dir>]',
      '  doctor  [--graph g.json | --repo <dir>] [--max-orphans N]   # graph health: orphans, dangling, connectivity',
      '  screens --repo <dir> [--project P] [--out f.json]   # screen layout/wireframe data',
      '  impact  (--git <repo> | --repo-root <.repo>) --graph g.json [--out f.impact.json] [--base branch] [--max N] [--prefix P] [--incremental] [--since DATE] [--no-pull-files] [--refetch-pull-files]',
      '          # --repo-root: auto-find the git work tree from the graph meta.root (walks up; monorepo packages mine the monorepo git)',
      '          # --incremental: reuse PRs already in --out, analyze only those merged since the last run (or --since DATE)',
      '          # --graph a.json,b.json: merge several sub-root graphs (one monorepo) and analyze their shared git once',
      '          # also writes <base>.pulls.json index + <base>.pulls/<n>.json shards (per-PR file diffs); --no-pull-files skips, --refetch-pull-files re-fetches',
      '  impact-repos --repo-root <.repo> --out-dir <service-dir root> [--max N] [--incremental] [--since DATE] [--no-pull-files] [--refetch-pull-files]',
      '          # group every service graph by git work tree and analyze impact ONCE per repo (monorepo sub-roots share one impact)',
      '          # per-PR change impact: changed nodes + the screens they reach (git-first, gh fallback)',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    usage();
    process.exit(2);
  }
  const cmd = argv[0];
  const opts = parseOpts(argv.slice(1));

  // For `pipeline`, let the config file set the heap target before the guard runs.
  if (cmd === 'pipeline' && !process.env.FLOWMAP_MAX_OLD_SPACE) {
    const cfgPath = resolveConfigPath(opts.flags['--config']);
    const mos = cfgPath ? loadConfig(cfgPath).MAX_OLD_SPACE : '';
    if (mos) process.env.FLOWMAP_MAX_OLD_SPACE = mos;
  }

  // Workers (`__ir`) inherit a heap flag from the parent; only the user-facing
  // commands that build a ts.Program in-process need the heap guard.
  if (['analyze', 'search', 'stats', 'screens', 'pipeline', 'doctor'].includes(cmd)) ensureHeap();

  switch (cmd) {
    case 'analyze':
      await cmdAnalyze(opts);
      break;
    case 'pipeline':
    case 'all':
      await cmdPipeline(opts);
      break;
    case '__ir': // hidden: per-project worker, prints/writes IrFile[]
      cmdIr(opts);
      break;
    case 'join':
      cmdJoin(opts);
      break;
    case 'search':
      await cmdSearch(opts);
      break;
    case 'stats':
      await cmdStats(opts);
      break;
    case 'doctor':
      await cmdDoctor(opts);
      break;
    case 'screens':
      cmdScreens(opts);
      break;
    case 'impact':
      cmdImpact(opts);
      break;
    case 'impact-repos':
      cmdImpactRepos(opts);
      break;
    case '-h':
    case '--help':
    case 'help':
      usage();
      break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      usage();
      process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
