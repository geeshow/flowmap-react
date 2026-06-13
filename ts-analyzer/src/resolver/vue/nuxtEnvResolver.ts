/**
 * Nuxt env loading — the Vue analog of the React .env loader. Nuxt apps resolve
 * `process.env.API_VERSION` / `process.env.API_HOST` from `config/<mode>.json`
 * (the `config` npm package) and set the axios baseURL in `nuxt.config.js`
 * (`['@nuxtjs/axios', { baseURL: `${env.API_HOST}` }]`). We load those so the
 * ConstantEvaluator can fold `/funding/${process.env.API_VERSION}/...` to a real
 * path, and expose the axios baseURL as an EvalString for URL composition.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EvalString } from '../constantEvaluator';
import { EnvResolver } from '../envResolver';

/** Build an EnvResolver from config/<mode>.json (+ default.json), flattening all string leaves. */
export function loadNuxtEnv(rootDir: string, mode = 'development', extra?: Record<string, string>): EnvResolver {
  const env = new EnvResolver(extra);
  for (const file of ['default.json', `${mode}.json`]) {
    const p = path.join(rootDir, 'config', file);
    if (!fs.existsSync(p)) continue;
    try {
      flatten(JSON.parse(fs.readFileSync(p, 'utf8')), env);
    } catch {
      /* ignore malformed config */
    }
  }
  // also honor a project .env if present
  env.loadDotenv(rootDir, mode);
  return env;
}

/** Best-effort: read the axios module baseURL from nuxt.config.js and resolve its tokens. */
export function readAxiosBaseUrl(rootDir: string, env: EnvResolver): EvalString | null {
  const p = path.join(rootDir, 'nuxt.config.js');
  if (!fs.existsSync(p)) return null;
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  // match baseURL: `...` | '...' | "..."
  const m = text.match(/baseURL\s*:\s*(['"`])([^'"`]*)\1/);
  if (!m) return null;
  return resolveTokens(m[2], env);
}

// ---- internals ----

function flatten(obj: unknown, env: EnvResolver): void {
  if (obj == null || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'string') env.put(k, v);
    else if (typeof v === 'number' || typeof v === 'boolean') env.put(k, String(v));
    else if (typeof v === 'object') flatten(v, env);
  }
}

/** Resolve `${env.API_HOST}` / `${process.env.X}` / `${X}` tokens in a string against env. */
function resolveTokens(raw: string, env: EnvResolver): EvalString {
  let hasPlaceholder = false;
  const value = raw.replace(/\$\{([^}]*)\}/g, (_full, expr: string) => {
    const key = String(expr).trim().split('.').pop() ?? '';
    const v = env.lookup(key);
    if (v != null) return v;
    hasPlaceholder = true;
    return '${' + key + '}';
  });
  return { value: value || null, hasPlaceholder };
}
