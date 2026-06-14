/** Project-root discovery: container vs single-app-dir, no source fragmentation. */
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { discoverProjectRoots } from '../src/resolver/projectScan';

const REPO = path.resolve(__dirname, '../../.repo');
const base = (dirs: string[]) => dirs.map((d) => path.basename(d)).sort();

describe('discoverProjectRoots', () => {
  it('treats a container repo as a set of project dirs', () => {
    const roots = discoverProjectRoots(REPO);
    expect(base(roots)).toContain('sample-shop-react');
    expect(base(roots)).toContain('shopflow-web');
    // every root is a top-level project dir, never an inner src/ subdir
    expect(roots.every((r) => path.dirname(r) === REPO)).toBe(true);
  });

  it('honors the project filter', () => {
    expect(base(discoverProjectRoots(REPO, 'sample-shop-react'))).toEqual(['sample-shop-react']);
  });

  it('treats a single app dir as ONE root (no src/components, src/pages split)', () => {
    const roots = discoverProjectRoots(path.join(REPO, 'sample-shop-react'));
    expect(roots).toEqual([path.join(REPO, 'sample-shop-react')]);
  });

  it('does not fragment shopflow-web into source subdirs', () => {
    const roots = discoverProjectRoots(path.join(REPO, 'shopflow-web'));
    expect(roots).toEqual([path.join(REPO, 'shopflow-web')]);
  });
});
