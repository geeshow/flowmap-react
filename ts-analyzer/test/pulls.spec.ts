/**
 * Per-PR file-diff parsing: `git show`/`git diff -M` → PrFile[] (parseShow) and the
 * REST `pulls/{n}/files` JSON → PrFile[] (parseFiles). Pure-function coverage; the
 * full writePulls flow is exercised by a real `impact --git` run.
 */
import { describe, expect, it } from 'vitest';
import { parseShow, parseFiles } from '../src/impact/git';

describe('parseShow (git unified diff → PrFile[])', () => {
  it('parses status, +/- counts, and the full patch', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 111..222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,3 +1,4 @@',
      ' ctx',
      '-old line',
      '+new line 1',
      '+new line 2',
      ' tail',
    ].join('\n');
    const files = parseShow(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/app.ts');
    expect(files[0].status).toBe('modified');
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
    expect(files[0].changes).toBe(3);
    expect(files[0].patch).toContain('@@ -1,3 +1,4 @@');
    expect(files[0].patch).toContain('+new line 1');
  });

  it('detects added / removed / renamed files', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,1 @@',
      '+hello',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-bye',
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 100%',
      'rename from old/name.ts',
      'rename to new/name.ts',
    ].join('\n');
    const byPath = Object.fromEntries(parseShow(diff).map((f) => [f.path, f]));
    expect(byPath['new.ts'].status).toBe('added');
    expect(byPath['gone.ts'].status).toBe('removed');
    expect(byPath['new/name.ts'].status).toBe('renamed');
    expect(byPath['new/name.ts'].previousPath).toBe('old/name.ts');
  });

  it('returns [] for an empty diff', () => {
    expect(parseShow('')).toEqual([]);
  });
});

describe('parseFiles (gh REST pulls/{n}/files JSON → PrFile[])', () => {
  it('maps filename/status/counts/patch and previous_filename', () => {
    const json = JSON.stringify([
      { filename: 'a.ts', status: 'modified', additions: 3, deletions: 1, changes: 4, patch: '@@ ... @@' },
      { filename: 'b/new.ts', status: 'renamed', additions: 0, deletions: 0, changes: 0, previous_filename: 'b/old.ts' },
      { status: 'modified' }, // no filename → skipped
    ]);
    const files = parseFiles(json);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: 'a.ts', status: 'modified', additions: 3, deletions: 1, changes: 4, patch: '@@ ... @@', previousPath: null });
    expect(files[1]).toMatchObject({ path: 'b/new.ts', status: 'renamed', previousPath: 'b/old.ts' });
  });

  it('returns [] for non-array / invalid JSON', () => {
    expect(parseFiles('{}')).toEqual([]);
    expect(parseFiles('not json')).toEqual([]);
  });
});
