/**
 * End-to-end Vue/Nuxt analysis on .repo/sample-shop-nuxt: the impact chain
 * page → dispatch → Vuex action → http → API, with cross-function wrapper
 * tracing, env/baseURL folding, Nuxt routes, then join to the backend graph.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../src/graphBuilder';
import { join } from '../src/join';
import * as jsonOutput from '../src/jsonOutput';
import { CallGraph } from '../src/model';
import { VueResolver } from '../src/resolver/vue/vueIrBuilder';

const REPO = path.resolve(__dirname, '../../.repo');
const BACKEND = path.resolve(__dirname, '../../../flowmap-spring-kotlin/kotlin-analyzer/json/_combined.json');

function analyze(): CallGraph {
  const files = new VueResolver().analyze({ repoRoot: REPO, projectFilter: 'sample-shop-nuxt', mode: 'development' });
  return new GraphBuilder(files).build();
}

describe('e2e on sample-shop-nuxt', () => {
  const g = analyze();
  const http = g.nodes.filter((n) => n.layer === 'API' || n.layer === 'EXTERNAL');
  const edge = (rel: string, srcSub: string, tgtSub: string) =>
    g.edges.some((e) => e.relation === rel && e.source.includes(srcSub) && e.target.includes(tgtSub));

  it('maps Nuxt pages to SCREEN nodes with normalized routes', () => {
    const routes = Object.fromEntries(g.nodes.filter((n) => n.layer === 'SCREEN').map((n) => [n.method, n.endpoint]));
    expect(routes['PageIndex']).toBe('/');
    expect(routes['UserDetail']).toBe('/users/{}');
    expect(routes['OrdersPage']).toBe('/orders');
  });

  it('resolves $axios template + process.env.API_VERSION', () => {
    const products = http.find((n) => n.endpoint === '/funding/v1/fund-items');
    expect(products).toBeTruthy(); // API_VERSION folded to v1 (not "{}" or "${...}")
    expect(products!.confidence).toBe('resolved');
    const user = http.find((n) => n.endpoint === '/internal/users/{}');
    expect(user?.httpMethod).toBe('GET');
  });

  it('traces a Vuex action → apis wrapper → window.$nuxt.$axios.post', () => {
    const order = http.find((n) => n.endpoint === '/orders');
    expect(order?.httpMethod).toBe('POST');
    expect(order?.confidence).toBe('resolved');
  });

  it('classifies a third-party absolute URL as EXTERNAL', () => {
    expect(http.some((n) => n.externalUrl?.includes('maps.googleapis.com') && n.layer === 'EXTERNAL')).toBe(true);
  });

  it('creates Vuex action nodes (STORE / vuex-action) and module nodes', () => {
    const action = g.nodes.find((n) => n.id === 'store:vuex:user#fetchUser');
    expect(action?.layer).toBe('STORE');
    expect(action?.resourceType).toBe('vuex-action');
    expect(g.nodes.some((n) => n.id === 'store:vuex:user' && n.resourceType === 'vuex')).toBe(true);
  });

  it('wires the impact chain: dispatch, http, store:read, action→action', () => {
    expect(edge('dispatch', 'UserDetail', 'user#fetchUser')).toBe(true); // page → action
    expect(edge('http', 'user#fetchUser', '/internal/users/{}')).toBe(true); // action → API
    expect(edge('store:read', 'UserDetail', 'store:vuex:user')).toBe(true); // mapGetters
    expect(edge('dispatch', 'root#actionInit', 'user#fetchProducts')).toBe(true); // action → action
    expect(edge('dispatch', 'OrdersPage', 'orders#createOrder')).toBe(true);
  });

  it('joins to the backend controllers when the combined graph is present', () => {
    if (!fs.existsSync(BACKEND)) return;
    const backend = jsonOutput.read(fs.readFileSync(BACKEND, 'utf8'));
    const r = join(g, backend);
    const byPath = Object.fromEntries(r.links.map((l) => [`${l.httpMethod} ${l.normalizedPath}`, l]));
    expect(byPath['GET /internal/users/{}'].matchStatus).toBe('matched');
    expect(byPath['GET /internal/users/{}'].backendProject).toBe('user-service');
    expect(byPath['POST /orders'].matchStatus).toBe('ambiguous');
    expect(byPath['GET /maps/api/geocode/json'].matchStatus).toBe('unmatched');
  });
});
