/**
 * Memory management for `analyze` on very large repos:
 *   1. ensureHeap() — re-exec the CLI with a larger V8 old-space if one isn't
 *      already configured, so the default ~2-4GB never OOMs (any invocation).
 *   2. runProjectWorkers() — analyze each discovered project root in its own
 *      child process so a giant `ts.Program`'s memory is released per project;
 *      the parent only merges the lightweight IR. Bounded concurrency keeps the
 *      summed worker heaps within physical RAM.
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IrFile } from './ir';

const RESPAWN_FLAG = 'FLOWMAP_NO_RESPAWN';
const SIZE_ENV = 'FLOWMAP_MAX_OLD_SPACE'; // MB override for the V8 old-space

function hasHeapFlag(): boolean {
  const opts = process.env.NODE_OPTIONS ?? '';
  return opts.includes('--max-old-space-size') || process.execArgv.some((a) => a.startsWith('--max-old-space-size'));
}

/** NODE_OPTIONS with any existing --max-old-space-size replaced by `sizeMB`. */
function withHeap(sizeMB: number): string {
  const base = (process.env.NODE_OPTIONS ?? '').replace(/--max-old-space-size=\d+/g, '').trim();
  return `${base} --max-old-space-size=${sizeMB}`.trim();
}

/** Default heap target: ~75% of physical RAM, floored at 4GB. */
function totalHeapMB(): number {
  const fromEnv = parseInt(process.env[SIZE_ENV] ?? '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const ramMB = Math.floor(os.totalmem() / 1024 / 1024);
  return Math.max(4096, Math.floor(ramMB * 0.75));
}

/**
 * If no heap flag is set, re-exec the same command with one and exit with the
 * child's status. Skipped when already respawned or when a flag is present.
 */
export function ensureHeap(): void {
  if (process.env[RESPAWN_FLAG] === '1' || hasHeapFlag()) return;
  const sizeMB = totalHeapMB();
  const env = { ...process.env, [RESPAWN_FLAG]: '1', NODE_OPTIONS: withHeap(sizeMB) };
  const res = spawnSync(process.argv[0], process.argv.slice(1), { stdio: 'inherit', env });
  process.exit(res.status ?? 1);
}

export interface WorkerPlan {
  workers: number; // concurrent child processes
  perWorkerMB: number; // V8 old-space per child
}

/** Plan concurrency + per-worker heap so the total stays near 75% of RAM. */
export function planWorkers(roots: number, requested?: number | null): WorkerPlan {
  const ramMB = Math.floor(os.totalmem() / 1024 / 1024);
  const budgetMB = Math.max(4096, Math.floor(ramMB * 0.75));
  const cpus = Math.max(1, os.cpus().length - 1);
  // Each worker needs a meaningful heap; cap concurrency so each gets >= 4GB.
  const byMem = Math.max(1, Math.floor(budgetMB / 4096));
  let workers = requested && requested > 0 ? requested : Math.min(cpus, byMem);
  workers = Math.max(1, Math.min(workers, roots));
  const override = parseInt(process.env[SIZE_ENV] ?? '', 10);
  const perWorkerMB = Number.isFinite(override) && override > 0
    ? override
    : Math.max(4096, Math.floor(budgetMB / workers));
  return { workers, perWorkerMB };
}

export interface WorkerArgs {
  entry: string; // script to run (process.argv[1])
  repoRoot: string;
  envFile?: string;
  mode?: string;
}

function tmpFor(root: string): string {
  // pid + path length disambiguates same-basename members across the tree.
  return path.join(os.tmpdir(), `flowmap-ir-${process.pid}-${path.basename(root)}-${root.length}.json`);
}

function spawnOne(root: string, plan: WorkerPlan, a: WorkerArgs): Promise<IrFile[]> {
  return new Promise((resolve) => {
    const tmp = tmpFor(root);
    const args = [a.entry, '__ir', '--root', root, '--repo', a.repoRoot, '--out', tmp];
    if (a.envFile) args.push('--env', a.envFile);
    if (a.mode) args.push('--mode', a.mode);
    const env = { ...process.env, [RESPAWN_FLAG]: '1', NODE_OPTIONS: withHeap(plan.perWorkerMB) };
    process.stderr.write(`  → ${path.basename(root)}\n`);
    const child = spawn(process.argv[0], args, { stdio: ['ignore', 'inherit', 'inherit'], env });
    const cleanup = () => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } };
    child.on('exit', (code) => {
      if (code !== 0) {
        process.stderr.write(`  ! worker failed for ${path.basename(root)} (exit ${code})\n`);
        cleanup();
        return resolve([]);
      }
      try {
        resolve(JSON.parse(fs.readFileSync(tmp, 'utf8')) as IrFile[]);
      } catch (e) {
        process.stderr.write(`  ! could not read worker output for ${path.basename(root)}: ${(e as Error).message}\n`);
        resolve([]);
      } finally {
        cleanup();
      }
    });
    child.on('error', (e) => {
      process.stderr.write(`  ! could not spawn worker for ${path.basename(root)}: ${e.message}\n`);
      cleanup();
      resolve([]);
    });
  });
}

/**
 * Analyze each root in a child process (bounded concurrency) and return the
 * merged IR. The parent never holds a `ts.Program`, so its memory stays flat.
 */
export async function runProjectWorkers(roots: string[], plan: WorkerPlan, a: WorkerArgs): Promise<IrFile[]> {
  process.stderr.write(`analyze: ${roots.length} project roots, ${plan.workers} workers, ${plan.perWorkerMB}MB/worker\n`);
  const batches = await poolRun(roots, plan.workers, (r) => spawnOne(r, plan, a));
  const all: IrFile[] = [];
  for (const b of batches) all.push(...b);
  return all;
}

/** Run `task` over items with at most `limit` concurrent, preserving order. */
function poolRun<T, R>(items: T[], limit: number, task: (t: T) => Promise<R>): Promise<R[]> {
  return new Promise((resolve) => {
    const results: R[] = new Array(items.length);
    let next = 0;
    let done = 0;
    if (!items.length) return resolve(results);
    const startOne = () => {
      if (next >= items.length) return;
      const i = next++;
      task(items[i]).then((r) => {
        results[i] = r;
        done++;
        if (done === items.length) resolve(results);
        else startOne();
      });
    };
    for (let k = 0; k < Math.min(limit, items.length); k++) startOne();
  });
}
