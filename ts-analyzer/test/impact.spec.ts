/**
 * Unit tests for the PR-impact building blocks — the pure parsers ported from
 * the Spring analyzer (parseGitLog / parseDiff / toWebBase) and the standalone
 * blob symbol parser (fileParser.functions) that maps a revision's source to
 * graph node ids. These cover the contract `impact` depends on without needing a
 * git repo.
 */

import { describe, expect, it } from 'vitest';
import { parseGitLog, parseDiff, parseGhList, parseGhOpen, analyzedCommit, isOpenPr, toWebBase, resolveGitTarget } from '../src/impact/git';
import { functions } from '../src/impact/fileParser';
import { mergeIndex, ImpactResult } from '../src/impact/impact';

// Build a record-formatted git log the way `--pretty=format:%H\x1f%cI\x1f%an\x1f%s\x1f%b\x1e` does.
function rec(sha: string, date: string, author: string, subject: string, body = ''): string {
  return [sha, date, author, subject, body].join('\x1f') + '\x1e';
}

describe('parseGitLog', () => {
  it('parses a merge-commit PR (title from body) and a squash PR (title from subject)', () => {
    const log =
      rec('a1', '2026-01-02T00:00:00Z', 'kim', 'Merge pull request #42 from x/feature', 'Add login screen\n\nmore') +
      rec('b2', '2026-01-01T00:00:00Z', 'lee', 'fix: tidy up things (#41)');
    const prs = parseGitLog(log, 10);
    expect(prs).toHaveLength(2);
    expect(prs[0]).toMatchObject({ number: 42, title: 'Add login screen', author: 'kim', mergeCommit: 'a1' });
    expect(prs[1]).toMatchObject({ number: 41, title: 'fix: tidy up things', author: 'lee', mergeCommit: 'b2' });
  });

  it('skips non-PR commits and honors the limit', () => {
    const log =
      rec('a1', 'd', 'k', 'Merge pull request #5 from x/y', 'Five') +
      rec('c3', 'd', 'k', 'chore: a plain commit') +
      rec('b2', 'd', 'k', 'feat: thing (#4)');
    expect(parseGitLog(log, 10).map((p) => p.number)).toEqual([5, 4]);
    expect(parseGitLog(log, 1).map((p) => p.number)).toEqual([5]);
  });
});

describe('parseDiff', () => {
  it('extracts new-side hunk ranges, rename + delete change types', () => {
    const diff = [
      'diff --git a/src/A.tsx b/src/A.tsx',
      '--- a/src/A.tsx',
      '+++ b/src/A.tsx',
      '@@ -10,2 +10,3 @@',
      '@@ -40,0 +50,5 @@',
      'diff --git a/src/Old.ts b/src/New.ts',
      'rename from src/Old.ts',
      'rename to src/New.ts',
      'diff --git a/src/Gone.ts b/src/Gone.ts',
      'deleted file mode 100644',
      '--- a/src/Gone.ts',
      '+++ /dev/null',
    ].join('\n');
    const changes = parseDiff(diff);
    const a = changes.find((c) => c.path === 'src/A.tsx')!;
    expect(a.changeType).toBe('MODIFY');
    expect(a.newRanges).toEqual([
      [10, 12],
      [50, 54],
    ]);
    const ren = changes.find((c) => c.path === 'src/New.ts')!;
    expect(ren.changeType).toBe('RENAME');
    expect(ren.oldPath).toBe('src/Old.ts');
    const del = changes.find((c) => c.path === 'src/Gone.ts')!;
    expect(del.changeType).toBe('DELETE');
  });
});

describe('parseGhList', () => {
  it('reads gh pr list --json output', () => {
    const json = JSON.stringify([
      { number: 9, title: 'T', author: { login: 'me' }, mergedAt: '2026-01-01', mergeCommit: { oid: 'sha9' } },
      { number: 0 - 1 }, // still a number — kept
    ]);
    const prs = parseGhList(json);
    expect(prs[0]).toMatchObject({ number: 9, title: 'T', author: 'me', mergeCommit: 'sha9' });
  });
  it('returns [] for non-array / malformed json', () => {
    expect(parseGhList('not json')).toEqual([]);
    expect(parseGhList('{}')).toEqual([]);
  });
});

