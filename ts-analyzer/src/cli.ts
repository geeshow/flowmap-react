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
import { join as joinGraphs } from './join';
import * as jsonOutput from './jsonOutput';
import { CallGraph } from './model';
import type { IrFile } from './ir';
import { TsResolver } from './resolver/irBuilder';
import { isReactProject, isVueProject } from './resolver/program';
import { discoverProjectRoots } from './resolver/projectScan';
import { VueResolver } from './resolver/vue/vueIrBuilder';
import { buildScreens } from './screens';
import { ensureHeap, planWorkers, runProjectWorkers } from './workers';

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

/** In-process analysis (single Program per project) — the original path. */
function analyzeInProcess(repo: string, opts: Opts): IrFile[] {
  const common = {
    repoRoot: repo,
    projectFilter: opts.flags['--project'] ?? null,
    env: loadEnvFile(opts.flags['--env']),
  };
  // React and Vue projects are auto-detected per directory; both emit the same IrFile[].
  const reactFiles = new TsResolver().analyze(common);
  const vueFiles = new VueResolver().analyze({ ...common, mode: opts.flags['--mode'] ?? 'development' });
  return [...reactFiles, ...vueFiles];
}

async function analyzeRepo(opts: Opts): Promise<{ graph: CallGraph; fileCount: number; repo: string }> {
  const repo = opts.flags['--repo'] ?? '../.repo';
  const splitOff = '--no-split' in opts.flags;
  const requestedWorkers = opts.flags['--workers'] ? parseInt(opts.flags['--workers'], 10) : null;

  // Split a large repo/workspace into per-project-root child processes so each
  // giant ts.Program's memory is released after its worker exits. Only worth it
  // when there is more than one root to spread across processes.
  const roots = splitOff ? [] : discoverProjectRoots(repo, opts.flags['--project'] ?? null);
  let files: IrFile[];
  if (roots.length > 1 && (requestedWorkers ?? 2) > 1) {
    const plan = planWorkers(roots.length, requestedWorkers);
    files = await runProjectWorkers(roots, plan, {
      entry: process.argv[1],
      repoRoot: path.resolve(repo),
      envFile: opts.flags['--env'] || undefined,
      mode: opts.flags['--mode'] || undefined,
    });
  } else {
    files = analyzeInProcess(repo, opts);
  }
  const graph = new GraphBuilder(files).build();
  return { graph, fileCount: files.length, repo };
}

/** Hidden worker entrypoint: analyze ONE project root and write IrFile[] JSON. */
function cmdIr(opts: Opts): void {
  const root = path.resolve(opts.flags['--root'] ?? '.');
  const repoRoot = path.resolve(opts.flags['--repo'] ?? '../.repo');
  const common = { repoRoot, projectFilter: null, env: loadEnvFile(opts.flags['--env']) };
  const files: IrFile[] = [];
  if (isReactProject(root)) files.push(...new TsResolver().analyzeRoot(root, repoRoot, common));
  if (isVueProject(root)) {
    files.push(...new VueResolver().analyzeRoot(root, repoRoot, { ...common, mode: opts.flags['--mode'] ?? 'development' }));
  }
  const out = opts.flags['--out'];
  if (out) fs.writeFileSync(out, JSON.stringify(files));
  else process.stdout.write(JSON.stringify(files));
}

async function graphFromOpts(opts: Opts): Promise<CallGraph> {
  if (opts.flags['--graph']) return jsonOutput.read(fs.readFileSync(opts.flags['--graph'], 'utf8'));
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
  const { graph, fileCount, repo } = await analyzeRepo(opts);
  dump(graph, opts.flags['--out'], {
    command: 'analyze',
    repo,
    project: opts.flags['--project'] ?? null,
    files: fileCount,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
  });
  refreshManifest(opts.flags['--out']);
}

