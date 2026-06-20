/**
 * Git access for PR-impact analysis — a port of the Spring analyzer's GitLog.kt +
 * GitHub.kt (PR source + first-parent diff machinery), kept language-agnostic.
 *
 * GIT-FIRST, gh-fallback: merged PRs and their net change sets are derived from
 * local git (`git log --first-parent` + `git show`) so analysis works with NO
 * `gh` and on GitHub Enterprise. `gh pr list` is used only when git yields no PR
 * markers (e.g. a rebase-merge history) or can't run.
 *
 * Each PR is reduced to its merge/squash commit, whose first-parent diff is the
 * PR's net change. [changesIn] attributes the NEW-side changed line ranges to
 * files; [fileParser] then maps those ranges to graph node ids.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface Pr {
  number: number;
  title: string;
  author: string | null;
  mergedAt: string | null;
  mergeCommit: string | null; // merge/squash commit oid; null if unavailable
}

/** A changed file with the NEW-side line ranges touched (empty for pure deletions). */
export interface FileChange {
  path: string;
  oldPath: string | null;
  changeType: 'ADD' | 'DELETE' | 'RENAME' | 'MODIFY';
  newRanges: Array<[number, number]>; // inclusive [start, end]
}

/** Run [command] in [repo]; returns (stdout, exitCode), or ("", -1) if it can't launch. */
function exec(repo: string, command: string, args: string[]): { out: string; code: number } {
  try {
    const r = spawnSync(command, args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.error) return { out: '', code: -1 };
    return { out: r.stdout ?? '', code: r.status ?? -1 };
  } catch {
    return { out: '', code: -1 };
  }
}

function git(repo: string, args: string[]): { out: string; code: number } {
  return exec(repo, 'git', args);
}

export function isRepo(repo: string): boolean {
  return git(repo, ['rev-parse', '--is-inside-work-tree']).out.trim() === 'true';
}

/** True when [dir] is a git work-tree ROOT (holds a `.git` dir or file). */
export function hasGitDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/**
 * Resolve which git work tree to mine for a service graph, and the path prefix
 * that maps that tree's blob paths onto the graph's repo-relative node ids.
 *
 * A service's analyzed root is `<repoRoot>/<projectRootRel>` (the graph's
 * `meta.root`). Its git work tree is the NEAREST ancestor — the project dir
 * itself or upward, bounded at [repoRoot] — that is a git root: for a standalone
 * checkout that's the project dir; for a package split out of a MONOREPO it's the
 * monorepo root (the package dir has no `.git` of its own).
 *
 * The prefix is that git root's repo-relative path, because a diff's blob paths
 * are git-root-relative while graph node files are repoRoot-relative:
 *   `prefix + "/" + <blobPath>` === `<nodeFile>`   (prefix is '' when the git root IS repoRoot).
 * So a monorepo package mines the monorepo git with prefix `<monorepo-dir>`, not
 * the flattened service name — which is why the per-package graph's nodes match.
 *
 * Returns null when no git work tree exists at or above the project dir (within
 * repoRoot) — e.g. an analyzed checkout that was never a git repo. [isGitRoot] is
 * injectable for testing; it defaults to a `.git` existence check on disk.
 */
