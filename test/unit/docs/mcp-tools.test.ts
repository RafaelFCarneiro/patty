import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Tenancy } from '../../../src/controllers/deps.js';
import { ownerGate } from '../../../src/diplomat/mcp/gate.js';
import { toolScopesOf } from '../../../src/diplomat/mcp/scopes.js';
import { buildMcpServer } from '../../../src/diplomat/mcp/server.js';
import { READ_SCOPE, WRITE_SCOPE } from '../../../src/models/auth/scope.js';
import { ToolName } from '../../../src/diplomat/mcp/tool-name.js';

const DOC = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'mcp-tools.md'), 'utf8');

/** The tool names in one row of the "Scopes per tool" table, matched by the row's scope cell. */
const documentedIn = (scopeCell: string): string[] => {
  const row = DOC.split('\n').find((line) => line.startsWith(`| \`${scopeCell}\``)) ?? '';
  return [...row.matchAll(/`([a-z_]+)`/g)].map(([, name]) => name!).filter((name) => ToolName.safeParse(name).success);
};

describe('docs/mcp-tools.md', () => {
  const scopes = toolScopesOf(buildMcpServer({} as Tenancy, '0.0.0-test', { gate: ownerGate }));
  const registeredWith = (scope: string) => [...scopes].filter(([, s]) => s === scope).map(([name]) => name);

  it('lists every read tool in the read row and nothing else', () => {
    expect(documentedIn(READ_SCOPE).sort()).toEqual(registeredWith(READ_SCOPE).sort());
  });

  it('lists every write tool in the write row and nothing else', () => {
    expect(documentedIn(WRITE_SCOPE).sort()).toEqual(registeredWith(WRITE_SCOPE).sort());
  });

  it('documents every tool name', () => {
    ToolName.options.forEach((name) => expect(DOC, name).toContain(`\`${name}\``));
  });
});
