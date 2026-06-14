/**
 * Coverage for the post-round verification fixes:
 *  - Zustand async store actions (`fetchUser: async () => axios.get(...)`) become
 *    walkable STORE-action nodes, so store → action → API edges form.
 *  - Dynamic component render `arr.map((it) => <it.Comp/>)` emits render edges to
 *    each array element's component.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphBuilder } from '../src/graphBuilder';
import { CallGraph } from '../src/model';
import { TsResolver } from '../src/resolver/irBuilder';

function analyze(setup: (file: (rel: string, body: string) => void) => void): { dir: string; graph: CallGraph } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmap-rr4-'));
  const file = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  setup(file);
  const files = new TsResolver().analyzeRoot(dir, dir, { repoRoot: dir, projectFilter: null, env: {}, envProfile: null });
  return { dir, graph: new GraphBuilder(files).build() };
}

describe('Zustand async store action', () => {
  let dir: string;
  let graph: CallGraph;
  beforeAll(() => {
    ({ dir, graph } = analyze((file) => {
      file('package.json', JSON.stringify({ dependencies: { react: '^18', 'react-router-dom': '^6', axios: '^1', zustand: '^4' } }));
      file('src/store.ts', `import { create } from 'zustand';\nimport axios from 'axios';\nexport const useUserStore = create((set) => ({\n  user: null,\n  fetchUser: async (id) => { const r = await axios.get('/api/users/' + id); set({ user: r.data }); },\n}));\n`);
      file('src/Page.tsx', `import { useUserStore } from './store';\nexport default function Page() {\n  const fetchUser = useUserStore((s) => s.fetchUser);\n  return <button onClick={() => fetchUser(1)}>load</button>;\n}\n`);
      file('src/main.tsx', `import { createBrowserRouter } from 'react-router-dom';\nimport Page from './Page';\nexport const router = createBrowserRouter([{ path: '/u', element: <Page /> }]);\n`);
    }));
  });
  afterAll(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('makes the action a walkable STORE-action node linked to the container', () => {
    expect(graph.nodes.some((n) => n.id === 'store:zustand:useUserStore#fetchUser')).toBe(true);
    expect(
      graph.edges.some(
        (e) => e.source === 'store:zustand:useUserStore' && e.target === 'store:zustand:useUserStore#fetchUser' && e.relation === 'store:action',
      ),
    ).toBe(true);
  });
  it('captures the action HTTP call', () => {
    expect(
      graph.edges.some(
        (e) => e.source === 'store:zustand:useUserStore#fetchUser' && e.relation === 'http' && (e.target as string).startsWith('ext:GET /api/users'),
      ),
    ).toBe(true);
  });
});

describe('dynamic component render via map', () => {
  let dir: string;
  let graph: CallGraph;
  beforeAll(() => {
    ({ dir, graph } = analyze((file) => {
      file('package.json', JSON.stringify({ dependencies: { react: '^18', 'react-router-dom': '^6', axios: '^1' } }));
      file('src/widgets.tsx', `import axios from 'axios';\nexport function Chart() { axios.get('/api/chart'); return <div/>; }\nexport function Table() { axios.get('/api/table'); return <div/>; }\n`);
      file('src/Dash.tsx', `import { Chart } from './widgets';\nimport { Table } from './widgets';\nconst items = [{ Comp: Chart }, { Comp: Table }];\nexport default function Dash() {\n  return <div>{items.map((it, i) => <it.Comp key={i} />)}</div>;\n}\n`);
      file('src/main.tsx', `import { createBrowserRouter } from 'react-router-dom';\nimport Dash from './Dash';\nexport const router = createBrowserRouter([{ path: '/d', element: <Dash /> }]);\n`);
    }));
  });
  afterAll(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('emits render edges to each mapped component', () => {
    const renders = graph.edges.filter((e) => e.relation === 'render' && e.source.endsWith('Dash.tsx::Dash')).map((e) => e.target);
    expect(renders).toEqual(expect.arrayContaining(['src/widgets.tsx::Chart', 'src/widgets.tsx::Table']));
  });
});