export function resolveGitTarget(
  repoRoot: string,
  projectRootRel: string,
  isGitRoot: (absDir: string) => boolean = hasGitDir,
): { gitDir: string; prefix: string } | null {
  const repoAbs = path.resolve(repoRoot);
  let dir = path.resolve(repoAbs, projectRootRel);
  for (;;) {
    if (isGitRoot(dir)) {
      return { gitDir: dir, prefix: path.relative(repoAbs, dir).split(path.sep).join('/') };
    }
    if (dir === repoAbs) return null; // never walk above the repo root
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/** Currently checked-out branch, or "HEAD" if detached. */
export function currentBranch(repo: string): string {
  return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
}

/**
 * Pick the branch to mine: explicit override → the checked-out branch →
 * origin/HEAD (if detached) → main/master/develop. Returns null if none verify.
 */
export function resolveBranch(repo: string, override: string | null): string | null {
  if (override) return verifyRef(repo, override) ? override : null;
  const cur = currentBranch(repo);
  if (cur && cur !== 'HEAD') return cur;
  const head = git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).out.trim().replace(/^origin\//, '');
  if (head && verifyRef(repo, head)) return head;
  for (const c of ['main', 'master', 'develop']) if (verifyRef(repo, c)) return c;
  return null;
}

function verifyRef(repo: string, ref: string): boolean {
  return git(repo, ['rev-parse', '--verify', '--quiet', ref]).out.trim().length > 0;
}

/** The `origin` remote URL, or null if there is no `origin`. */
export function remoteUrl(repo: string): string | null {
  return git(repo, ['remote', 'get-url', 'origin']).out.trim() || null;
}

/** Web base URL for this repo's `origin` (e.g. `https://github.com/owner/repo`), or null. */
export function webBaseUrl(repo: string): string | null {
  const u = remoteUrl(repo);
  return u ? toWebBase(u) : null;
}

/**
 * Normalize a git remote URL to its https web base (no trailing `.git`), handling
 * scp-style (`git@host:owner/repo.git`), `ssh://`, and `http(s)://` forms and
 * stripping embedded credentials. Returns null when it cannot be turned into an
 * https URL. Pure (no git invocation) so it is unit-testable.
 */
export function toWebBase(remote: string): string | null {
  let u = remote.trim();
  if (!u) return null;
  if (u.startsWith('git@')) u = 'https://' + u.slice('git@'.length).replace(':', '/');
  else if (u.startsWith('ssh://')) u = 'https://' + u.slice('ssh://'.length);
  else if (u.startsWith('http://')) u = 'https://' + u.slice('http://'.length);
  else if (!u.startsWith('https://')) return null;
  u = u.replace(/^https:\/\/[^/@]+@/, 'https://'); // strip user[:token]@ credentials
  u = u.replace(/\/+$/, '').replace(/\.git$/, '');
  return u || null;
}

/**
 * Parse a git remote URL into its `{ namespace, repo }` (owner + repo) — the last two
 * path segments of the normalized web base, e.g. `git@github.com:geeshow/flowmap-react.git`
 * → `{ namespace: 'geeshow', repo: 'flowmap-react' }`. Null when it can't be normalized.
 */
export function parseNamespaceRepo(remote: string): { namespace: string; repo: string } | null {
  const web = toWebBase(remote);
  if (!web) return null;
  const segs = web.replace(/^https:\/\//, '').split('/').filter(Boolean);
  if (segs.length < 3) return null; // [host, owner..., repo]
  return { namespace: segs[segs.length - 2], repo: segs[segs.length - 1] };
}

/** `{ namespace, repo }` for the git work tree at [gitDir] from its `origin` remote, or null. */
export function namespaceRepo(gitDir: string): { namespace: string; repo: string } | null {
  const u = remoteUrl(gitDir);
  return u ? parseNamespaceRepo(u) : null;
}

// ---- PR discovery ----

const MERGE_PR = /^Merge pull request #(\d+) /;
const SQUASH_PR = /\(#(\d+)\)\s*$/;

/**
 * Newest-first merged PRs targeting [base], capped at [limit]. GIT-FIRST; falls
 * back to `gh pr list` only when git yields nothing. Returns null only when BOTH
 * sources are unavailable (distinct from an empty list = source ran, no PRs).
 *
 * [since] (an ISO date) bounds the git scan to commits at/after that time — used
 * by incremental runs to mine only PRs merged since the last analysis. It applies
 * to the git path only; the `gh` fallback ignores it (dedup-by-number keeps the
 * merged output correct regardless).
 */
export function mergedPulls(repo: string, base: string | null, limit: number, since?: string | null): Pr[] | null {
  const fromGit = gitMergedPulls(repo, base ?? 'HEAD', limit, since);
  if (fromGit.length) return fromGit;
  return ghMergedPulls(repo, base, limit);
}

/** PR set parsed from `git log --first-parent` (merge + squash markers). [since] bounds by date. */
export function gitMergedPulls(repo: string, base: string, limit: number, since?: string | null): Pr[] {
  // \x1f field sep, \x1e record sep — safe across multi-line bodies.
  const args = ['log', '--first-parent', base, '-n', '5000', '--no-color'];
  if (since) args.push(`--since=${since}`);
  args.push('--pretty=format:%H%x1f%cI%x1f%an%x1f%s%x1f%b%x1e');
  const { out, code } = git(repo, args);
  if (code !== 0) return [];
  return parseGitLog(out, limit);
}

/** Parse the `%H\x1f%cI\x1f%an\x1f%s\x1f%b\x1e`-formatted log into newest-first PRs. Pure. */
export function parseGitLog(out: string, limit: number): Pr[] {
  const prs: Pr[] = [];
  for (const rec of out.split('')) {
    const r = rec.replace(/^[\n\r]+|[\n\r]+$/g, '');
    if (!r.trim()) continue;
    const f = r.split('');
    if (f.length < 4) continue;
    const sha = f[0].trim();
    if (!sha) continue;
    const date = f[1].trim() || null;
    const author = f[2].trim() || null;
    const subject = f[3];
    const body = f[4] ?? '';
    const merge = MERGE_PR.exec(subject);
    const squash = merge ? null : SQUASH_PR.exec(subject);
    const numStr = (merge ?? squash)?.[1];
    const number = numStr ? parseInt(numStr, 10) : NaN;
    if (!Number.isFinite(number)) continue; // non-PR commit
    const title = merge
      ? (body.split(/\r?\n/).find((l) => l.trim()) ?? subject).trim()
      : subject.replace(SQUASH_PR, '').trim();
    prs.push({ number, title, author, mergedAt: date, mergeCommit: sha });
    if (prs.length >= limit) break;
  }
  return prs;
}

/** Merged PRs via `gh pr list` (server source / fallback). Null when `gh` can't run. */
export function ghMergedPulls(repo: string, base: string | null, limit: number): Pr[] | null {
  const args = ['pr', 'list', '--state', 'merged', '--limit', String(limit), '--json', 'number,title,author,mergedAt,mergeCommit'];
  if (base) args.push('--base', base);
  const { out, code } = exec(repo, 'gh', args);
  if (code !== 0) return null;
  return parseGhList(out);
}

/** Parse `gh pr list --json number,title,author,mergedAt,mergeCommit` output. Pure. */
export function parseGhList(json: string): Pr[] {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(root)) return [];
  const out: Pr[] = [];
  for (const n of root as Array<Record<string, any>>) {
    const number = typeof n.number === 'number' ? n.number : NaN;
    if (!Number.isFinite(number)) continue;
    out.push({
      number,
      title: String(n.title ?? ''),
      author: n.author?.login ? String(n.author.login) : null,
      mergedAt: n.mergedAt ? String(n.mergedAt) : null,
      mergeCommit: n.mergeCommit?.oid ? String(n.mergeCommit.oid) : null,
    });
  }
  return out;
}

// ---- per-commit diff / blob ----

/** First parent of [sha] (the base side of a PR merge), or null if absent/root. */
export function firstParent(repo: string, sha: string): string | null {
  return git(repo, ['rev-parse', '--verify', '--quiet', `${sha}^1`]).out.trim() || null;
}

/** Per-file new-side changed line ranges for [sha] vs its first parent. */
export function changesIn(repo: string, sha: string): FileChange[] {
  return parseDiff(git(repo, ['show', sha, '--first-parent', '-U0', '-M', '--no-color', '--format=']).out);
}

/** Content of [path] at [sha], or null if absent. */
export function fileAt(repo: string, sha: string, path: string): string | null {
  const { out, code } = git(repo, ['show', `${sha}:${path}`]);
  return code === 0 && out ? out : null;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(.*) b\/(.*)$/;

/** Parse a `git show --first-parent -U0 -M` unified diff into per-file [FileChange]s. Pure. */
export function parseDiff(text: string): FileChange[] {
  const out: FileChange[] = [];
  let aPath: string | null = null;
  let bPath: string | null = null;
  let ctype: FileChange['changeType'] = 'MODIFY';
  let ranges: Array<[number, number]> = [];
  const flush = () => {
    const path = bPath ?? aPath;
    if (!path) return;
    out.push({ path, oldPath: aPath && aPath !== path ? aPath : null, changeType: ctype, newRanges: ranges });
  };
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      flush();
      aPath = null;
      bPath = null;
      ctype = 'MODIFY';
      ranges = [];
      const m = DIFF_GIT.exec(raw);
      if (m) {
        aPath = m[1];
        bPath = m[2];
      }
      continue;
    }
    if (raw.startsWith('rename from ')) {
      aPath = raw.slice('rename from '.length);
      ctype = 'RENAME';
    } else if (raw.startsWith('rename to ')) {
      bPath = raw.slice('rename to '.length);
    } else if (raw.startsWith('new file')) {
      ctype = 'ADD';
    } else if (raw.startsWith('deleted file')) {
      ctype = 'DELETE';
    } else if (raw.startsWith('--- a/')) {
      aPath = raw.slice('--- a/'.length);
    } else if (raw.startsWith('+++ b/')) {
      bPath = raw.slice('+++ b/'.length);
    } else if (raw.startsWith('@@')) {
      const m = HUNK.exec(raw);
      if (m) {
        const start = parseInt(m[1], 10);
        const count = m[2] != null ? parseInt(m[2], 10) : 1;
        ranges.push(count > 0 ? [start, start + count - 1] : [start, start]);
      }
    }
  }
  flush();
  return out.filter((c) => c.path.length > 0);
}