function cmdJoin(opts: Opts): void {
  const graphPath = opts.flags['--graph'];
  const backendPath = opts.flags['--backend'];
  if (!graphPath || !backendPath) {
    process.stderr.write('join: --graph front.json --backend backend.json required\n');
    process.exit(2);
  }
  const frontend = jsonOutput.read(fs.readFileSync(graphPath, 'utf8'));
  const backend = jsonOutput.read(fs.readFileSync(backendPath, 'utf8'));
  const result = joinGraphs(frontend, backend);
  const doc = {
    meta: {
      command: 'join',
      frontendGraph: graphPath,
      backendGraph: backendPath,
      ...result.meta,
    },
    links: result.links,
  };
  const text = jsonOutput.writeValue(doc);
  if (opts.flags['--out']) {
    fs.writeFileSync(opts.flags['--out'], text);
    process.stderr.write(
      `wrote ${opts.flags['--out']}: ${result.meta.matched} matched (${result.meta.viaGateway} via gateway), ${result.meta.unmatched} unmatched, ${result.meta.ambiguous} ambiguous\n`,
    );
    refreshManifest(opts.flags['--out']);
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
  const mode = pick('--mode', 'MODE');
  const envFile = pick('--env', 'ENV');
  const workers = pick('--workers', 'WORKERS');
  const noSplit = '--no-split' in opts.flags || /^(1|true|yes)$/i.test(cfg.NO_SPLIT ?? '');
  const pull = !(/^(0|false|no)$/i.test(pick('--pull', 'PULL', 'true')) || '--no-pull' in opts.flags);

  fs.mkdirSync(outDir, { recursive: true });
  const base = project ?? 'graph';
  const graphOut = path.join(outDir, `${base}.json`);
  const screensOut = path.join(outDir, `${base}.screens.json`);
  const joinOut = path.join(outDir, `${base}.join.json`);

  // Shared flags passed down to each step.
  const common: Record<string, string> = { '--repo': repo };
  if (project) common['--project'] = project;
  if (mode) common['--mode'] = mode;
  if (envFile) common['--env'] = envFile;
  if (workers) common['--workers'] = workers;
  if (noSplit) common['--no-split'] = '';

  // 0) refresh checkout
  refreshRepo(path.resolve(repo), project, pull);

  // 1) analyze
  process.stderr.write(`\n[1/3] analyze → ${graphOut}\n`);
  await cmdAnalyze({ flags: { ...common, '--out': graphOut } });

  // 2) screens (no --workers/--no-split; screens has its own light path)
  process.stderr.write(`\n[2/3] screens → ${screensOut}\n`);
  const screensFlags: Record<string, string> = { '--repo': repo, '--out': screensOut };
  if (project) screensFlags['--project'] = project;
  cmdScreens({ flags: screensFlags });

  // 3) join (skipped if no backend graph configured/present)
  if (!backend) {
    process.stderr.write(`\n[3/3] join skipped — set BACKEND in config (or --backend) to enable\n`);
  } else if (!fs.existsSync(backend)) {
    process.stderr.write(`\n[3/3] join skipped — backend graph not found: ${backend}\n`);
  } else {
    process.stderr.write(`\n[3/3] join → ${joinOut}\n`);
    cmdJoin({ flags: { '--graph': graphOut, '--backend': backend, '--out': joinOut } });
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
  const doc = buildScreens({ repoRoot: repo, projectFilter: opts.flags['--project'] ?? null });
  const text = jsonOutput.writeValue(doc);
  if (opts.flags['--out']) {
    fs.writeFileSync(opts.flags['--out'], text);
    process.stderr.write(`wrote ${opts.flags['--out']}: ${doc.meta.screens} screens, ${doc.meta.components} components\n`);
    refreshManifest(opts.flags['--out']);
  } else {
    process.stdout.write(text + '\n');
  }
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
      '  pipeline [--config flowmap.config]   # refresh repo → analyze → screens → join, options from config',
      '  analyze --repo <dir> [--project P] [--out f.json] [--env kv.txt] [--mode development|production]',
      '          [--workers N] [--no-split]   # large repos: split per project root into child processes',
      '  join    --graph front.json --backend backend.json [--out join.json]',
      '  search  --method M [--graph g.json | --repo <dir>] [--direction both|callers|callees] [--depth N] [--out f]',
      '  stats   [--graph g.json | --repo <dir>]',
      '  screens --repo <dir> [--project P] [--out f.json]   # screen layout/wireframe data',
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
  if (['analyze', 'search', 'stats', 'screens', 'pipeline'].includes(cmd)) ensureHeap();

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
    case 'screens':
      cmdScreens(opts);
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
