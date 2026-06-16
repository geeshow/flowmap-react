/**
 * Unit tests for the PR-impact building blocks — the pure parsers ported from
 * the Spring analyzer (parseGitLog / parseDiff / toWebBase) and the standalone
 * blob symbol parser (fileParser.functions) that maps a revision's source to
 * graph node ids. These cover the contract `impact` depends on without needing a
 * git repo.
 */

import { describe, expect, it } from 'vitest';
import { parseGitLog, parseDiff, parseGhList, toWebBase } from '../src/impact/git';
import { functions } from '../src/impact/fileParser';

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

describe('toWebBase', () => {
  it('normalizes scp/ssh/https remotes and strips creds + .git', () => {
    expect(toWebBase('git@github.com:owner/repo.git')).toBe('https://github.com/owner/repo');
    expect(toWebBase('ssh://git@github.com/owner/repo.git')).toBe('https://github.com/owner/repo');
    expect(toWebBase('https://user:token@github.com/owner/repo.git')).toBe('https://github.com/owner/repo');
    expect(toWebBase('ftp://nope')).toBeNull();
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
