/**
 * Pure IR → graph tests: node layering (SCREEN/COMPONENT/HOOK/STORE/API),
 * render/call/http/store edges, route→screen endpoint, and edge dedup.
 */
import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../src/graphBuilder';
import type { IrComponent, IrFile } from '../src/ir';

function comp(id: string, name: string, over: Partial<IrComponent> = {}): IrComponent {
  return { id, name, kind: 'component', exported: true, isAsync: false, line: 1, jsxUsages: [], calls: [], ...over };
}

function file(path: string, over: Partial<IrFile> = {}): IrFile {
  return { path, project: 'app', module: null, language: 'tsx', components: [], routes: [], stores: [], ...over };
}

describe('GraphBuilder', () => {
  it('marks routed components as SCREEN with normalized endpoint', () => {
    const page = comp('f.tsx::UserPage', 'UserPage');
    const f = file('f.tsx', {
      components: [page],
      routes: [{ routePath: '/users/:id', screenComponentId: page.id, lazy: false, source: 'react-router', line: 1 }],
    });
    const g = new GraphBuilder([f]).build();
    const node = g.nodes.find((n) => n.id === page.id)!;
    expect(node.layer).toBe('SCREEN');
    expect(node.endpoint).toBe('/users/{}');
  });

  it('emits render, call, http and store edges', () => {
    const child = comp('c.tsx::Card', 'Card');
    const hook = comp('h.tsx::useX', 'useX', { kind: 'hook' });
    const page = comp('p.tsx::Page', 'Page', {
      jsxUsages: [{ tagName: 'Card', targetComponentId: child.id, lazy: false, line: 5 }],
      calls: [
        { line: 6, inAsyncCtx: false, resolution: { kind: 'internal', calleeComponentId: hook.id, calleeName: 'useX', calleeIsAsync: false } },
        {
          line: 7,
          inAsyncCtx: true,
          resolution: {
            kind: 'api',
            httpMethod: 'GET',
            url: 'https://api/x',
            endpoint: '/x',
            urlPlaceholder: null,
            service: 'api',
            clientPackage: null,
            confidence: 'resolved',
            wrapperChain: [],
          },
        },
        { line: 8, inAsyncCtx: false, resolution: { kind: 'storeRead', storeId: 'store:redux:user', selector: 'user' } },
      ],
    });
    const f = file('p.tsx', {
      components: [page, child, hook],
      stores: [{ storeId: 'store:redux:user', name: 'user', kind: 'redux-slice', actions: ['set'], line: 1 }],
    });
    const g = new GraphBuilder([f]).build();
    const rels = g.edges.map((e) => `${e.relation}:${e.mode}`).sort();
    expect(rels).toEqual(['call:sync', 'http:async', 'render:sync', 'store:read:sync']);

    const api = g.nodes.find((n) => n.layer === 'API' || n.layer === 'EXTERNAL')!;
    expect(api.endpoint).toBe('/x');
    expect(g.nodes.find((n) => n.id === 'store:redux:user')!.layer).toBe('STORE');
    expect(g.nodes.find((n) => n.id === hook.id)!.layer).toBe('HOOK');
  });

  it('dedups identical edges', () => {
    const child = comp('c.tsx::Card', 'Card');
    const page = comp('p.tsx::Page', 'Page', {
      jsxUsages: [
        { tagName: 'Card', targetComponentId: child.id, lazy: false, line: 5 },
        { tagName: 'Card', targetComponentId: child.id, lazy: false, line: 5 },
      ],
    });
    const g = new GraphBuilder([file('p.tsx', { components: [page, child] })]).build();
    expect(g.edges.filter((e) => e.relation === 'render')).toHaveLength(1);
  });
});
