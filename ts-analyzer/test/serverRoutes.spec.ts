/**
 * In-repo server routes (Express/connect routers + Vite dev middleware) become
 * `route-handler` provider nodes, so a component calling them stays internal
 * (not a false external) and the join classifies them `internal`. Written to a
 * temp project (no committed fixture).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphBuilder } from '../src/graphBuilder';
import { join } from '../src/join';
import { CallGraph, MethodNode, makeNode } from '../src/model';
import { TsResolver } from '../src/resolver/irBuilder';

let dir: string;
let graph: CallGraph;

const file = (rel: string, body: string) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
const byId = (id: string): MethodNode | undefined => graph.nodes.find((n) => n.id === id);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmap-server-routes-'));
  file('package.json', JSON.stringify({ name: 'bff', dependencies: { react: '^18', express: '^4', axios: '^1' } }));

  // Express BFF: a sub-router mounted at /api + a direct route, one handler proxying upstream.
  file(
    'src/server/app.ts',
    `import express, { Router } from 'express';\n` +
      `import axios from 'axios';\n` +
      `const app = express();\n` +
      `const router = Router();\n` +
      `router.get('/users/:id', async (req, res) => {\n` +
      `  const r = await axios.get('https://upstream.example.com/v1/users/' + req.params.id);\n` +
      `  res.json(r.data);\n` +
      `});\n` +
      `app.use('/api', router);\n` +
      `app.post('/login', (req, res) => res.sendStatus(200));\n` +
      `export default app;\n`,
  );

  // Vite dev middleware serving /health.
  file(
    'src/vite/plugin.ts',
    `export const plugin = {\n` +
      `  name: 'health',\n` +
      `  configureServer(server: any) {\n` +
      `    server.middlewares.use('/health', (req: any, res: any) => res.end('ok'));\n` +
      `  },\n` +
      `};\n`,
  );

  // Consumer component: calls the BFF routes (GET vs the ANY /health handler too).
  file(
    'src/pages/Profile.tsx',
    `export const Profile = () => {\n` +
      `  const load = () => {\n` +
      `    fetch('/api/users/1');\n` +
      `    fetch('/login', { method: 'POST' });\n` +
      `    fetch('/health');\n` +
      `  };\n` +
      `  return <button onClick={load}>load</button>;\n` +
      `};\n`,
  );

  const ir = new TsResolver().analyzeRoot(dir, dir, { repoRoot: dir, projectFilter: null, env: {} });
  graph = new GraphBuilder(ir).build();
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('server-route detection', () => {
  it('creates Express route-handler provider nodes (with mount prefix resolved)', () => {
    const users = byId('ext:GET /api/users/{}');
    expect(users?.layer).toBe('API');
    expect(users?.description).toBe('express-route-handler');
    expect(byId('ext:POST /login')?.description).toBe('express-route-handler');
  });

  it('creates a Vite-middleware route-handler node', () => {
    expect(byId('ext:ANY /health')?.description).toBe('express-route-handler');
  });

  it('merges the consumer GET /api/users/{} call into the handler node (in-repo chain)', () => {
    // consumer fetch('/api/users/1') normalizes to the same id as the handler → one node
    const edges = graph.edges.filter((e) => e.target === 'ext:GET /api/users/{}' && e.relation === 'http');
    expect(edges.length).toBe(1); // Profile → handler
  });

  it('captures the handler → upstream backend call (proxy chain)', () => {
    const up = graph.nodes.find((n) => n.layer === 'EXTERNAL' && n.id.includes('upstream.example.com'));
    expect(up).toBeTruthy();
    expect(graph.edges.some((e) => e.source === 'ext:GET /api/users/{}' && e.target === up!.id)).toBe(true);
  });

  it('join classifies in-repo routes as internal, not unmatched/false-external', () => {
    // a backend that serves none of the BFF paths
    const backend: CallGraph = {
      nodes: [makeNode({ id: 'b#x', fqcn: 'C', method: 'x', layer: 'CONTROLLER', httpMethod: 'GET', endpoint: '/other', project: 'svc' })],
      edges: [],
    };
    const r = join(graph, backend);
    // GET /api/users/{}, POST /login, ANY /health (handler) + GET /health (consumer, caught by path set)
    expect(r.meta.internal).toBeGreaterThanOrEqual(3);
    const internalIds = r.links.filter((l) => l.matchStatus === 'internal').map((l) => l.frontendNodeId);
    expect(internalIds).toContain('ext:GET /api/users/{}');
    expect(internalIds).toContain('ext:POST /login');
    // the upstream real backend call is NOT internal
    expect(r.links.find((l) => l.frontendNodeId.includes('upstream.example.com'))?.matchStatus).not.toBe('internal');
  });
});
