/**
 * Per-PR file-diff artifacts: a light `<base>.pulls.json` index + one heavy
 * `<base>.pulls/<number>.json` shard per PR (lazy-loaded on demand). Port of the
 * Spring analyzer's writePullFiles + GitHub.{buildShard,indexEntry,pullIndexDoc}.
 *
 * INCREMENTAL: a merged PR's files are immutable, so a PR whose shard already
 * exists is REUSED as-is — no git/gh call — and only NEW PRs are fetched. An OPEN
 * PR's files keep changing, so its shard is always re-collected. Stale shards (PRs
 * no longer in the window) are pruned. Returns (fetched, reused) counts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as gitSource from './git';
import type { Pr, PrFile } from './git';
import * as jsonOutput from '../jsonOutput';

/** Full per-PR shard doc — that PR's per-file status + unified patch (`<dir>/<n>.json`). */
function buildShard(pr: Pr, files: PrFile[], webBase: string | null): Record<string, unknown> {
  return {
    command: 'pull-files',
    number: pr.number,
    title: pr.title,
    author: pr.author,
    mergedAt: pr.mergedAt,
    updatedAt: pr.updatedAt ?? null,
    mergeCommit: gitSource.analyzedCommit(pr),
    status: pr.status ?? 'merged',
    url: webBase ? `${webBase}/pull/${pr.number}` : null,
    repoUrl: webBase,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
    changedFiles: files.length,
    files: files.map((f) => ({
      path: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      previousPath: f.previousPath,
      patch: f.patch,
    })),
  };
}

/** One light index entry from a [shard] doc — PR metadata + line stats + a `file` ref. No patch. */
function indexEntry(shard: Record<string, unknown>, shardDir: string): Record<string, unknown> {
  return {
    number: shard.number,
    title: shard.title,
    author: shard.author,
    mergedAt: shard.mergedAt,
    updatedAt: shard.updatedAt,
    mergeCommit: shard.mergeCommit, // 배포 이미지 태그(...:<branch>-<sha>) 매칭용 커밋 SHA
    status: shard.status ?? 'merged',
    url: shard.url,
    additions: shard.additions,
    deletions: shard.deletions,
    changedFiles: shard.changedFiles,
    file: `${shardDir}/${shard.number}.json`,
  };
}

/** The `<base>.pulls.json` index doc wrapping the per-PR [entries] (newest-first). */
function pullIndexDoc(base: string, webBase: string | null, shardDir: string, entries: Record<string, unknown>[]): Record<string, unknown> {
  return {
    command: 'pull-files-index',
    base,
    repoUrl: webBase,
    dir: shardDir,
    pullCount: entries.length,
    pulls: entries,
  };
}

/** Read an existing shard json back into a map (to reuse an already-collected PR). Null if unreadable. */
function readShard(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write `<dir>/<fileBase>.pulls.json` (index) + `<dir>/<fileBase>.pulls/<n>.json`
 * (per-PR shards) for [pulls]. A merged PR's shard is reused when present (unless
 * a full / refetch run); an open PR is always re-collected; stale shards are pruned.
 */
export function writePulls(
  dir: string,
  fileBase: string,
  repo: string,
  base: string,
  pulls: Pr[],
  o: { incremental: boolean; refetch?: boolean },
): { fetched: number; reused: number } {
  const shardDirName = `${fileBase}.pulls`;
  const shardDir = path.join(dir, shardDirName);
  fs.mkdirSync(shardDir, { recursive: true });
  const webBase = gitSource.webBaseUrl(repo);
  const indexPath = path.join(dir, `${fileBase}.pulls.json`);

  // Index entries keyed by PR number. INCREMENTAL: seed from the existing index so PRs
  //   OUTSIDE this batch persist (runImpact passes only NEW merged PRs in incremental mode;
  //   their immutable shards stay on disk and their index rows are carried over here). A FULL
  //   run starts empty and replaces the index. Mirrors impact.mergeIndex's contract.
  const entriesByNumber = new Map<number, Record<string, unknown>>();
  const keep = new Set<string>();
  if (o.incremental) {
    const prev = readShard(indexPath);
    for (const e of ((prev?.pulls as Record<string, unknown>[]) ?? [])) {
      const num = Number(e?.number);
      if (Number.isFinite(num)) {
        entriesByNumber.set(num, e);
        keep.add(`${num}.json`); // its shard backs a retained row
      }
    }
  }
  let fetched = 0;
  let reused = 0;
  // A non-incremental (full) run re-collects every PR; incremental reuses immutable shards.
  const refetchAll = !!o.refetch || !o.incremental;

  for (const pr of pulls) {
    const shardName = `${pr.number}.json`;
    const shardFile = path.join(shardDir, shardName);
    // reuse an already-collected PR (immutable) unless forced. An OPEN PR's files keep
    //   changing, so never reuse its shard — always re-collect.
    let shard: Record<string, unknown> | null =
      !refetchAll && !gitSource.isOpenPr(pr) && fs.existsSync(shardFile) ? readShard(shardFile) : null;
    if (shard) reused++;
    if (!shard) {
      const files = gitSource.pullFiles(repo, pr, base);
      if (files == null) {
        // both sources failed: preserve any prior shard + its row, don't prune it
        if (fs.existsSync(shardFile)) {
          keep.add(shardName);
          const prevShard = readShard(shardFile);
          if (prevShard) entriesByNumber.set(pr.number, indexEntry(prevShard, shardDirName));
        }
        continue;
      }
      shard = buildShard(pr, files, webBase);
      fs.writeFileSync(shardFile, jsonOutput.writeValue(shard));
      fetched++;
    }
    keep.add(shardName);
    entriesByNumber.set(pr.number, indexEntry(shard, shardDirName));
  }

  // Prune shards no longer referenced. A full run prunes everything outside this batch; an
  // incremental run keeps the shards backing carried-over rows (all in `keep`).
  try {
    for (const f of fs.readdirSync(shardDir)) {
      if (f.endsWith('.json') && !keep.has(f)) fs.unlinkSync(path.join(shardDir, f));
    }
  } catch {
    /* shard-dir prune is best-effort */
  }

  const entries = [...entriesByNumber.values()].sort((a, b) => Number(b.number) - Number(a.number));
  fs.writeFileSync(indexPath, jsonOutput.writeValue(pullIndexDoc(base, webBase, shardDirName, entries)));
  return { fetched, reused };
}
