/**
 * React HTTP-pattern coverage: concise-arrow API wrappers, concise-arrow
 * component/hook bodies, and SWR read hooks. These are walked from a tiny
 * project written to a temp dir (no committed fixture needed).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphBuilder } from '../src/graphBuilder';
import { CallGraph } from '../src/model';
import { TsResolver } from '../src/resolver/irBuilder';

let dir: string;
let graph: CallGraph;

const file = (rel: string, body: string) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmap-react-patterns-'));
  file('package.json', JSON.stringify({ name: 'rp', dependencies: { react: '^18', axios: '^1', swr: '^2' } }));
  file('src/api/client.ts', `import axios from 'axios';\nexport const client = axios.create({ baseURL: 'https://api.test.com' });\n`);
  // concise-arrow API wrappers (the common style)
  file('src/api/orders.ts', `import { client } from './client';\nexport const getOrder = (id: string) => client.get(\`/orders/\${id}\`);\nexport const delOrder = (id: string) => client({ method: 'delete', url: \`/orders/\${id}\` });\n`);
  // SWR read hook, written as a concise-arrow hook
  file('src/hooks/useThing.ts', `import useSWR from 'swr';\nimport { client } from '../api/client';\nconst fetcher = (u: string) => client.get(u).then(r => r.data);\nexport const useThing = (id: string) => useSWR(\`/things/\${id}\`, fetcher);\n`);
  // RTK Query: createApi endpoints + generated hooks
  file('src/api/rtk.ts', `import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';\nexport const api = createApi({\n  baseQuery: fetchBaseQuery({ baseUrl: 'https://api.test.com' }),\n  endpoints: (b) => ({\n    getWidget: b.query({ query: (id: string) => \`/widgets/\${id}\` }),\n    addWidget: b.mutation({ query: (body: any) => ({ url: '/widgets', method: 'POST', body }) }),\n  }),\n});\nexport const { useGetWidgetQuery, useAddWidgetMutation } = api;\n`);
  // concise-arrow component body that IS a call/JSX
  file('src/pages/Home.tsx', `import { getOrder, delOrder } from '../api/orders';\nimport { useThing } from '../hooks/useThing';\nimport { useGetWidgetQuery, useAddWidgetMutation } from '../api/rtk';\nexport const Home = () => { useThing('1'); useGetWidgetQuery('1'); const [add] = useAddWidgetMutation(); return <button onClick={() => { getOrder('2'); delOrder('3'); add({}); }}>go</button>; };\n`);
  const files = new TsResolver().analyzeRoot(dir, dir, { repoRoot: dir, projectFilter: null, env: {} });
  graph = new GraphBuilder(files).build();
});

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const endpoints = () =>
  graph.nodes.filter((n) => n.layer === 'API' || n.layer === 'EXTERNAL').map((n) => `${n.httpMethod} ${n.endpoint}`);

describe('React HTTP-pattern coverage', () => {
  it('resolves a concise-arrow wrapper over an axios instance verb', () => {
    expect(endpoints()).toContain('GET /orders/{}');
  });

  it('resolves a concise-arrow wrapper using the axios config-object call form', () => {
    expect(endpoints()).toContain('DELETE /orders/{}');
  });

  it('resolves a useSWR(key, fetcher) read hook (key is the GET url)', () => {
    expect(endpoints()).toContain('GET /things/{}');
  });

  it('resolves RTK Query createApi endpoints via their generated hooks', () => {
    expect(endpoints()).toContain('GET /widgets/{}'); // useGetWidgetQuery (.query)
    expect(endpoints()).toContain('POST /widgets'); // useAddWidgetMutation (.mutation)
  });

  it('walks a concise-arrow component body (calls inside it are captured)', () => {
    // Home is a concise-arrow component; its handler calls must produce http edges.
    const http = graph.edges.filter((e) => e.relation === 'http');
    expect(http.length).toBeGreaterThanOrEqual(3);
  });
});
