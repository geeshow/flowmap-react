/**
 * Env / config value resolution — the analog of the backend's
 * YamlPropertyResolver.kt. Resolves `import.meta.env.X` / `process.env.X` to a
 * literal when known (from .env files, next.config env, or a CLI --env file),
 * else keeps the raw `${X}` placeholder (mirrors the backend keeping `${...}`).
 *
 * Keys are canonicalized like the backend (lowercase, strip '-' and '_') so
 * VITE_API_BASE / vite.api.base / viteApiBase all collide to one entry.
 */

import * as fs from 'fs';
import * as path from 'path';

export class EnvResolver {
  private readonly map = new Map<string, string>();

  constructor(initial?: Record<string, string>) {
    if (initial) for (const [k, v] of Object.entries(initial)) this.put(k, v);
  }

  private static canonical(key: string): string {
    return key.toLowerCase().replace(/[-_]/g, '');
  }

  put(key: string, value: string): void {
    this.map.set(EnvResolver.canonical(key), value);
  }

  /** Resolve a bare env var name to its value, or null if unknown. */
  lookup(name: string): string | null {
    return this.map.get(EnvResolver.canonical(name)) ?? null;
  }

  /** Load .env / .env.<mode> / .env.local from a project root (later wins). */
  loadDotenv(rootDir: string, mode = 'development'): void {
    const files = ['.env', `.env.${mode}`, '.env.local', `.env.${mode}.local`];
    for (const f of files) {
      const full = path.join(rootDir, f);
      if (!fs.existsSync(full)) continue;
      let text: string;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        // strip optional surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        this.put(key, val);
      }
    }
  }

  /**
   * Load an env-cmd `.env-cmdrc(.json)` config — a JSON of named profiles
   * (`{ "sandbox": { "VITE_APP_API_GW": "..." }, "production": {...} }`), common
   * in monorepos. Searches `rootDir` and its ancestors up to `stopDir` (repo root)
   * and merges a `default`/`common` profile then the selected one (later wins).
   * `profile` falls back to `mode`, then 'default'.
   */
  loadEnvCmdrc(rootDir: string, profile: string | null | undefined, mode = 'development', stopDir?: string): void {
    const names = ['.env-cmdrc.json', '.env-cmdrc'];
    const stop = stopDir ? path.resolve(stopDir) : path.parse(path.resolve(rootDir)).root;
    let dir = path.resolve(rootDir);
    for (;;) {
      for (const name of names) {
        const full = path.join(dir, name);
        if (!fs.existsSync(full)) continue;
        let doc: Record<string, unknown>;
        try {
          doc = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch {
          continue;
        }
        const wanted = [profile, mode].filter(Boolean) as string[];
        const chosen = wanted.find((p) => doc[p] && typeof doc[p] === 'object') ?? 'default';
        for (const key of ['default', 'common', chosen]) {
          const prof = doc[key];
          if (prof && typeof prof === 'object') {
            for (const [k, v] of Object.entries(prof as Record<string, unknown>)) {
              if (v != null && typeof v !== 'object') this.put(k, String(v));
            }
          }
        }
        return; // first config found (nearest) wins
      }
      if (dir === stop) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  /** Load a flat `key=value` props file (CLI --env), mirroring backend loadProps. */
  loadPropsFile(file: string): void {
    if (!fs.existsSync(file)) return;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq > 0) this.put(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
  }
}
