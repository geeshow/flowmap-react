/**
 * Coverage for the React-round gap fixes: useSWRMutation, Jotai/Recoil stores,
 * HOC default export, React.lazy+Suspense route elements, dynamic-verb axios,
 * graphql-request, react-router `lazy: () => import()` module form, and
 * fetch(new Request).
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmap-react-round-'));
  file(
    'package.json',
    JSON.stringify({
      dependencies: {
        react: '^18',
        'react-router-dom': '^6',
        axios: '^1',
        swr: '^2',
        jotai: '^2',
        recoil: '^0.7',
        'graphql-request': '^7',
      },
    }),
  );

  // SWR mutation: key is the URL, fetcher posts → POST /api/users
  file('src/api/users.ts', `import axios from 'axios';\nexport const createUser = (url: string, { arg }: { arg: any }) => axios.post(url, arg);\n`);

  // graphql-request: bare request + GraphQLClient.request
  file('src/api/gql.ts', `import { request, gql, GraphQLClient } from 'graphql-request';\nconst client = new GraphQLClient('https://gql.example.com/graphql');\nexport const listViaFn = () => request('https://gql.example.com/graphql', gql\`{ users { id } }\`);\nexport const listViaClient = () => client.request(gql\`{ items { id } }\`);\n`);

  // dynamic-verb axios + fetch(new Request)
  file('src/api/misc.ts', `import axios from 'axios';\nexport const dyn = (method: string) => axios[method]('/dynamic-endpoint');\nexport const reqObj = () => fetch(new Request('/request-endpoint', { method: 'POST' }), { body: '{}' });\n`);

  // Jotai store + page using it
  file('src/store/jotai.ts', `import { atom } from 'jotai';\nexport const counterAtom = atom(0);\n`);
  file(
    'src/pages/JotaiPage.tsx',
    `import { useAtom } from 'jotai';\nimport useSWRMutation from 'swr/mutation';\nimport { counterAtom } from '../store/jotai';\nimport { createUser } from '../api/users';\nimport { dyn, reqObj } from '../api/misc';\nimport { listViaFn, listViaClient } from '../api/gql';\nexport default function JotaiPage() {\n  const [count, setCount] = useAtom(counterAtom);\n  const { trigger } = useSWRMutation('/api/users', createUser);\n  return <button onClick={() => { trigger({}); dyn('put'); reqObj(); listViaFn(); listViaClient(); setCount(count + 1); }}>{count}</button>;\n}\n`,
  );

  // Recoil store + page using it
  file('src/store/recoil.ts', `import { atom } from 'recoil';\nexport const todoListState = atom<string[]>({ key: 'todoListState', default: [] });\n`);
  file(
    'src/pages/RecoilPage.tsx',
    `import { useRecoilState } from 'recoil';\nimport { todoListState } from '../store/recoil';\nexport default function RecoilPage() {\n  const [todos] = useRecoilState(todoListState);\n  return <div>{todos.length}</div>;\n}\n`,
  );

  // HOC default export
  file(
    'src/pages/DashboardPage.tsx',
    `import axios from 'axios';\nfunction withAuth<T>(C: T): T { return C; }\nfunction DashboardPage() { axios.get('/api/dashboard'); return <div/>; }\nexport default withAuth(DashboardPage);\n`,
  );

  // React.lazy + Suspense
  file('src/pages/ProfilePage.tsx', `export default function ProfilePage() { return <div/>; }\n`);

  // react-router lazy module form: exports a named Component
  file('src/pages/SettingsScreen.tsx', `import axios from 'axios';\nexport function Component() { axios.get('/api/settings'); return <div/>; }\n`);

  file(
    'src/main.tsx',
    `import { createBrowserRouter } from 'react-router-dom';\nimport React, { Suspense, lazy } from 'react';\nimport JotaiPage from './pages/JotaiPage';\nimport RecoilPage from './pages/RecoilPage';\nimport DashboardPage from './pages/DashboardPage';\nconst ProfilePage = lazy(() => import('./pages/ProfilePage'));\nexport const router = createBrowserRouter([\n  { path: '/jotai', element: <JotaiPage /> },\n  { path: '/recoil', element: <RecoilPage /> },\n  { path: '/dashboard', element: <DashboardPage /> },\n  { path: '/profile', element: <Suspense fallback={<div/>}><ProfilePage /></Suspense> },\n  { path: '/settings', lazy: () => import('./pages/SettingsScreen') },\n]);\n`,
  );

  const files = new TsResolver().analyzeRoot(dir, dir, { repoRoot: dir, projectFilter: null, env: {}, envProfile: null });
  graph = new GraphBuilder(files).build();
});
afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const eps = () => graph.nodes.filter((n) => n.layer === 'API' || n.layer === 'EXTERNAL').map((n) => `${n.httpMethod} ${n.endpoint}`);
const screens = () => graph.nodes.filter((n) => n.layer === 'SCREEN');
const screenEndpoints = () => screens().map((n) => n.endpoint);
const storeIds = () => graph.nodes.filter((n) => n.layer === 'STORE').map((n) => n.id);
const edgeRels = (rel: string) => graph.edges.filter((e) => e.relation === rel);

describe('react-round gap fixes', () => {
  it('resolves useSWRMutation key + fetcher verb (POST)', () => {
    expect(eps()).toContain('POST /api/users');
  });

  it('models Jotai atom as a STORE with a store:read edge', () => {
    expect(storeIds()).toContain('store:jotai:counterAtom');
    expect(edgeRels('store:read').some((e) => e.target === 'store:jotai:counterAtom')).toBe(true);
  });

  it('models Recoil atom as a STORE with a store:read edge', () => {
    expect(storeIds()).toContain('store:recoil:todoListState');
    expect(edgeRels('store:read').some((e) => e.target === 'store:recoil:todoListState')).toBe(true);
  });

  it('resolves a HOC default export to a SCREEN with the route endpoint', () => {
    expect(screenEndpoints()).toContain('/dashboard');
    expect(screens().some((n) => n.id.endsWith('DashboardPage.tsx::DashboardPage'))).toBe(true);
  });

  it('descends through <Suspense> to mark the lazy screen', () => {
    expect(screenEndpoints()).toContain('/profile');
  });

  it('resolves react-router lazy: () => import() module form to a SCREEN', () => {
    expect(screenEndpoints()).toContain('/settings');
    expect(screens().some((n) => n.id.endsWith('SettingsScreen.tsx::Component'))).toBe(true);
  });

  it('emits dynamic-verb axios[method](url) as an endpoint', () => {
    expect(eps().some((s) => s.endsWith('/dynamic-endpoint'))).toBe(true);
  });

  it('resolves graphql-request request() and GraphQLClient.request() as POST endpoints', () => {
    expect(eps()).toContain('POST /graphql');
  });

  it('reads the verb from fetch(new Request(url, { method }))', () => {
    expect(eps()).toContain('POST /request-endpoint');
  });
});
