/**
 * End-to-end: run the full TsResolver + GraphBuilder on the .repo/sample-shop-react
 * fixture, asserting the hard passes (cross-function wrapper tracing, env/baseURL,
 * route→screen, stores), then join against the backend _combined.json.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../src/graphBuilder';
import { join } from '../src/join';
import * as jsonOutput from '../src/jsonOutput';
import { CallGraph } from '../src/model';
import { TsResolver } from '../src/resolver/irBuilder';

const REPO = path.resolve(__dirname, '../../.repo');
const BACKEND = path.resolve(__dirname, '../../../flowmap-spring-kotlin/kotlin-analyzer/json/_combined.json');

function analyze(): CallGraph {
  const files = new TsResolver().analyze({ repoRoot: REPO, projectFilter: 'sample-shop-react' });
  return new GraphBuilder(files).build();
}

describe('e2e on sample-shop-react', () => {
  const g = analyze();
  const byId = (id: string) => g.nodes.find((n) => n.id === id);
  const httpNodes = g.nodes.filter((n) => n.layer === 'API' || n.layer === 'EXTERNAL');

  it('skips the Vue project and finds the React one', () => {
    expect(g.nodes.length).toBeGreaterThan(0);
    expect(g.nodes.every((n) => !n.file || n.file.startsWith('sample-shop-react') || n.id.startsWith('ext:') || n.id.startsWith('store:'))).toBe(true);
  });

  it('resolves a wrapper call + env baseURL + path param → full URL', () => {
    const user = httpNodes.find((n) => n.endpoint === '/internal/users/{}');
    expect(user).toBeTruthy();
    expect(user!.httpMethod).toBe('GET');
    expect(user!.externalUrl).toBe('https://api.shop.com/internal/users/{}');
    expect(user!.confidence).toBe('resolved');
  });

  it('resolves all wrapper-based endpoints', () => {
    const eps = httpNodes.map((n) => `${n.httpMethod} ${n.endpoint}`).sort();
    expect(eps).toContain('POST /orders');
    expect(eps).toContain('POST /orders/{}/notify');
    expect(eps).toContain('GET /internal/investment/current-summary');
  });

  it('resolves a 2-level custom wrapper with a config-object URL (fetchData pattern)', () => {
    // component → fetchAccountOpenable → fetchData({ url }) → http.get(url)
    // URL is NIFFLER_API_URL.ACCOUNT_OPENABLE (object member over nested template literals).
    const acct = httpNodes.find((n) => n.endpoint === '/account/v1/account-openable');
    expect(acct).toBeTruthy();
    expect(acct!.httpMethod).toBe('GET');
    expect(acct!.externalUrl).toBe('https://api.shop.com/account/v1/account-openable');
    expect(acct!.confidence).toBe('resolved');
  });

  it('resolves a React-Query options factory (queryFn + stringifyUrl + default-export axios)', () => {
    // useAccountListQuery → accountListQueryOptions → queryOptions({ queryFn: () => accountAxios.get(url) })
    // url = queryString.stringifyUrl({ url: NIFFLER_API_URL.ACCOUNT_LIST, query }) (local const).
    const list = httpNodes.find((n) => n.endpoint === '/account/v1/account-list');
    expect(list).toBeTruthy();
    expect(list!.httpMethod).toBe('GET');
    expect(list!.externalUrl).toBe('https://api.shop.com/account/v1/account-list');
  });

  it('resolves a queryFn whose axios instance is env-gated/cross-module (homeAxios pattern)', () => {
    // useHomeAccountListSuspenseQuery → accountListQueryOptions → object literal whose
    // queryFn calls `homeAxios.get(...).then(...)`, where homeAxios is NOT a direct
    // `axios.create(...)`: it's `isServer ? serverAxios : secAxios`, and secAxios's own
    // module default-export is itself `isMock ? mockAxios : secAxios` over an
    // `axios.create({...})` — so instance detection must follow ternaries + cross-file aliases.
    const list = byId('ext:GET api.shop.com/account/v1/account-list');
    expect(list).toBeTruthy();
    const hook = byId('sample-shop-react/src/api/homeQuery.ts::useHomeAccountListSuspenseQuery');
    expect(hook).toBeTruthy();
    const edge = g.edges.find((e) => e.source === hook!.id && e.relation === 'http' && e.target === list!.id);
    expect(edge).toBeTruthy();
  });

  it('strips an unresolved env gateway host, keeping the path (`${API_GW}/account/...` → /account/...)', () => {
    // GatewayHostPage → fetch(`${API_GW}/account/v1/account-list`) where API_GW is an env
    // host that can't resolve. The host varies per environment so it is excluded, but the
    // path after it must survive as the join key — NOT collapse to `/{}/v1/account-list`.
    const node = byId('ext:GET /account/v1/account-list');
    expect(node).toBeTruthy();
    expect(node!.endpoint).toBe('/account/v1/account-list');
    expect(node!.layer).toBe('API'); // host unresolved → not EXTERNAL
    expect(node!.urlPlaceholder).toContain('${UNRESOLVABLE_GW_HOST}');
  });

  it('resolves a URL pulled from a local object destructure (const { url } = config)', () => {
    const terms = httpNodes.find((n) => n.endpoint === '/account/v1/service-terms');
    expect(terms).toBeTruthy();
    expect(terms!.httpMethod).toBe('GET');
    expect(terms!.externalUrl).toBe('https://api.shop.com/account/v1/service-terms');
  });

  it('marks a bare fetch as partial (verb defaulted)', () => {
    const f = httpNodes.find((n) => n.endpoint === '/orders' && n.layer === 'API');
    expect(f).toBeTruthy();
    expect(f!.confidence).toBe('partial');
  });

  it('classifies a third-party absolute URL as EXTERNAL', () => {
    const maps = httpNodes.find((n) => n.externalUrl?.includes('maps.googleapis.com'));
    expect(maps?.layer).toBe('EXTERNAL');
  });

  it('maps react-router routes to SCREEN nodes (incl. lazy)', () => {
    const screens = g.nodes.filter((n) => n.layer === 'SCREEN');
    const map = Object.fromEntries(screens.map((s) => [s.method, s.endpoint]));
    expect(map['UserPage']).toBe('/users/{}');
    expect(map['OrdersPage']).toBe('/orders');
    expect(map['ReportPage']).toBe('/report'); // lazy(() => import(...)) resolved
  });

  it('detects redux / zustand / context stores (no axios false-positive)', () => {
    const stores = g.nodes.filter((n) => n.layer === 'STORE').map((n) => n.id);
    expect(stores).toContain('store:redux:user');
    expect(stores).toContain('store:zustand:useCartStore');
    expect(stores).toContain('store:context:AuthContext');
    expect(stores.some((s) => s.includes('http'))).toBe(false);
  });

  it('wires component→hook (call), component→child (render), store edges', () => {
    const rels = new Set(g.edges.map((e) => e.relation));
    expect(rels.has('render')).toBe(true);
    expect(rels.has('call')).toBe(true);
    expect(rels.has('http')).toBe(true);
    expect(rels.has('store:read')).toBe(true);
    expect(rels.has('dispatch')).toBe(true);
  });

  it('joins to the backend controllers when the combined graph is present', () => {
    if (!fs.existsSync(BACKEND)) {
      // backend graph not generated in this checkout — skip the cross-repo assertion
      return;
    }
    const backend = jsonOutput.read(fs.readFileSync(BACKEND, 'utf8'));
    const r = join(g, backend);
    const byPath = Object.fromEntries(r.links.map((l) => [`${l.httpMethod} ${l.normalizedPath}`, l]));
    expect(byPath['GET /internal/users/{}'].matchStatus).toBe('matched');
    expect(byPath['GET /internal/users/{}'].backendProject).toBe('user-service');
    expect(byPath['POST /orders/{}/notify'].matchStatus).toBe('matched');
    expect(byPath['POST /orders'].matchStatus).toBe('ambiguous');
    expect(byPath['GET /maps/api/geocode/json'].matchStatus).toBe('unmatched');
    expect(r.meta.matched).toBeGreaterThanOrEqual(3);
  });
});

describe('e2e on shopflow-web (deep var/const/substituted chains)', () => {
  const files = new TsResolver().analyze({ repoRoot: REPO, projectFilter: 'shopflow-web' });
  const g = new GraphBuilder(files).build();
  const httpNodes = g.nodes.filter((n) => n.layer === 'API' || n.layer === 'EXTERNAL');
  const ep = (method: string, endpoint: string) =>
    httpNodes.find((n) => n.httpMethod === method && n.endpoint === endpoint);

  it('resolves every gateway endpoint to its normalized form with confidence=resolved', () => {
    const expected: Array<[string, string]> = [
      ['POST', '/user/v1/users'],
      ['GET', '/user/v1/users/{}/profile'],
      ['POST', '/order/v1/orders'],
      ['GET', '/order/v1/orders'],
      ['GET', '/order/v1/orders/{}'],
      ['POST', '/payment/v1/payments'],
      ['GET', '/payment/v1/payments/{}'],
      ['GET', '/catalog/v1/catalog/items'],
      ['GET', '/catalog/v1/catalog/items/{}'],
    ];
    for (const [m, e] of expected) {
      const n = ep(m, e);
      expect(n, `${m} ${e}`).toBeTruthy();
      expect(n!.confidence, `${m} ${e} confidence`).toBe('resolved');
      expect(n!.urlPlaceholder, `${m} ${e} placeholder`).toBeFalsy();
    }
  });

  it('binds the HTTP verb through a generic request({ url, method }) wrapper', () => {
    // createUser → request({ url, method: 'POST' }) → http.request(cfg) reads cfg.method.
    expect(ep('POST', '/user/v1/users')).toBeTruthy();
  });

  it('folds a function-valued path const call, e.g. (id) => `/v1/orders/${id}` → /{}', () => {
    expect(ep('GET', '/order/v1/orders/{}')).toBeTruthy();
    expect(ep('GET', '/catalog/v1/catalog/items/{}')).toBeTruthy();
  });

  it('resolves a substituted-variable URL indirection (const path = ORDER_PATHS.LIST)', () => {
    const list = ep('GET', '/order/v1/orders');
    expect(list).toBeTruthy();
    expect(list!.externalUrl).toBe('https://gw.shopflow.io/order/v1/orders');
  });

  it('traces a redux createAsyncThunk body to its API (dispatch → thunk → apiWrapper → http)', () => {
    const thunk = g.nodes.find((n) => n.id === 'store:redux:order#placeOrder');
    expect(thunk).toBeTruthy();
    const fromThunk = g.edges.filter((e) => e.source === thunk!.id && e.target.startsWith('ext:'));
    expect(fromThunk.length).toBeGreaterThan(0);
    expect(fromThunk[0].target).toContain('/order/v1/orders');
  });
});
