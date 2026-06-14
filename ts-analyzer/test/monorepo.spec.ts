/**
 * pnpm/turbo monorepo workspace resolution: an app package importing a sibling
 * workspace package by name (`@org/common`, `workspace:*`) must resolve the
 * cross-package wrapper — and transitively (`@org/common` → `@org/domains`) —
 * WITHOUT node_modules, via pnpm-workspace.yaml + injected tsconfig paths.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmap-monorepo-'));
  file('pnpm-workspace.yaml', `packages:\n  - 'packages/*'\n`);
  file('package.json', JSON.stringify({ name: 'root', private: true, devDependencies: { turbo: '^2' } }));

  // shared env package (the API host lives here — the real fe-service-workspace pattern)
  file('packages/domains/package.json', JSON.stringify({ name: '@org/domains', main: 'src/index.ts' }));
  file('packages/domains/src/index.ts', `export const BASE = 'https://api.example.com';\n`);

  // shared lib that imports the env package and wraps axios
  file('packages/common/package.json', JSON.stringify({ name: '@org/common', main: 'src/index.ts', dependencies: { axios: '^1', '@org/domains': 'workspace:*' } }));
  file('packages/common/src/index.ts', `export * from './api';\n`);
  file('packages/common/src/api.ts', `import axios from 'axios';\nimport { BASE } from '@org/domains';\nexport const getUsers = () => axios.get(BASE + '/users');\nexport const addUser = () => axios.post(BASE + '/users', {});\n`);

  // app package importing the shared lib by name
  file('packages/web/package.json', JSON.stringify({ name: '@org/web', dependencies: { next: '^14', react: '^18', '@org/common': 'workspace:*' } }));
  file('packages/web/src/pages/index.tsx', `import { useEffect } from 'react';\nimport { getUsers, addUser } from '@org/common';\nexport default function Home() { useEffect(() => { getUsers(); }, []); return <button onClick={() => addUser()}>x</button>; }\n`);

  const webDir = path.join(dir, 'packages/web');
  const files = new TsResolver().analyzeRoot(webDir, dir, { repoRoot: dir, projectFilter: null, env: {}, envProfile: null });
  graph = new GraphBuilder(files).build();
});
afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const httpEdge = (from: string, target: string) => graph.edges.some((e) => e.source.endsWith(from) && e.target === target && e.relation === 'http');

describe('pnpm workspace cross-package resolution', () => {
  it('traces a wrapper imported from a sibling workspace package', () => {
    expect(httpEdge('Home', 'ext:GET api.example.com/users')).toBe(true);
  });
  it('resolves a POST wrapper from the shared package too', () => {
    expect(httpEdge('Home', 'ext:POST api.example.com/users')).toBe(true);
  });
  it('composes the host from a TRANSITIVE workspace dep (@org/common → @org/domains BASE)', () => {
    const node = graph.nodes.find((n) => n.endpoint === '/users' && n.httpMethod === 'GET');
    expect(node?.externalUrl).toBe('https://api.example.com/users'); // host resolved, not {}
  });
});
