/**
 * Coverage for the final niche react-round gaps:
 *  - dynamic `const axios = (await import('axios')).default; axios.get(url)`
 *  - Next.js `'use server'` server actions referenced via `<form action={fn}>`,
 *    whose fetch is attributed to the referencing component.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphBuilder } from '../src/graphBuilder';
import { CallGraph } from '../src/model';
import { TsResolver } from '../src/resolver/irBuilder';

function analyze(setup: (file: (rel: string, body: string) => void) => void): { dir: string; graph: CallGraph } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmap-rr3-'));
  const file = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  setup(file);
  const files = new TsResolver().analyzeRoot(dir, dir, { repoRoot: dir, projectFilter: null, env: {}, envProfile: null });
  return { dir, graph: new GraphBuilder(files).build() };
}

describe('dynamic import("axios")', () => {
  let dir: string;
  let graph: CallGraph;
  beforeAll(() => {
    ({ dir, graph } = analyze((file) => {
      file('package.json', JSON.stringify({ dependencies: { react: '^18', 'react-router-dom': '^6', axios: '^1' } }));
      file('src/api.ts', `export async function loadItems() {\n  const axios = (await import('axios')).default;\n  return axios.get('/api/items');\n}\n`);
      file('src/Page.tsx', `import { loadItems } from './api';\nexport default function Page() { loadItems(); return <div/>; }\n`);
      file('src/main.tsx', `import { createBrowserRouter } from 'react-router-dom';\nimport Page from './Page';\nexport const router = createBrowserRouter([{ path: '/items', element: <Page /> }]);\n`);
    }));
  });
  afterAll(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('resolves a dynamically-imported axios default', () => {
    const node = graph.nodes.find((n) => n.endpoint === '/api/items');
    expect(node).toBeTruthy();
    expect(node?.httpMethod).toBe('GET');
    expect(node?.confidence).toBe('resolved');
  });
});

describe('Next.js server actions via <form action={fn}>', () => {
  let dir: string;
  let graph: CallGraph;
  beforeAll(() => {
    ({ dir, graph } = analyze((file) => {
      file('package.json', JSON.stringify({ dependencies: { next: '^14', react: '^18' } }));
      file('next.config.js', `module.exports = {};\n`);
      file('src/app/actions.ts', `'use server';\nexport async function createPost(formData: FormData) {\n  await fetch('https://api.example.com/posts', { method: 'POST', body: formData });\n}\n`);
      file('src/app/page.tsx', `import { createPost } from './actions';\nexport default function HomePage() {\n  return <form action={createPost}><button>save</button></form>;\n}\n`);
    }));
  });
  afterAll(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('attributes the server action fetch to the referencing component', () => {
    const edge = graph.edges.find(
      (e) => e.source.endsWith('HomePage') && e.target === 'ext:POST api.example.com/posts' && e.relation === 'http',
    );
    expect(edge).toBeTruthy();
  });
});
