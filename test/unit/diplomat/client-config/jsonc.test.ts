import { McpLayout } from '../../../../src/wire/out/client-config.js';
import { describe, expect, it } from 'vitest';
import {
  detectLayout,
  layoutRefusal,
  OPENCODE_V1_LAYOUT_MESSAGE,
  parseDocument,
  withFinalNewline,
  withoutServerText,
  withServerText,
} from '../../../../src/diplomat/client-config/jsonc.js';

describe('parseDocument', () => {
  it('reads comments and trailing commas', () => {
    expect(parseDocument('{ // c\n "a": 1, }')?.root).toEqual({ a: 1 });
  });
  it('treats blank text as an empty object', () => {
    expect(parseDocument('  \n')).toEqual({ text: '{}', root: {} });
  });
  it('ignores a leading byte-order mark', () => {
    expect(parseDocument('\uFEFF{"a":1}')).toEqual({ text: '{"a":1}', root: { a: 1 } });
  });
  it('keeps the comments of a file that holds nothing else, and adds an empty object after them', () => {
    expect(parseDocument('// hi\n')).toEqual({ text: '// hi\n{}', root: {} });
    expect(parseDocument('/* x */')).toEqual({ text: '/* x */\n{}', root: {} });
  });
  it.each(['{ nope', '[]', '"x"', '{} {}'])('refuses %j', (text) => {
    expect(parseDocument(text)).toBeNull();
  });
});

describe('detectLayout', () => {
  it.each([
    [{}, McpLayout.enum.fresh],
    [{ mcp: {} }, McpLayout.enum.fresh],
    [{ mcp: { servers: {} } }, McpLayout.enum.v2],
    [{ mcp: { other: { type: 'local' } } }, McpLayout.enum.v1],
    [{ mcp: { other: { command: ['x'] } } }, McpLayout.enum.v1],
    [{ mcp: { timeout: { startup: 45000 } } }, McpLayout.enum.fresh],
    [{ mcp: { timeout: { startup: 1 }, other: { type: 'remote', url: 'u' } } }, McpLayout.enum.v1],
    [{ mcp: { servers: [] } }, McpLayout.enum.malformed],
    [{ mcp: 'x' }, McpLayout.enum.malformed],
  ])('%j is %s', (root, layout) => {
    expect(detectLayout(root)).toBe(layout);
  });

  it('refuses only the layouts it cannot edit', () => {
    expect(layoutRefusal(McpLayout.enum.v1)).toBe(OPENCODE_V1_LAYOUT_MESSAGE);
    expect(layoutRefusal(McpLayout.enum.malformed)).not.toBeNull();
    expect(layoutRefusal(McpLayout.enum.fresh)).toBeNull();
    expect(layoutRefusal(McpLayout.enum.v2)).toBeNull();
  });
});

describe('withServerText / withoutServerText', () => {
  it('uses the document\'s own line ending', () => {
    const text = withServerText('{\r\n  "a": 1\r\n}\r\n', 'patty', { type: 'local' });
    expect(text).toContain('\r\n');
    expect(text).not.toMatch(/(?<!\r)\n/);
    expect(withFinalNewline('{}')).toBe('{}\n');
    expect(withFinalNewline('{\r\n}')).toBe('{\r\n}\r\n');
  });
  it('inserts into an empty document and removes again', () => {
    const text = withServerText('{}', 'patty', { type: 'local' });
    expect(parseDocument(text)?.root).toEqual({ mcp: { servers: { patty: { type: 'local' } } } });
    const document = parseDocument(text)!;
    expect(parseDocument(withoutServerText(document, 'patty')!)?.root).toEqual({ mcp: { servers: {} } });
  });
  it('replaces an existing entry in place', () => {
    const text = withServerText('{"mcp":{"servers":{"patty":{"a":1}}}}', 'patty', { b: 2 });
    expect(parseDocument(text)?.root).toEqual({ mcp: { servers: { patty: { b: 2 } } } });
  });
  it('returns null when there is nothing to remove', () => {
    expect(withoutServerText(parseDocument('{}')!, 'patty')).toBeNull();
  });
});
