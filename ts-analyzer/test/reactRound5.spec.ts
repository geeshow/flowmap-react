/**
 * Round 2 coverage: GraphQL clients (Apollo/urql), realtime (WebSocket/SSE/socket.io),
 * advanced routers (TanStack, nested index routes), and composition (compound
 * components, variable/ternary tags, observer-wrapped components).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphBuilder } from '../src/graphBuilder';
import { CallGraph } from '../src/model';
import { TsResolver } from '../src/resolver/irBuilder';

function analyze(setup: (file: (rel: string, body: string) => void) => void): { dir: string; graph: CallGraph } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmap-rr5-'));
  const file = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  setup(file);
  const files = new TsResolver().analyzeRoot(dir, dir, { repoRoot: dir, projectFilter: null, env: {}, envProfile: null });
  return { dir, graph: new GraphBuilder(files).build() };
}
const cleanup = (dir: string) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

describe('GraphQL clients (Apollo + urql)', () => {
  let dir: string;
  let graph: CallGraph;
  beforeAll(() => {
    ({ dir, graph } = analyze((file) => {
      file('package.json', JSON.stringify({ dependencies: { react: '^18', 'react-router-dom': '^6', '@apollo/client': '^3', urql: '^4', graphql: '^16' } }));
      file('src/apollo.ts', `import { ApolloClient, InMemoryCache } from '@apollo/client';\nexport const client = new ApolloClient({ uri: 'https://api.example.com/graphql', cache: new InMemoryCache() });\n`);
      file('src/urql.ts', `import { createClient, cacheExchange, fetchExchange } from 'urql';\nexport const urqlClient = createClient({ url: 'https://gql.example.com/graphql', exchanges: [cacheExchange, fetchExchange] });\n`);
      file('src/queries.ts', `import { gql } from '@apollo/client';\nexport const GET_USERS = gql\`query { users { id } }\`;\nexport const ADD_USER = gql\`mutation { addUser { id } }\`;\n`);
      file('src/pages/ApolloPage.tsx', `import { useQuery, useMutation, useLazyQuery } from '@apollo/client';\nimport { client } from '../apollo';\nimport { GET_USERS, ADD_USER } from '../queries';\nexport default function ApolloPage() {\n  useQuery(GET_USERS);\n  const [addUser] = useMutation(ADD_USER);\n  const [load] = useLazyQuery(GET_USERS);\n  return <button onClick={() => { addUser(); load(); client.query({ query: GET_USERS }); }}>x</button>;\n}\n`);
      file('src/pages/UrqlPage.tsx', `import { useQuery } from 'urql';\nimport { GET_USERS } from '../queries';\nexport default function UrqlPage() { const [r] = useQuery({ query: GET_USERS }); return <div>{String(r)}</div>; }\n`);
      file('src/main.tsx', `import { createBrowserRouter } from 'react-router-dom';\nimport ApolloPage from './pages/ApolloPage';\nimport UrqlPage from './pages/UrqlPage';\nexport const router = createBrowserRouter([\n  { path: '/apollo', element: <ApolloPage /> },\n  { path: '/urql', element: <UrqlPage /> },\n]);\n`);
    }));
  });
  afterAll(() => cleanup(dir));
  const edge = (from: string, to: string) => graph.edges.some((e) => e.source.endsWith(from) && e.target === to && e.relation === 'http');

  it('resolves Apollo hooks + imperative client.query to the ApolloClient uri', () => {
    expect(edge('ApolloPage', 'ext:POST api.example.com/graphql')).toBe(true);
  });
  it('resolves urql useQuery to the createClient url', () => {
    expect(edge('UrqlPage', 'ext:POST gql.example.com/graphql')).toBe(true);
  });
});

describe('realtime (WebSocket / SSE / socket.io)', () => {
  let dir: string;
  let graph: CallGraph;
  beforeAll(() => {
    ({ dir, graph } = analyze((file) => {
      file('package.json', JSON.stringify({ dependencies: { react: '^18', 'react-router-dom': '^6', 'socket.io-client': '^4' } }));
      file('src/hooks/useWebSocket.ts', `import { useEffect } from 'react';\nexport function useWebSocket() { useEffect(() => { const ws = new WebSocket('wss://api.example.com/ws'); return () => ws.close(); }, []); }\n`);
      file('src/hooks/useSSE.ts', `import { useEffect } from 'react';\nexport function useSSE() { useEffect(() => { const es = new EventSource('/api/stream'); return () => es.close(); }, []); }\n`);
      file('src/hooks/useSock.ts', `import { useEffect } from 'react';\nimport { io } from 'socket.io-client';\nexport function useSock() { useEffect(() => { const s = io('https://rt.example.com'); s.on('x', () => {}); }, []); }\n`);
      file('src/pages/Live.tsx', `import { useWebSocket } from '../hooks/useWebSocket';\nimport { useSSE } from '../hooks/useSSE';\nimport { useSock } from '../hooks/useSock';\nexport default function Live() { useWebSocket(); useSSE(); useSock(); return <div/>; }\n`);
      file('src/main.tsx', `import { createBrowserRouter } from 'react-router-dom';\nimport Live from './pages/Live';\nexport const router = createBrowserRouter([{ path: '/live', element: <Live /> }]);\n`);
    }));
  });
  afterAll(() => cleanup(dir));
  const httpEdge = (from: string, target: string) => graph.edges.some((e) => e.source.endsWith(from) && e.target === target && e.relation === 'http');

  it('captures new WebSocket(url)', () => {
    expect(httpEdge('useWebSocket', 'ext:ANY api.example.com/ws')).toBe(true);
  });
  it('captures new EventSource(url) as a GET', () => {
    expect(httpEdge('useSSE', 'ext:GET /api/stream')).toBe(true);
  });
  it('captures socket.io io(url)', () => {
    expect(httpEdge('useSock', 'ext:ANY rt.example.com/')).toBe(true);
  });
});

describe('advanced routers + composition', () => {
  let dir: string;
  let graph: CallGraph;
  beforeAll(() => {
    ({ dir, graph } = analyze((file) => {
      file('package.json', JSON.stringify({ dependencies: { react: '^18', 'react-router-dom': '^6', '@tanstack/react-router': '^1', axios: '^1', 'mobx-react-lite': '^4' } }));
      // nested index route
      file('src/pages/SettingsLayout.tsx', `import { Outlet } from 'react-router-dom';\nexport function SettingsLayout() { return <div><Outlet/></div>; }\n`);
      file('src/pages/SettingsIndex.tsx', `export function SettingsIndex() { return <div/>; }\n`);
      file('src/pages/SettingsProfile.tsx', `export function SettingsProfile() { return <div/>; }\n`);
      // compound + variable tag
      file('src/pages/Tabs.tsx', `function TabsRoot(p: any) { return <div>{p.children}</div>; }\nfunction Panel(p: any) { return <section>{p.children}</section>; }\nexport const Tabs = Object.assign(TabsRoot, { Panel });\n`);
      file('src/pages/Leaf.tsx', `export function VariantA() { return <div/>; }\nexport function VariantB() { return <div/>; }\n`);
      file('src/pages/Dyn.tsx', `import { Tabs } from './Tabs';\nimport { VariantA, VariantB } from './Leaf';\nexport default function Dyn({ flag }: { flag: boolean }) {\n  const El = flag ? VariantA : VariantB;\n  return <Tabs><Tabs.Panel/><El/></Tabs>;\n}\n`);
      // observer-wrapped component
      file('src/pages/Mobx.tsx', `import { observer } from 'mobx-react-lite';\nimport axios from 'axios';\nexport const MobxPage = observer(() => { axios.get('/api/mobx'); return <div/>; });\n`);
      // TanStack file route
      file('app/orders.tsx', `import { createFileRoute } from '@tanstack/react-router';\nfunction OrdersPage() { return <div/>; }\nexport const Route = createFileRoute('/orders')({ component: OrdersPage, loader: async () => fetch('/api/orders') });\n`);
      file('src/main.tsx', `import { createBrowserRouter } from 'react-router-dom';\nimport { SettingsLayout } from './pages/SettingsLayout';\nimport { SettingsIndex } from './pages/SettingsIndex';\nimport { SettingsProfile } from './pages/SettingsProfile';\nimport Dyn from './pages/Dyn';\nimport { MobxPage } from './pages/Mobx';\nexport const router = createBrowserRouter([\n  { path: '/settings', Component: SettingsLayout, children: [\n    { index: true, Component: SettingsIndex },\n    { path: 'profile', Component: SettingsProfile },\n  ]},\n  { path: '/dyn', element: <Dyn flag /> },\n  { path: '/mobx', element: <MobxPage /> },\n]);\n`);
    }));
  });
  afterAll(() => cleanup(dir));
  const screenEp = () => graph.nodes.filter((n) => n.layer === 'SCREEN').map((n) => n.endpoint);
  const renderTo = (from: string) => graph.edges.filter((e) => e.relation === 'render' && e.source.endsWith(from)).map((e) => e.target.split('::')[1]);

  it('joins nested + index route paths', () => {
    expect(screenEp()).toEqual(expect.arrayContaining(['/settings', '/settings/profile']));
  });
  it('resolves compound member <Tabs.Panel/> and variable/ternary <El/> tags', () => {
    const r = renderTo('Dyn.tsx::Dyn');
    expect(r).toEqual(expect.arrayContaining(['Panel', 'VariantA', 'VariantB']));
  });
  it('discovers an observer()-wrapped component (screen + its fetch)', () => {
    expect(screenEp()).toContain('/mobx');
    expect(graph.edges.some((e) => e.source.endsWith('MobxPage') && e.target === 'ext:GET /api/mobx')).toBe(true);
  });
  it('resolves a TanStack createFileRoute screen + loader fetch', () => {
    expect(screenEp()).toContain('/orders');
    expect(graph.edges.some((e) => e.source.endsWith('OrdersPage') && e.target === 'ext:GET /api/orders')).toBe(true);
  });
});
