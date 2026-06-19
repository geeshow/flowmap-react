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
  // env-cmd `.env-cmdrc.json` + an `a || b` gateway-host const (the real monorepo shape):
  // the host must resolve so the endpoint path (not `/{}/...`) joins to the backend.
  file('.env-cmdrc.json', JSON.stringify({ sandbox: { VITE_APP_API_GW: 'https://sandbox-gw.example.com' } }));
  file('src/env.ts', `export const API_GW = import.meta.env.VITE_APP_API_GW || process.env.NEXT_PUBLIC_API_GW;\n`);
  file('src/api/gw.ts', `import axios from 'axios';\nimport { API_GW } from '../env';\nconst BASE = \`\${API_GW}/account/v1\`;\nexport const listAccounts = () => axios.get(\`\${BASE}/trading/accounts\`);\n`);
  file('src/pages/Accounts.tsx', `import { listAccounts } from '../api/gw';\nexport const Accounts = () => <button onClick={() => listAccounts()}>a</button>;\n`);
  // gateway base-url imported from an EXTERNAL package (`@scope/env`) → unresolvable, so
  // const folding reduces it to a bare `{}` host. The endpoint must strip that host
  // (`/pension/v1/...`), not keep a spurious `/{}` segment that never joins to a backend.
  file('src/gw/env.ts', `import { SEC_API_GW_URL } from '@paysec-fe/env';\nexport { SEC_API_GW_URL };\n`);
  file('src/gw/apiUrl.ts', `import { SEC_API_GW_URL } from './env';\nconst PENSION_BASE_URL = \`\${SEC_API_GW_URL}/pension/v1\`;\nexport const API_URL = { PENSION: { ISA_AVAILABLE_TIME: \`\${PENSION_BASE_URL}/isa/conversions/available-time\` } };\n`);
  file('src/gw/isa.ts', `import axios from 'axios';\nimport { API_URL } from './apiUrl';\nexport const getIsaAvailableTime = () => axios.get(API_URL.PENSION.ISA_AVAILABLE_TIME);\n`);
  file('src/pages/Isa.tsx', `import { getIsaAvailableTime } from '../gw/isa';\nexport const Isa = () => <button onClick={() => getIsaAvailableTime()}>i</button>;\n`);
  // axios NAMED utility imports (isCancel/isAxiosError) are NOT http calls — a helper
  // wrapping them must not become an `ext:…#unresolved` external-call node.
  file('src/utils/cancel.ts', `import { isCancel, isAxiosError } from 'axios';\nexport const checkIsCanceledError = (e: any) => isCancel(e);\nexport const checkIsAxiosError = (e: any) => isAxiosError(e);\n`);
  // a genuinely unresolvable url (a function-call arg const folding can't evaluate):
  // the node keeps the url-arg source text so it stays identifiable.
  file('src/api/dyn.ts', `import axios from 'axios';\ndeclare function buildPath(id: string): string;\nexport const fetchDyn = (id: string) => axios.get(buildPath(id));\n`);
  file('src/pages/Misc.tsx', `import { checkIsCanceledError } from '../utils/cancel';\nimport { fetchDyn } from '../api/dyn';\nexport const Misc = () => <button onClick={() => { checkIsCanceledError({}); fetchDyn('1'); }}>m</button>;\n`);
  // Real-world axios error-inspection helpers + a Sentry init module. These reference
  // axios NAMED imports only (AxiosError.* constants, isCancel/isAxiosError type guards),
  // make NO HTTP request, and must never produce API/EXTERNAL nodes — even when called.
  file('src/helpers/checkAxiosErrorTypes.ts', `import { AxiosError, isCancel } from 'axios';\nexport const API_GW_ERROR_CODE = { MAINTENANCE: 'MAINTENANCE', NOT_ALLOWED_URL: 'NOT_ALLOWED_URL', SEC_OUT: 'SEC_OUT' } as const;\nexport const checkIsCanceledError2 = (e: any) => isCancel(e);\n/** Axios > ABORT @see https://jira.example.com/browse/ABC-1 */\nexport const checkIsRequestAbortedError = (e: any): boolean => e.code === AxiosError.ECONNABORTED && e.message === 'Request aborted';\n`);
  file('src/sentry/InitSentry.tsx', `import { useEffect } from 'react';\nimport { AxiosError, isAxiosError } from 'axios';\ndeclare function initSentry(o: any): void;\nexport const InitSentry: () => null = () => {\n  useEffect(() => {\n    initSentry({\n      dsn: process.env.NEXT_PUBLIC_MATRIX_DSN,\n      beforeSend(event: any, hint: any) {\n        const error: unknown = hint?.originalException;\n        if (isAxiosError(error) && error.code === AxiosError.ERR_NETWORK && document.visibilityState === 'hidden') return null;\n        return event;\n      },\n    });\n  }, []);\n  return null;\n};\n`);
  file('src/pages/ErrPage.tsx', `import { checkIsRequestAbortedError } from '../helpers/checkAxiosErrorTypes';\nimport { InitSentry } from '../sentry/InitSentry';\nexport const ErrPage = () => { const onErr = (e: any) => checkIsRequestAbortedError(e); return <button onClick={() => onErr({})}><InitSentry/>x</button>; };\n`);
  const files = new TsResolver().analyzeRoot(dir, dir, { repoRoot: dir, projectFilter: null, env: {}, envProfile: 'sandbox' });
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

  it('resolves an `a || b` gateway-host const via env-cmdrc so the path joins (no /{} host)', () => {
    const eps = endpoints();
    expect(eps).toContain('GET /account/v1/trading/accounts');
    // the host must be stripped — never a leading {} placeholder segment
    expect(eps.some((e) => e.includes('/{}/account'))).toBe(false);
  });

  it('strips an unresolved (anonymous {}) gateway-host import so the path joins (no /{} host)', () => {
    const eps = endpoints();
    expect(eps).toContain('GET /pension/v1/isa/conversions/available-time');
    // the unresolved host must never survive as a leading {} segment
    expect(eps.some((e) => e.includes('/{}/pension'))).toBe(false);
    expect(graph.nodes.some((n) => n.id.includes('/{}/pension'))).toBe(false);
  });

  it('walks a concise-arrow component body (calls inside it are captured)', () => {
    // Home is a concise-arrow component; its handler calls must produce http edges.
    const http = graph.edges.filter((e) => e.relation === 'http');
    expect(http.length).toBeGreaterThanOrEqual(3);
  });

  it('does not treat axios named utilities (isCancel/isAxiosError) as http calls', () => {
    // No external node may originate from the cancel helpers.
    const ids = graph.nodes.map((n) => n.id);
    expect(ids.some((id) => id.includes('checkIsCanceledError'))).toBe(false);
    expect(ids.some((id) => id.includes('checkIsAxiosError'))).toBe(false);
  });

  it('labels an unresolved url with the url-arg source text (not a bare #unresolved)', () => {
    const unresolved = graph.nodes.filter((n) => /#unresolved$/.test(n.id));
    // the dynamic axios.get(buildPath(id)) call keeps its expression in the id
    expect(unresolved.some((n) => n.id.includes('buildPath(id)'))).toBe(true);
    // and it is never the bare, indistinguishable form
    expect(unresolved.some((n) => n.id === 'ext:axios#unresolved')).toBe(false);
  });

  it('axios error-inspection helpers + Sentry beforeSend produce NO api/external node', () => {
    // checkIsRequestAbortedError (AxiosError.ECONNABORTED member access), InitSentry's
    // beforeSend (isAxiosError + AxiosError.ERR_NETWORK), and the error-code const objects
    // are all axios NAMED-import usage with no HTTP request. None may create an http node.
    const api = graph.nodes.filter((n) => n.layer === 'API' || n.layer === 'EXTERNAL');
    const ids = api.map((n) => n.id).join('\n');
    expect(ids).not.toMatch(/checkIsRequestAbortedError|InitSentry|beforeSend|ECONNABORTED|ERR_NETWORK|MATRIX_DSN/);
    // and calling them produces no spurious http edge from the consuming screen
    const fromErrPage = graph.edges.filter(
      (e) => e.relation === 'http' && e.source.includes('ErrPage'),
    );
    expect(fromErrPage).toHaveLength(0);
  });
});
