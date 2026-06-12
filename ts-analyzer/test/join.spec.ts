/**
 * Pure join tests: matched / unmatched / ambiguous against a hand-built backend
 * graph, plus verb-incompatibility.
 */
import { describe, expect, it } from 'vitest';
import { join } from '../src/join';
import { CallGraph, makeNode } from '../src/model';

function backend(): CallGraph {
  return {
    nodes: [
      makeNode({ id: 'user#get', fqcn: 'UserController', method: 'getUser', layer: 'CONTROLLER', httpMethod: 'GET', endpoint: '/internal/users/{}', project: 'user-service' }),
      makeNode({ id: 'order#create', fqcn: 'OrderController', method: 'create', layer: 'CONTROLLER', httpMethod: 'POST', endpoint: '/orders', project: 'order-service' }),
      makeNode({ id: 'shop#place', fqcn: 'OrderController', method: 'placeOrder', layer: 'CONTROLLER', httpMethod: 'POST', endpoint: '/orders', project: 'sample-shop' }),
    ],
    edges: [],
  };
}

function frontApi(over: Partial<ReturnType<typeof makeNode>>) {
  return makeNode({ id: 'x', fqcn: 'api', method: 'get', layer: 'EXTERNAL', ...over });
}

describe('join', () => {
  it('matches a single controller by (verb, normalized path)', () => {
    const front: CallGraph = { nodes: [frontApi({ httpMethod: 'GET', endpoint: '/internal/users/{}', confidence: 'resolved' })], edges: [] };
    const r = join(front, backend());
    expect(r.meta.matched).toBe(1);
    expect(r.links[0].backendNodeId).toBe('user#get');
    expect(r.links[0].backendProject).toBe('user-service');
  });

  it('flags ambiguous when multiple providers and no hint', () => {
    const front: CallGraph = { nodes: [frontApi({ httpMethod: 'POST', endpoint: '/orders' })], edges: [] };
    const r = join(front, backend());
    expect(r.meta.ambiguous).toBe(1);
    expect(r.links[0].candidates.sort()).toEqual(['order#create', 'shop#place']);
  });

  it('resolves ambiguity via service hint', () => {
    const front: CallGraph = {
      nodes: [frontApi({ httpMethod: 'POST', endpoint: '/orders', externalService: 'order-service' })],
      edges: [],
    };
    const r = join(front, backend());
    expect(r.meta.matched).toBe(1);
    expect(r.links[0].backendProject).toBe('order-service');
  });

  it('leaves third-party / verb-mismatch unmatched', () => {
    const front: CallGraph = {
      nodes: [
        frontApi({ id: 'a', httpMethod: 'GET', endpoint: '/maps/api/geocode/json' }),
        frontApi({ id: 'b', httpMethod: 'GET', endpoint: '/orders' }), // backend only POST /orders
      ],
      edges: [],
    };
    const r = join(front, backend());
    expect(r.meta.unmatched).toBe(2);
  });
});
