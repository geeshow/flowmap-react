/**
 * Coverage for the three deferred react-round gaps, now fixed:
 *  - route-factory `route('/path', Component)` array elements
 *  - url-parameterized custom hook `useApi(url)` inferred from call sites
 *  - Next.js route handlers (app/**​/route.ts) as provider endpoints linked to consumers
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphBuilder } from '../src/graphBuilder';
import { CallGraph } from '../src/model';
import { TsResolver } from '../src/resolver/irBuilder';

function analyze(setup: (file: (rel: string, body: string) => void) => void): { dir: string; graph: CallGraph } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmap-rr2-'));
  const file = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  setup(file);
  const files = new TsResolver().analyzeRoot(dir, dir, { repoRoot: dir, projectFilter: null, env: {}, envProfile: null });
  return { dir, graph: new GraphBuilder(files).build() };
}

describe('route-factory + url-param hook (react-router)', () => {
  let dir: string;
  let graph: CallGraph;
  beforeAll(() => {
    ({ dir, graph } = analyze((file) => {
      file('package.json', JSON.stringify({ dependencies: { react: '^18', 'react-router-dom': '^6', axios: '^1', '@tanstack/react-query': '^5' } }));
      file('src/api.ts', `import axios from 'axios';\nimport { useQuery } from '@tanstack/react-query';\nexport function useApi<T>(url: string) {\n  return useQuery({ queryKey: [url], queryFn: () => axios.get<T>(url).then((r) => r.data) });\n}\n`);
      file('src/pages/Reports.tsx', `import { useApi } from '../api';\nexport function Reports() { useApi<any>('/api/reports'); return <div/>; }\n`);
      file('src/pages/Dashboard.tsx', `import axios from 'axios';\nexport function Dashboard() { axios.get('/api/dashboard'); return <div/>; }\n`);
      file('src/main.tsx', `import { createBrowserRouter } from 'react-router-dom';\nimport { Reports } from './pages/Reports';\nimport { Dashboard } from './pages/Dashboard';\nfunction route(path: string, Component: any) { return { path, Component }; }\nfunction routeEl(path: string, Component: any) { return { path, element: <Component /> }; }\nexport const router = createBrowserRouter([\n  route('/reports', Reports),\n  routeEl('/dashboard', Dashboard),\n]);\n`);
    }));
  });
  afterAll(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const screenEndpoints = () => graph.nodes.filter((n) => n.layer === 'SCREEN').map((n) => n.endpoint);
  const eps = () => graph.nodes.filter((n) => n.layer === 'API' || n.layer === 'EXTERNAL').map((n) => `${n.httpMethod} ${n.endpoint}`);

  it('promotes a route-factory `{ path, Component }` element to a SCREEN', () => {
    expect(screenEndpoints()).toContain('/reports');
  });
  it('promotes a route-factory `{ path, element: <C/> }` element to a SCREEN', () => {
    expect(screenEndpoints()).toContain('/dashboard');
  });
  it('infers a url-param custom hook endpoint from its call site', () => {
    expect(eps()).toContain('GET /api/reports');
    const node = graph.nodes.find((n) => n.endpoint === '/api/reports');
    expect(node?.confidence).toBe('resolved');
  });
});

describe('Next.js route handlers as provider endpoints', () => {
  let dir: string;
  let graph: CallGraph;
  beforeAll(() => {
    ({ dir, graph } = analyze((file) => {
      file('package.json', JSON.stringify({ dependencies: { next: '^14', react: '^18' } }));
      file('next.config.js', `module.exports = {};\n`);
      file('src/app/api/foo/route.ts', `export async function GET() { const r = await fetch('https://upstream.example.com/items'); return Response.json(await r.json()); }\nexport async function POST(req: Request) { await fetch('https://upstream.example.com/items', { method: 'POST' }); return Response.json({}); }\n`);
      file('src/app/dashboard/page.tsx', `'use client';\nexport default function DashboardPage() {\n  const load = async () => { await fetch('/api/foo'); await fetch('/api/foo', { method: 'POST' }); };\n  return <button onClick={load}>go</button>;\n}\n`);
    }));
  });
  afterAll(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const hasEdge = (src: (s: string) => boolean, tgt: string, rel: string) =>
    graph.edges.some((e) => src(e.source) && e.target === tgt && e.relation === rel);

  it('models route.ts GET/POST exports as API provider nodes (not COMPONENT)', () => {
    const get = graph.nodes.find((n) => n.id === 'ext:GET /api/foo');
    const post = graph.nodes.find((n) => n.id === 'ext:POST /api/foo');
    expect(get?.layer).toBe('API');
    expect(post?.layer).toBe('API');
    expect(graph.nodes.some((n) => n.layer === 'COMPONENT' && /route\.ts::(GET|POST)/.test(n.id))).toBe(false);
  });
  it('links the consumer fetch to the in-repo handler (consumer → /api/foo)', () => {
    expect(hasEdge((s) => s.endsWith('DashboardPage'), 'ext:GET /api/foo', 'http')).toBe(true);
    expect(hasEdge((s) => s.endsWith('DashboardPage'), 'ext:POST /api/foo', 'http')).toBe(true);
  });
  it('captures the handler upstream call (handler → upstream)', () => {
    expect(hasEdge((s) => s === 'ext:GET /api/foo', 'ext:GET upstream.example.com/items', 'http')).toBe(true);
    expect(hasEdge((s) => s === 'ext:POST /api/foo', 'ext:POST upstream.example.com/items', 'http')).toBe(true);
  });
});
