/**
 * Coverage for the gap-probe round fixes: ky/got/superagent clients, service-class
 * axios, env alias/destructure, new URL(path,base), String.replace param, RTK
 * injectEndpoints, imported routes array, and react-router loader/action.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmap-react-gaps-'));
  file('package.json', JSON.stringify({ dependencies: { react: '^18', axios: '^1', ky: '^1', got: '^14', superagent: '^9', '@reduxjs/toolkit': '^2', 'react-router-dom': '^6' } }));
  file('.env-cmdrc.json', JSON.stringify({ sandbox: { VITE_GW: 'https://gw.example.com' } }));

  file('src/clients.ts', `import ky from 'ky';\nimport got from 'got';\nimport request from 'superagent';\nexport const kyOrders = () => ky.post('https://ky.example.com/orders', { json: {} });\nexport const gotItems = () => got.get('https://got.example.com/items');\nexport const saItems = () => request.post('https://sa.example.com/items').send({});\n`);

  file('src/service.ts', `import axios from 'axios';\nclass Api { private http = axios.create({ baseURL: 'https://svc.example.com' }); products() { return this.http.get('/products'); } }\nexport const api = new Api();\n`);

  file('src/env.ts', `const E = import.meta.env; export const GW1 = E.VITE_GW;\nconst { VITE_GW } = import.meta.env; export const GW2 = VITE_GW;\n`);
  file('src/urls.ts', `import axios from 'axios';\nimport { GW1, GW2 } from './env';\nexport const aliased = () => axios.get(\`\${GW1}/aliased\`);\nexport const destructured = () => axios.get(\`\${GW2}/destructured\`);\nexport const viaUrl = () => axios.get(new URL('/v1/url', GW1).toString());\nexport const viaReplace = (id: string) => axios.get(\`\${GW1}\${'/items/:id'.replace(':id', id)}\`);\n`);

  file('src/rtk.ts', `import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';\nexport const baseApi = createApi({ baseQuery: fetchBaseQuery({ baseUrl: 'https://gw.example.com' }), endpoints: () => ({}) });\nexport const ext = baseApi.injectEndpoints({ endpoints: (b) => ({ getInj: b.query({ query: () => '/rtk/inj' }), addInj: b.mutation({ query: (x) => ({ url: '/rtk/inj', method: 'POST', body: x }) }) }) });\nexport const { useGetInjQuery, useAddInjMutation } = ext;\n`);

  file('src/pages/Dash.tsx', `import { kyOrders, gotItems, saItems } from '../clients';\nimport { api } from '../service';\nimport { aliased, destructured, viaUrl, viaReplace } from '../urls';\nimport { useGetInjQuery, useAddInjMutation } from '../rtk';\nexport const Dash = () => { useGetInjQuery(); const [add] = useAddInjMutation(); return <button onClick={() => { add({}); kyOrders(); gotItems(); saItems(); api.products(); aliased(); destructured(); viaUrl(); viaReplace('1'); }}>x</button>; };\n`);
  file('src/pages/Detail.tsx', `export const Detail = () => <div/>;\n`);

  file('src/routes.tsx', `import { Dash } from './pages/Dash';\nimport { Detail } from './pages/Detail';\nimport { client } from './loaderClient';\nexport const routes = [\n  { path: '/dash', element: <Dash /> },\n  { path: '/detail', element: <Detail />, loader: () => client.get('/detail-data') },\n];\n`);
  file('src/loaderClient.ts', `import axios from 'axios';\nexport const client = axios.create({ baseURL: 'https://gw.example.com' });\n`);
  file('src/main.tsx', `import { createBrowserRouter } from 'react-router-dom';\nimport { routes } from './routes';\nexport const router = createBrowserRouter(routes);\n`);

  const files = new TsResolver().analyzeRoot(dir, dir, { repoRoot: dir, projectFilter: null, env: {}, envProfile: 'sandbox' });
  graph = new GraphBuilder(files).build();
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const eps = () => graph.nodes.filter((n) => n.layer === 'API' || n.layer === 'EXTERNAL').map((n) => `${n.httpMethod} ${n.endpoint}`);
const screens = () => graph.nodes.filter((n) => n.layer === 'SCREEN').map((n) => n.method);

describe('gap-fix coverage', () => {
  it('resolves ky / got / superagent clients', () => {
    expect(eps()).toEqual(expect.arrayContaining(['POST /orders', 'GET /items', 'POST /items']));
  });
  it('resolves a service-class axios instance (this.http)', () => {
    expect(eps()).toContain('GET /products');
  });
  it('resolves aliased and destructured import.meta.env hosts', () => {
    expect(eps()).toEqual(expect.arrayContaining(['GET /aliased', 'GET /destructured']));
    const ext = graph.nodes.filter((n) => n.endpoint === '/aliased')[0];
    expect(ext?.externalUrl).toBe('https://gw.example.com/aliased'); // host resolved, not {}
  });
  it('resolves new URL(path, base) and String.replace param', () => {
    expect(eps()).toEqual(expect.arrayContaining(['GET /v1/url', 'GET /items/{}']));
  });
  it('resolves RTK Query injectEndpoints', () => {
    expect(eps()).toEqual(expect.arrayContaining(['GET /rtk/inj', 'POST /rtk/inj']));
  });
  it('detects screens from an imported routes array', () => {
    expect(screens()).toEqual(expect.arrayContaining(['Dash', 'Detail']));
  });
  it('attributes a route loader HTTP call to the screen', () => {
    expect(eps()).toContain('GET /detail-data');
  });
});
