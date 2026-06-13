#!/usr/bin/env node
/**
 * CLI mirroring the backend Cli.kt:
 *   analyze --repo <dir> [--project P] [--out f.json] [--env kv.txt]
 *   join    --graph front.json --backend backend.json [--out join.json]
 *   search  --method M [--graph g.json | --repo <dir>] [--direction both|callers|callees] [--depth N]
 *   stats   [--graph g.json | --repo <dir>]
 */

import * as fs from 'fs';
import { bfs, Direction, findNodes } from './bfs';
import { GraphBuilder } from './graphBuilder';
import { join as joinGraphs } from './join';
import * as jsonOutput from './jsonOutput';
import { CallGraph } from './model';
import { TsResolver } from './resolver/irBuilder';
import { VueResolver } from './resolver/vue/vueIrBuilder';
import { buildScreens } from './screens';

interface Opts {
  flags: Record<string, string>;
}

function parseOpts(args: string[]): Opts {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      flags[a] = args[i + 1] ?? '';
      i++;
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

function analyzeRepo(opts: Opts): { graph: CallGraph; fileCount: number; repo: string } {
  const repo = opts.flags['--repo'] ?? '../.repo';
  const common = {
    repoRoot: repo,
    projectFilter: opts.flags['--project'] ?? null,
    env: loadEnvFile(opts.flags['--env']),
  };
  // React and Vue projects are auto-detected per directory; both emit the same IrFile[].
  const reactFiles = new TsResolver().analyze(common);
  const vueFiles = new VueResolver().analyze({ ...common, mode: opts.flags['--mode'] ?? 'development' });
  const files = [...reactFiles, ...vueFiles];
  const graph = new GraphBuilder(files).build();
  return { graph, fileCount: files.length, repo };
}

function graphFromOpts(opts: Opts): CallGraph {
  if (opts.flags['--graph']) return jsonOutput.read(fs.readFileSync(opts.flags['--graph'], 'utf8'));
  return analyzeRepo(opts).graph;
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

function cmdAnalyze(opts: Opts): void {
  const { graph, fileCount, repo } = analyzeRepo(opts);
  dump(graph, opts.flags['--out'], {
    command: 'analyze',
    repo,
    project: opts.flags['--project'] ?? null,
    files: fileCount,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
  });
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
      `wrote ${opts.flags['--out']}: ${result.meta.matched} matched, ${result.meta.unmatched} unmatched, ${result.meta.ambiguous} ambiguous\n`,
    );
  } else {
    process.stdout.write(text + '\n');
  }
}

function cmdSearch(opts: Opts): void {
  const method = opts.flags['--method'];
  if (!method) {
    process.stderr.write('--method required\n');
    process.exit(2);
  }
  const graph = graphFromOpts(opts);
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
  } else {
    process.stdout.write(text + '\n');
  }
}

function cmdStats(opts: Opts): void {
  const graph = graphFromOpts(opts);
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
      '  analyze --repo <dir> [--project P] [--out f.json] [--env kv.txt] [--mode development|production]',
      '  join    --graph front.json --backend backend.json [--out join.json]',
      '  search  --method M [--graph g.json | --repo <dir>] [--direction both|callers|callees] [--depth N] [--out f]',
      '  stats   [--graph g.json | --repo <dir>]',
      '  screens --repo <dir> [--project P] [--out f.json]   # screen layout/wireframe data',
      '',
    ].join('\n'),
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    usage();
    process.exit(2);
  }
  const cmd = argv[0];
  const opts = parseOpts(argv.slice(1));
  switch (cmd) {
    case 'analyze':
      cmdAnalyze(opts);
      break;
    case 'join':
      cmdJoin(opts);
      break;
    case 'search':
      cmdSearch(opts);
      break;
    case 'stats':
      cmdStats(opts);
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

main();
