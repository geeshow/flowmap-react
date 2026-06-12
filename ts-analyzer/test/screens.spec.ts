/**
 * Screen layout extraction on the real fixture: screens carry their route,
 * components carry a JSX layout tree, child components are linked by id, and
 * host elements / props / conditionals are captured structurally.
 */
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { buildScreens, LayoutNode } from '../src/screens';

const REPO = path.resolve(__dirname, '../../.repo');

function flatten(n: LayoutNode | null): LayoutNode[] {
  if (!n) return [];
  return [n, ...(n.children ?? []).flatMap(flatten)];
}

describe('buildScreens on sample-shop-react', () => {
  const doc = buildScreens({ repoRoot: REPO, projectFilter: 'sample-shop-react' });

  it('lists routed screens with normalized paths', () => {
    const byName = Object.fromEntries(doc.screens.map((s) => [s.name, s.route]));
    expect(byName['UserPage']).toBe('/users/{}');
    expect(byName['OrdersPage']).toBe('/orders');
    expect(byName['ReportPage']).toBe('/report');
  });

  it('gives each screen a layout tree referencing child components by id', () => {
    const userPage = doc.screens.find((s) => s.name === 'UserPage')!;
    const root = doc.components[userPage.id].root;
    const comps = flatten(root).filter((n) => n.kind === 'component');
    expect(comps.some((c) => c.componentId?.endsWith('UserCard'))).toBe(true);
    // the linked child must itself be in the components map (drill-down works)
    const cardId = comps.find((c) => c.componentId?.endsWith('UserCard'))!.componentId!;
    expect(doc.components[cardId]).toBeTruthy();
  });

  it('captures host elements, whitelisted props, text and conditionals', () => {
    const cardId = Object.keys(doc.components).find((k) => k.endsWith('UserCard'))!;
    const nodes = flatten(doc.components[cardId].root);
    const div = nodes.find((n) => n.tag === 'div');
    expect(div?.kind).toBe('host');
    expect(div?.props?.className).toBe('user-card');
    expect(nodes.some((n) => n.kind === 'text')).toBe(true);
    expect(nodes.some((n) => n.kind === 'conditional')).toBe(true);
  });
});
