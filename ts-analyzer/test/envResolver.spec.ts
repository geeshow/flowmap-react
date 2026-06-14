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
