/**
 * Golden table for the join-key normalizers — mirrored from the backend
 * (RestDocs.normalize / CrossRun.normPath / verbOk). If these drift from the
 * backend, the join silently breaks, so these values are the contract.
 */
import { describe, expect, it } from 'vitest';
import { normalize, normPath, verbOk } from '../src/norm';

describe('normalize (RestDocs.normalize)', () => {
  const cases: [string | null, string][] = [
    ['/users/123', '/users/{}'],
    ['/users/{id}/profile', '/users/{}/profile'],
    ['/orders/{id}/notify', '/orders/{}/notify'],
    ['/internal/users/550e8400-e29b-41d4-a716-446655440000', '/internal/users/{}'],
    ['/a/b?x=1', '/a/b'],
    ['/', '/'],
    ['', ''],
    [null, ''],
  ];
  it.each(cases)('normalize(%j) === %j', (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });
});

describe('normPath (CrossRun.normPath)', () => {
  const cases: [string | null, string][] = [
    ['/users/{id}', '/users/{}'],
    ['/users/{userNo}', '/users/{}'],
    ['/a/b/', '/a/b'],
    ['/a?x=1', '/a'],
    ['/', '/'],
    ['', ''],
    [null, ''],
  ];
  it.each(cases)('normPath(%j) === %j', (input, expected) => {
    expect(normPath(input)).toBe(expected);
  });

  it('two id styles collapse to the same key', () => {
    expect(normPath('/users/{id}')).toBe(normPath('/users/{userNo}'));
  });

  it('collapses express/nest :param to {} (both normalizers)', () => {
    expect(normPath('/files/:id')).toBe('/files/{}');
    expect(normalize('/files/:fileId')).toBe('/files/{}');
    // a :param path matches a {} template path
    expect(normPath('/files/:id')).toBe(normPath('/files/{id}'));
  });
});

describe('verbOk (CrossRun.verbOk)', () => {
  it('exact + wildcards', () => {
    expect(verbOk('POST', 'POST')).toBe(true);
    expect(verbOk('POST', 'GET')).toBe(false);
    expect(verbOk(null, 'GET')).toBe(true);
    expect(verbOk('ANY', 'GET')).toBe(true);
    expect(verbOk('GET', null)).toBe(true);
    expect(verbOk('GET', 'ANY')).toBe(true);
  });
});
