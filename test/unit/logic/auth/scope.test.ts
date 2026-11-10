import { describe, expect, it } from 'vitest';
import { defaultScopeForMethod, hasScope, requiredMcpScope, scopeOfTool } from '../../../../src/logic/auth/scope.js';
import { Scope } from '../../../../src/models/auth/scope.js';

const WRITE = Scope.enum['patty:write'];

const READ = Scope.enum['patty:read'];

describe('hasScope', () => {
  it('lets write imply read, and nothing imply write', () => {
    expect(hasScope([WRITE], READ)).toBe(true);
    expect(hasScope([READ], READ)).toBe(true);
    expect(hasScope([WRITE], WRITE)).toBe(true);
    expect(hasScope([READ], WRITE)).toBe(false);
    expect(hasScope([], READ)).toBe(false);
  });

  it('ignores scope strings it does not know', () => {
    expect(hasScope(['offline_access', 'admin'], READ)).toBe(false);
  });
});

describe('the REST scope default rule', () => {
  it.each([
    ['GET', READ],
    ['get', READ],
    ['HEAD', READ],
    ['POST', WRITE],
    ['PATCH', WRITE],
    ['DELETE', WRITE],
    ['PUT', WRITE],
    ['OPTIONS', WRITE], // anything not plainly a read fails closed
  ])('%s needs %s', (method, scope) => {
    expect(defaultScopeForMethod(method)).toBe(scope);
  });
});

describe('scopeOfTool', () => {
  it('derives read only from an explicit readOnlyHint of true', () => {
    expect(scopeOfTool(true)).toBe(READ);
    expect(scopeOfTool(false)).toBe(WRITE);
    expect(scopeOfTool(undefined)).toBe(WRITE);
  });
});

describe('requiredMcpScope', () => {
  const scopes = new Map([
    ['list_accounts', READ],
    ['create_account', WRITE],
  ]);
  const lookup = (name: string) => scopes.get(name);
  const call = (name: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } });

  it('needs only read for protocol methods that run no tool', () => {
    for (const method of ['initialize', 'tools/list', 'resources/read', 'prompts/get', 'ping']) {
      expect(requiredMcpScope({ jsonrpc: '2.0', id: 1, method }, lookup)).toBe(READ);
    }
    expect(requiredMcpScope({ jsonrpc: '2.0', method: 'notifications/initialized' }, lookup)).toBe(READ);
  });

  it('follows the called tool', () => {
    expect(requiredMcpScope(call('list_accounts'), lookup)).toBe(READ);
    expect(requiredMcpScope(call('create_account'), lookup)).toBe(WRITE);
  });

  it('fails closed on a tool it cannot place or a call it cannot read', () => {
    expect(requiredMcpScope(call('no_such_tool'), lookup)).toBe(WRITE);
    expect(requiredMcpScope(call(undefined), lookup)).toBe(WRITE);
    expect(requiredMcpScope({ jsonrpc: '2.0', id: 1, method: 'tools/call' }, lookup)).toBe(WRITE);
  });

  it('needs write when any message of a batch does', () => {
    expect(requiredMcpScope([call('list_accounts'), call('list_accounts')], lookup)).toBe(READ);
    expect(requiredMcpScope([call('list_accounts'), call('create_account')], lookup)).toBe(WRITE);
  });

  it('treats a body that is not JSON-RPC as running nothing', () => {
    for (const body of [undefined, null, 'x', 7, [], [null]]) {
      expect(requiredMcpScope(body, lookup)).toBe(READ);
    }
  });
});
