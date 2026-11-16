import { applyEdits, modify, parse, ParseErrorCode, type FormattingOptions, type ParseError } from 'jsonc-parser';
import { resolveConfigObject } from './merge.js';

// ---------------------------------------------------------------------------
// Pure JSONC editing of OpenCode's configuration (testable without FS)
// ---------------------------------------------------------------------------

/** The V2 layout keeps servers at `mcp.servers.<name>`. */
const MCP_KEY = 'mcp';
const SERVERS_KEY = 'servers';
const SERVERS_PATH = [MCP_KEY, SERVERS_KEY] as const;

const BYTE_ORDER_MARK = '\uFEFF';

const FORMATTING: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };

const EMPTY_DOCUMENT = '{}';

export const OPENCODE_V1_LAYOUT_MESSAGE =
  'is in OpenCode\'s V1 layout (servers directly under "mcp") — migrate it first (see "Migrate from V1" at ' +
  'https://opencode.ai/docs/mcp-servers), then run setup again — left unchanged';

export const OPENCODE_UNUSABLE_MESSAGE =
  'does not contain a JSON object at the root, or is not valid JSON/JSONC — left unchanged';

const OPENCODE_SERVERS_NOT_OBJECT_MESSAGE = 'has an "mcp" or "mcp.servers" that is not an object — left unchanged';

/** What the file's `mcp` key says about its layout. */
export const McpLayout = {
  /** No `mcp` key, or an empty one: the V2 shape is created. */
  fresh: 'fresh',
  v2: 'v2',
  v1: 'v1',
  /** `mcp` or `mcp.servers` exists but is not an object. */
  malformed: 'malformed',
} as const;
export type McpLayout = (typeof McpLayout)[keyof typeof McpLayout];

export type JsoncDocument = { text: string; root: Record<string, unknown> };

/** Parses JSONC (comments and trailing commas allowed); `null` for anything that is not an object at the root. */
export const parseDocument = (text: string): JsoncDocument | null => {
  const unmarked = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
  const errors: ParseError[] = [];
  const value = parse(unmarked, errors, { allowTrailingComma: true });
  // Nothing but whitespace or comments is "no value yet": the comments stay, an empty object follows them.
  const isBlank = value === undefined && errors.every(({ error }) => error === ParseErrorCode.ValueExpected);
  if (errors.length > 0 && !isBlank) return null;
  if (isBlank) return { text: `${unmarked.trimEnd()}\n${EMPTY_DOCUMENT}`.trimStart(), root: {} };
  const root = resolveConfigObject(value);
  return root === null ? null : { text: unmarked, root };
};

export const detectLayout = (root: Record<string, unknown>): McpLayout => {
  const mcp = root[MCP_KEY];
  if (mcp === undefined) return McpLayout.fresh;
  const section = resolveConfigObject(mcp);
  if (section === null) return McpLayout.malformed;
  if (!(SERVERS_KEY in section)) return Object.keys(section).length === 0 ? McpLayout.fresh : McpLayout.v1;
  return resolveConfigObject(section[SERVERS_KEY]) === null ? McpLayout.malformed : McpLayout.v2;
};

/** Why a layout cannot be edited; `null` when it can. */
export const layoutRefusal = (layout: McpLayout): string | null =>
  layout === McpLayout.v1
    ? OPENCODE_V1_LAYOUT_MESSAGE
    : layout === McpLayout.malformed
      ? OPENCODE_SERVERS_NOT_OBJECT_MESSAGE
      : null;

const editAt = (text: string, name: string, value: unknown): string =>
  applyEdits(text, modify(text, [...SERVERS_PATH, name], value, { formattingOptions: FORMATTING }));

/** The document with `mcp.servers.<name>` set to `entry`; comments, other keys and formatting stay as they were. */
export const withServerText = (text: string, name: string, entry: Record<string, unknown>): string =>
  editAt(text, name, entry);

/** The document without `mcp.servers.<name>`, or `null` when there is no such entry. */
export const withoutServerText = (document: JsoncDocument, name: string): string | null => {
  const servers = resolveConfigObject(resolveConfigObject(document.root[MCP_KEY])?.[SERVERS_KEY]);
  return servers !== null && name in servers ? editAt(document.text, name, undefined) : null;
};
