import { applyEdits, modify, parse, ParseErrorCode, type ParseError } from 'jsonc-parser';
import { INVALID_ROOT_MESSAGE, LEFT_UNCHANGED } from '../../models/client-config.js';
import { McpLayout } from '../../wire/out/client-config.js';
import { resolveConfigObject } from './merge.js';

// ---------------------------------------------------------------------------
// Pure JSONC editing of OpenCode's configuration (testable without FS)
// ---------------------------------------------------------------------------

/** The V2 layout keeps servers at `mcp.servers.<name>`. */
const MCP_KEY = 'mcp';
const SERVERS_KEY = 'servers';
const SERVERS_PATH = [MCP_KEY, SERVERS_KEY] as const;

const BYTE_ORDER_MARK = '\uFEFF';

const EMPTY_DOCUMENT = '{}';

const CRLF = '\r\n';
const LF = '\n';

/** The document's own line ending: CRLF when it holds one, else LF. */
const lineEnding = (text: string): string => (text.includes(CRLF) ? CRLF : LF);

export const OPENCODE_V1_LAYOUT_MESSAGE =
  'is in OpenCode\'s V1 layout (servers directly under "mcp") — migrate it first (see "Migrate from V1" at ' +
  `https://opencode.ai/docs/mcp-servers), then run setup again${LEFT_UNCHANGED}`;

export const OPENCODE_UNUSABLE_MESSAGE = `${INVALID_ROOT_MESSAGE}, or is not valid JSON/JSONC${LEFT_UNCHANGED}`;

const OPENCODE_SERVERS_NOT_OBJECT_MESSAGE = `has an "mcp" or "mcp.servers" that is not an object${LEFT_UNCHANGED}`;

export type JsoncDocument = { text: string; root: Record<string, unknown> };

/** Parses JSONC (comments and trailing commas allowed); `null` for anything that is not an object at the root. */
export const parseDocument = (text: string): JsoncDocument | null => {
  const unmarked = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
  const errors: ParseError[] = [];
  const value = parse(unmarked, errors, { allowTrailingComma: true });
  // Nothing but whitespace or comments is "no value yet": the comments stay, an empty object follows them.
  const isBlank = value === undefined && errors.every(({ error }) => error === ParseErrorCode.ValueExpected);
  if (errors.length > 0 && !isBlank) return null;
  if (isBlank) return { text: `${unmarked.trimEnd()}${lineEnding(unmarked)}${EMPTY_DOCUMENT}`.trimStart(), root: {} };
  const root = resolveConfigObject(value);
  return root === null ? null : { text: unmarked, root };
};

/** A V1 server entry: an object saying how to start or reach the server. Global options (`timeout`, …) are not. */
const SERVER_ENTRY_KEYS = ['type', 'command', 'url'] as const;

const isLegacyServerEntry = (value: unknown): boolean => {
  const entry = resolveConfigObject(value);
  return entry !== null && SERVER_ENTRY_KEYS.some((key) => key in entry);
};

export const detectLayout = (root: Record<string, unknown>): McpLayout => {
  const mcp = root[MCP_KEY];
  if (mcp === undefined) return McpLayout.enum.fresh;
  const section = resolveConfigObject(mcp);
  if (section === null) return McpLayout.enum.malformed;
  if (!(SERVERS_KEY in section))
    return Object.values(section).some(isLegacyServerEntry) ? McpLayout.enum.v1 : McpLayout.enum.fresh;
  return resolveConfigObject(section[SERVERS_KEY]) === null ? McpLayout.enum.malformed : McpLayout.enum.v2;
};

const LAYOUT_REFUSALS = {
  [McpLayout.enum.fresh]: null,
  [McpLayout.enum.v2]: null,
  [McpLayout.enum.v1]: OPENCODE_V1_LAYOUT_MESSAGE,
  [McpLayout.enum.malformed]: OPENCODE_SERVERS_NOT_OBJECT_MESSAGE,
} as const satisfies Record<McpLayout, string | null>;

/** Why a layout cannot be edited; `null` when it can. */
export const layoutRefusal = (layout: McpLayout): string | null => LAYOUT_REFUSALS[layout];

const editAt = (text: string, name: string, value: unknown): string =>
  applyEdits(text, modify(text, [...SERVERS_PATH, name], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: lineEnding(text) },
    }));

/** The document with `mcp.servers.<name>` set to `entry`; comments, other keys and formatting stay as they were. */
export const withServerText = (text: string, name: string, entry: Record<string, unknown>): string =>
  editAt(text, name, entry);

/** The document without `mcp.servers.<name>`, or `null` when there is no such entry. */
export const withoutServerText = (document: JsoncDocument, name: string): string | null => {
  const servers = resolveConfigObject(resolveConfigObject(document.root[MCP_KEY])?.[SERVERS_KEY]);
  return servers !== null && name in servers ? editAt(document.text, name, undefined) : null;
};

/** The text ending in a line break, in the document's own style. */
export const withFinalNewline = (text: string): string => (text.endsWith(LF) ? text : `${text}${lineEnding(text)}`);
