import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolName } from '../../../../src/diplomat/mcp/tool-name.js';

/**
 * Tool names are the MCP edge's vocabulary. Outside `src/diplomat/mcp` no string literal may name a tool — a domain
 * error carries a `Remedy` and the edge says it in its own words. Two exceptions: `models/remedy.ts`, whose enum values
 * are the domain's own names for the operations (which the MCP edge happens to share), and schema `.describe()` text,
 * which is published verbatim in `tools/list` / the OpenAPI document and so is frozen by the contract snapshots: a
 * literal is allowed only if a snapshot contains it.
 */
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const MCP_DIR = join('src', 'diplomat', 'mcp');

const sourceFiles = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });

const REMEDY_MODEL = join('src', 'models', 'remedy.ts');
const SNAPSHOTS = ['mcp/__snapshots__/surface.json', 'http/__snapshots__/openapi.json'];
// Re-serialized compactly, so a literal compares against the JSON-escaped text of the published schema.
const publishedText = SNAPSHOTS.map((path) =>
  JSON.stringify(JSON.parse(readFileSync(join(ROOT, 'test/unit/diplomat', path), 'utf8'))),
).join('\n');

// Only prose can be published schema text: a bare name is also in the snapshot (as a tool's `name`), so never counts.
const isPublishedText = (literal: string): boolean => {
  const text = literal.slice(1, -1);
  return /\s/.test(text) && publishedText.includes(JSON.stringify(text).slice(1, -1));
};

const NAMES = new RegExp(`\\b(?:${ToolName.options.join('|')})\\b`);
const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.)*`/g;
const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);

const offences = sourceFiles('src')
  .filter((file) => !file.startsWith(MCP_DIR) && file !== REMEDY_MODEL)
  .flatMap((file) =>
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        isComment(line)
          ? []
          : (line.match(LITERAL) ?? [])
              .filter((literal) => NAMES.test(literal))
              .filter((literal) => !isPublishedText(literal))
              .map((literal) => `${relative(ROOT, join(ROOT, file))}:${index + 1} ${literal}`),
      ),
  );

describe('edge vocabulary', () => {
  it('names no tool in a string literal outside src/diplomat/mcp (except frozen schema text)', () => {
    expect(offences).toEqual([]);
  });
});
