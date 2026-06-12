/**
 * Join: link the frontend graph's API/EXTERNAL nodes to the backend graph's
 * CONTROLLER nodes via (httpMethod, normPath(endpoint)). Same key + verbOk rules
 * as the backend's CrossRun S2S matching, so a frontend `GET /users/{}` resolves
 * to the controller that serves it. Unmatched calls are listed explicitly so
 * coverage is auditable. Produces a SEPARATE join file (graphs are not merged).
 */

import { CallGraph, Confidence, MethodNode } from './model';
import { normPath, verbOk } from './norm';

export interface JoinLink {
  frontendNodeId: string;
  httpMethod: string | null;
  normalizedPath: string;
  rawUrl: string | null;
  confidence: Confidence | null;
  backendNodeId: string | null;
  backendProject: string | null;
  matchStatus: 'matched' | 'unmatched' | 'ambiguous';
  candidates: string[];
}

export interface JoinResult {
  meta: {
    matched: number;
    unmatched: number;
    ambiguous: number;
  };
  links: JoinLink[];
}

/** Tokens that hint at the target service (Feign-name analog): host + ${...} segments. */
function hintTokens(n: MethodNode): string[] {
  const toks: string[] = [];
  if (n.externalService) toks.push(n.externalService);
  for (const raw of [n.externalUrl, n.urlPlaceholder]) {
    if (!raw) continue;
    const re = /\$\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) toks.push(m[1].split('.').pop()!);
  }
  return toks.map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, '')).filter((t) => t.length > 0);
}

function projectMatchesHint(project: string | null, tokens: string[]): boolean {
  if (!project || !tokens.length) return false;
  const p = project.toLowerCase().replace(/[^a-z0-9]/g, '');
  return tokens.some((t) => t === p || t.includes(p) || p.includes(t));
}

export function join(frontend: CallGraph, backend: CallGraph): JoinResult {
  // index backend controller endpoints by normalized path
  const providers = backend.nodes.filter((n) => n.layer === 'CONTROLLER' && n.endpoint && n.endpoint.length > 0);

  const links: JoinLink[] = [];
  const apiNodes = frontend.nodes.filter((n) => (n.layer === 'API' || n.layer === 'EXTERNAL') && n.endpoint);

  for (const fn of apiNodes) {
    const np = normPath(fn.endpoint);
    const matches = providers.filter((p) => normPath(p.endpoint) === np && verbOk(p.httpMethod, fn.httpMethod));

    let backendNodeId: string | null = null;
    let backendProject: string | null = null;
    let status: JoinLink['matchStatus'] = 'unmatched';
    let candidates: string[] = [];

    if (matches.length === 1) {
      backendNodeId = matches[0].id;
      backendProject = matches[0].project;
      status = 'matched';
    } else if (matches.length > 1) {
      const hints = hintTokens(fn);
      const preferred = matches.find((p) => projectMatchesHint(p.project, hints));
      const chosen = preferred ?? matches[0];
      backendNodeId = chosen.id;
      backendProject = chosen.project;
      status = preferred ? 'matched' : 'ambiguous';
      candidates = matches.map((p) => p.id);
    }

    links.push({
      frontendNodeId: fn.id,
      httpMethod: fn.httpMethod,
      normalizedPath: np,
      rawUrl: fn.externalUrl,
      confidence: fn.confidence,
      backendNodeId,
      backendProject,
      matchStatus: status,
      candidates,
    });
  }

  return {
    meta: {
      matched: links.filter((l) => l.matchStatus === 'matched').length,
      unmatched: links.filter((l) => l.matchStatus === 'unmatched').length,
      ambiguous: links.filter((l) => l.matchStatus === 'ambiguous').length,
    },
    links,
  };
}
