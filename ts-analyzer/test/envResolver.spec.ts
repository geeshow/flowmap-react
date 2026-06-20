/** env-cmd `.env-cmdrc(.json)` loading: profile selection, default merge, ancestor search. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvResolver } from '../src/resolver/envResolver';

let tmp: string | null = null;
afterEach(() => { if (tmp) { fs.rmSync(tmp, { recursive: true, force: true }); tmp = null; } });

function repo(cmdrc: object, sub = 'app'): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmap-envcmd-'));
  fs.writeFileSync(path.join(tmp, '.env-cmdrc.json'), JSON.stringify(cmdrc));
  const appDir = path.join(tmp, sub);
  fs.mkdirSync(appDir, { recursive: true });
  return appDir;
}

describe('EnvResolver.loadEnvCmdrc', () => {
  const cfg = {
    default: { VITE_APP_API_GW: 'https://default.example.com', COMMON: 'c' },
    sandbox: { VITE_APP_API_GW: 'https://sandbox-app-api-gw.kakaopaysec.com' },
  };

  it('selects the named profile, layered over default', () => {
    const app = repo(cfg);
    const env = new EnvResolver();
    env.loadEnvCmdrc(app, 'sandbox', 'development', path.dirname(app));
    expect(env.lookup('VITE_APP_API_GW')).toBe('https://sandbox-app-api-gw.kakaopaysec.com');
    expect(env.lookup('COMMON')).toBe('c'); // inherited from default
  });

  it('falls back to default when the profile is absent', () => {
    const app = repo(cfg);
    const env = new EnvResolver();
    env.loadEnvCmdrc(app, null, 'development', path.dirname(app));
    expect(env.lookup('VITE_APP_API_GW')).toBe('https://default.example.com');
  });

  it('finds the config in an ancestor directory (monorepo root)', () => {
    const app = repo(cfg, 'apps/web'); // config two levels up
    const env = new EnvResolver();
    env.loadEnvCmdrc(app, 'sandbox', 'development', path.resolve(app, '../..'));
    expect(env.lookup('VITE_APP_API_GW')).toBe('https://sandbox-app-api-gw.kakaopaysec.com');
  });

  it('canonicalizes keys (VITE_APP_API_GW ≈ viteAppApiGw)', () => {
    const app = repo(cfg);
    const env = new EnvResolver();
    env.loadEnvCmdrc(app, 'sandbox', 'development', path.dirname(app));
    expect(env.lookup('viteAppApiGw')).toBe('https://sandbox-app-api-gw.kakaopaysec.com');
  });
});

describe('EnvResolver variable expansion (dotenv-expand)', () => {
  it('inlines ${VAR} / $VAR references to other loaded vars', () => {
    const env = new EnvResolver({ VITE_BASE: 'https://api.example.com', VITE_API_URL: '${VITE_BASE}/api', VITE_WS: '$VITE_BASE/ws' });
    expect(env.lookup('VITE_API_URL')).toBe('https://api.example.com/api');
    expect(env.lookup('VITE_WS')).toBe('https://api.example.com/ws');
  });

  it('resolves chained references', () => {
    const env = new EnvResolver({ HOST: 'https://x.com', BASE: '${HOST}/v1', FULL: '${BASE}/orders' });
    expect(env.lookup('FULL')).toBe('https://x.com/v1/orders');
  });

  it('keeps an unknown reference as a canonical ${NAME} placeholder', () => {
    const env = new EnvResolver({ VITE_API_URL: '${UNKNOWN_GW}/api' });
    expect(env.lookup('VITE_API_URL')).toBe('${UNKNOWN_GW}/api');
  });

  it('does not loop on a cyclic reference', () => {
    const env = new EnvResolver({ A: '${B}', B: '${A}' });
    expect(env.lookup('A')).toBe('${A}'); // A→B→A: the back-reference is left untouched
  });

  it('leaves plain values (no $) untouched', () => {
    const env = new EnvResolver({ URL: 'https://plain.example.com/api' });
    expect(env.lookup('URL')).toBe('https://plain.example.com/api');
  });
});
