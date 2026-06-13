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

  // ---- gateway fallback: public path the gateway rewrites before the backend ----

  function gatewayBackend(): CallGraph {
    return {
      nodes: [
        // backend controller serves the REWRITTEN path (gateway stripped /api)
        makeNode({ id: 'sib#get', fqcn: 'SibController', method: 'getCustomer', layer: 'CONTROLLER', httpMethod: 'GET', endpoint: '/sib/customers/{}', project: 'bank-broker' }),
        // gateway route node carries the PUBLIC prefix
        makeNode({ id: 'gateway:gw#sib', fqcn: 'gw', method: 'sib', layer: 'GATEWAY', httpMethod: null, endpoint: '/api/sib', externalService: 'bank-broker', project: 'gw' }),
        makeNode({ id: 'gateway:gw#root', fqcn: 'gw', method: 'root', layer: 'GATEWAY', httpMethod: null, endpoint: '/', project: 'gw' }),
      ],
      edges: [],
    };
  }

  it('falls back to a gateway when the public path is rewritten before the backend', () => {
    const front: CallGraph = { nodes: [frontApi({ httpMethod: 'GET', endpoint: '/api/sib/customers/{}' })], edges: [] };
    const r = join(front, gatewayBackend());
    expect(r.meta.matched).toBe(1);
    expect(r.meta.viaGateway).toBe(1);
    expect(r.links[0].via).toBe('gateway');
    expect(r.links[0].backendNodeId).toBe('gateway:gw#sib');
  });

  it('prefers a direct controller match over the gateway', () => {
    // a frontend call straight to the rewritten path resolves to the controller, not the gateway
    const front: CallGraph = { nodes: [frontApi({ httpMethod: 'GET', endpoint: '/sib/customers/{}' })], edges: [] };
    const r = join(front, gatewayBackend());
    expect(r.meta.matched).toBe(1);
    expect(r.links[0].via).toBe('direct');
    expect(r.links[0].backendNodeId).toBe('sib#get');
  });

  it('does not let a catch-all `/` gateway greedily claim every call', () => {
    const front: CallGraph = { nodes: [frontApi({ httpMethod: 'GET', endpoint: '/unknown/thing' })], edges: [] };
    const r = join(front, gatewayBackend());
    expect(r.meta.unmatched).toBe(1);
    expect(r.links[0].via).toBeNull();
  });
});