describe('parseGhOpen', () => {
  it('maps headOid, status, updatedAt for open and draft PRs', () => {
    const json = JSON.stringify([
      { number: 42, title: 'wip', author: { login: 'alice' }, headRefOid: 'abc', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-10T09:00:00Z', isDraft: false },
      { number: 7, title: 'draft', author: { login: 'bob' }, headRefOid: 'def', createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-02T00:00:00Z', isDraft: true },
    ]);
    const prs = parseGhOpen(json);
    expect(prs).toHaveLength(2);
    expect(prs[0]).toMatchObject({ number: 42, status: 'open', headOid: 'abc', mergedAt: null, mergeCommit: null, updatedAt: '2026-06-10T09:00:00Z' });
    expect(analyzedCommit(prs[0])).toBe('abc'); // no mergeCommit → head is analyzed revision
    expect(isOpenPr(prs[0])).toBe(true);
    expect(prs[1]).toMatchObject({ status: 'draft' });
    expect(isOpenPr(prs[1])).toBe(true);
  });
  it('falls back to createdAt and tolerates garbage', () => {
    const one = parseGhOpen(JSON.stringify([{ number: 1, title: 't', headRefOid: 'h', createdAt: '2026-01-01T00:00:00Z' }]));
    expect(one[0].updatedAt).toBe('2026-01-01T00:00:00Z');
    expect(one[0].status).toBe('open'); // isDraft absent → open
    expect(parseGhOpen('not json')).toEqual([]);
    expect(parseGhOpen('{}')).toEqual([]);
  });
  it('a merged PR is not open and uses its mergeCommit as the analyzed commit', () => {
    const merged = parseGhList(JSON.stringify([{ number: 9, title: 'T', mergedAt: '2026-01-01', mergeCommit: { oid: 'sha9' } }]))[0];
    expect(isOpenPr(merged)).toBe(false);
    expect(analyzedCommit(merged)).toBe('sha9');
  });
});

describe('toWebBase', () => {
  it('normalizes scp/ssh/https remotes and strips creds + .git', () => {
    expect(toWebBase('git@github.com:owner/repo.git')).toBe('https://github.com/owner/repo');
    expect(toWebBase('ssh://git@github.com/owner/repo.git')).toBe('https://github.com/owner/repo');
    expect(toWebBase('https://user:token@github.com/owner/repo.git')).toBe('https://github.com/owner/repo');
    expect(toWebBase('ftp://nope')).toBeNull();
  });
});

describe('resolveGitTarget — git work tree + prefix (standalone vs monorepo)', () => {
  const repoRoot = '/r';
  // Predicate stand-in for the on-disk `.git` check: the given absolute dirs are git roots.
  const gitRootsAt = (...dirs: string[]) => (d: string) => dirs.includes(d);

  it('standalone checkout: git root IS the project dir, prefix is its repo-relative name', () => {
    const t = resolveGitTarget(repoRoot, 'front-official-desktop', gitRootsAt('/r/front-official-desktop'));
    expect(t).toEqual({ gitDir: '/r/front-official-desktop', prefix: 'front-official-desktop' });
  });

  it('monorepo package: walks up to the monorepo git root; prefix is the monorepo dir', () => {
    // .repo/my-mono is the git work tree; packages/web is a split-out root with no .git of its own.
    const t = resolveGitTarget(repoRoot, 'my-mono/packages/web', gitRootsAt('/r/my-mono'));
    expect(t).toEqual({ gitDir: '/r/my-mono', prefix: 'my-mono' });
    // The prefix must reconstruct a repo-relative node file from a git-root-relative blob path
    // (git diff yields `packages/web/...`; the graph node file is `my-mono/packages/web/...`).
    expect(`${t!.prefix}/packages/web/src/App.tsx`).toBe('my-mono/packages/web/src/App.tsx');
  });

  it('two packages of the same monorepo resolve to the same git, each with the monorepo prefix', () => {
    const web = resolveGitTarget(repoRoot, 'my-mono/packages/web', gitRootsAt('/r/my-mono'));
    const api = resolveGitTarget(repoRoot, 'my-mono/apps/api', gitRootsAt('/r/my-mono'));
    expect(web!.gitDir).toBe('/r/my-mono');
    expect(api!.gitDir).toBe('/r/my-mono');
    expect(web!.prefix).toBe('my-mono');
    expect(api!.prefix).toBe('my-mono');
  });

  it('returns null when no git work tree exists at or above the project (within repoRoot)', () => {
    expect(resolveGitTarget(repoRoot, 'my-mono/packages/web', gitRootsAt('/elsewhere'))).toBeNull();
    // never walks above repoRoot, so a git root only at `/` is not used
    expect(resolveGitTarget(repoRoot, 'a/b', gitRootsAt('/'))).toBeNull();
  });

  it('repoRoot itself as the git root yields an empty prefix (paths already repo-relative)', () => {
    expect(resolveGitTarget(repoRoot, 'a/b', gitRootsAt('/r'))).toEqual({ gitDir: '/r', prefix: '' });
  });
});

describe('mergeIndex — incremental merge of a new delta into an existing index', () => {
  // existing: PR #10 (older). Its in-graph changed id comes from its shard on disk,
  // supplied here via the injected reader.
  const existing = {
    base: 'main',
    repoUrl: 'https://github.com/o/r',
    pullCount: 1,
    changedNodeCount: 1,
    impactedEndpointCount: 1,
    pulls: [
      {
        number: 10,
        title: 'old pr',
        author: 'a',
        mergedAt: '2026-01-01T00:00:00Z',
        mergeCommit: 'sha10',
        changedNodeCount: 1,
        changedFileCount: 1,
        impactedEndpoints: [{ id: 'app/Home.tsx::Home', httpMethod: null, endpoint: '/', service: 'web' }],
      },
    ],
  };
  // new delta: PR #11 (newer) — analyze() output for the new pulls only.
  const newResult: ImpactResult = {
    index: {
      base: 'main',
      repoUrl: 'https://github.com/o/r',
      pullCount: 1,
      changedNodeCount: 1,
      impactedEndpointCount: 1,
      pulls: [
        {
          number: 11,
          title: 'new pr',
          author: 'b',
          mergedAt: '2026-02-01T00:00:00Z',
          mergeCommit: 'sha11',
          changedNodeCount: 1,
          changedFileCount: 1,
          impactedEndpoints: [{ id: 'app/Cart.tsx::Cart', httpMethod: null, endpoint: '/cart', service: 'web' }],
        },
      ],
    },
    shards: new Map([[11, { number: 11, mergeCommit: 'sha11', changedNodes: [{ id: 'app/Cart.tsx::Cart', inGraph: true, visibility: 'public', kind: 'component' }] }]]),
  };
  // existing PR #10's in-graph changed ids, as read from its shard file.
  const existingChanged = (n: number) => (n === 10 ? ['app/Home.tsx::Home'] : []);

  it('unions pulls newest-first and recomputes aggregate counts over both', () => {
    const m = mergeIndex(existing, newResult, existingChanged) as any;
    expect(m.pulls.map((p: any) => p.number)).toEqual([11, 10]); // newest mergedAt first
    expect(m.pullCount).toBe(2);
    expect(m.changedNodeCount).toBe(2); // Home (existing shard) ∪ Cart (new shard)
    expect(m.impactedEndpointCount).toBe(2); // Home + Cart screens
    expect(m.base).toBe('main');
  });

  it('re-analyzed PR: the new row + shard win, no duplicate row', () => {
    const reanalyzed: ImpactResult = {
      index: { pulls: [{ ...(newResult.index.pulls as any[])[0], number: 10, title: 'reanalyzed', mergedAt: '2026-03-01T00:00:00Z', impactedEndpoints: [] }] },
      shards: new Map([[10, { number: 10, changedNodes: [{ id: 'app/Home.tsx::Home', inGraph: true }, { id: 'app/Home.tsx::Sidebar', inGraph: true }] }]]),
    };
    const m = mergeIndex(existing, reanalyzed, existingChanged) as any;
    expect(m.pulls).toHaveLength(1);
    expect(m.pulls[0].title).toBe('reanalyzed');
    expect(m.changedNodeCount).toBe(2); // from the NEW shard (Home + Sidebar), not the stale reader
    expect(m.impactedEndpointCount).toBe(0);
  });
});

describe('fileParser.functions — React', () => {
  it('derives <path>::<Name> ids with ranges for components and hooks, skips plain fns', () => {
    const src = [
      'export function UserList() {', // 1
      '  return null;', //               2
      '}', //                            3
      'const useThing = () => useSWR("/x");', // 4
      'function helper() { return 1; }', //       5  (plain fn — not a node)
      'export const Card = memo(() => null);', //  6  (HOC-wrapped component)
    ].join('\n');
    const fns = functions('app/Users.tsx', src);
    const byId = new Map(fns.map((f) => [f.nodeId, f]));
    expect(byId.get('app/Users.tsx::UserList')!.kind).toBe('component');
    expect(byId.get('app/Users.tsx::UserList')!.exported).toBe(true);
    expect(byId.get('app/Users.tsx::useThing')!.kind).toBe('hook');
    expect(byId.has('app/Users.tsx::helper')).toBe(false); // plain util excluded
    expect(byId.has('app/Users.tsx::Card')).toBe(true); // memo(...) unwrapped
    // UserList spans lines 1..3
    const ul = byId.get('app/Users.tsx::UserList')!;
    expect([ul.startLine, ul.endLine]).toEqual([1, 3]);
  });

  it('names a named default export by its name, an anonymous one as ::default', () => {
    expect(functions('p/A.tsx', 'export default function Page(){ return null; }')[0].nodeId).toBe('p/A.tsx::Page');
    expect(functions('p/B.tsx', 'export default function(){ return null; }')[0].nodeId).toBe('p/B.tsx::default');
  });
});

describe('fileParser.functions — Vue SFC', () => {
  it('uses the name: option when present', () => {
    const sfc = ['<template><div/></template>', '<script>', 'export default {', "  name: 'PageAuthJoin',", '}', '</script>'].join('\n');
    const fns = functions('pages/Auth/Join.vue', sfc);
    expect(fns).toHaveLength(1);
    expect(fns[0].nodeId).toBe('pages/Auth/Join.vue::PageAuthJoin');
    expect(fns[0].kind).toBe('component');
  });
  it('falls back to PascalCase from the file path', () => {
    const sfc = '<template><div/></template>\n<script>export default {}</script>';
    expect(functions('components/user-card.vue', sfc)[0].nodeId).toBe('components/user-card.vue::UserCard');
  });
});

describe('fileParser.functions — React state stores', () => {
  it('derives redux slice + thunk ids (library detected by import source)', () => {
    const src = [
      "import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';",
      "export const fetchUser = createAsyncThunk('user/fetchUser', async () => {});",
      "const userSlice = createSlice({ name: 'user', reducers: { setName(s, a) {} } });",
    ].join('\n');
    const ids = functions('src/store/userSlice.ts', src).map((f) => f.nodeId);
    expect(ids).toContain('store:redux:user'); // slice (name option)
    expect(ids).toContain('store:redux:user#fetchUser'); // thunk (prefix#var)
  });

  it('derives zustand store + per-action ids', () => {
    const src = [
      "import { create } from 'zustand';",
      'export const useCartStore = create((set) => ({',
      '  items: [],',
      '  add: (x) => set({}),',
      '  clear: () => set({}),',
      '}));',
    ].join('\n');
    const ids = functions('src/store/cartStore.ts', src).map((f) => f.nodeId);
    expect(ids).toEqual(
      expect.arrayContaining(['store:zustand:useCartStore', 'store:zustand:useCartStore#add', 'store:zustand:useCartStore#clear']),
    );
  });

  it('derives a context store id and ignores axios.create (not zustand)', () => {
    const ctx = "import { createContext } from 'react';\nexport const AuthContext = createContext(null);";
    expect(functions('src/context/AuthContext.ts', ctx).map((f) => f.nodeId)).toContain('store:context:AuthContext');
    // axios.create resolves on `axios`, not zustand's bare create → no store node
    const ax = "import axios from 'axios';\nconst http = axios.create({ baseURL: '/api' });";
    expect(functions('src/lib/http.ts', ax).filter((f) => f.nodeId.startsWith('store:'))).toEqual([]);
  });
});

describe('fileParser.functions — Vuex store', () => {
  it('emits one action node per actions key', () => {
    const store = [
      'export const actions = {', //                 1
      '  async actionFacebookLogin({ commit }) {', // 2
      '    return commit("x");', //                   3
      '  },', //                                      4
      '  plain() {},', //                             5
      '};', //                                        6
    ].join('\n');
    const fns = functions('front/store/login.js', store);
    const ids = fns.map((f) => f.nodeId);
    expect(ids).toContain('store:vuex:login#actionFacebookLogin');
    expect(ids).toContain('store:vuex:login#plain');
    expect(fns.every((f) => f.kind === 'action')).toBe(true);
  });
});
