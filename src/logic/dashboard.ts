import { Script as VmScript } from 'node:vm';
import * as R from 'remeda';
import {
  HTML_DOCUMENT_ROOT_PATTERN,
  SKIPPED_SCRIPT_TYPES,
  SCRIPT_TAG_PATTERN,
  ATTRIBUTE_PATTERN,
  type ScriptTag,
  EXTERNAL_SCRIPT_ISSUE,
} from '../models/dashboard.js';

export const findHtmlValidationIssues = (html: string): string[] => [
  ...(isNonEmptyContent(html) ? [] : ['content must not be empty']),
  ...(hasHtmlDocumentRoot(html)
    ? [
        'content must be a fragment (sections + script) — remove the <!doctype>/<html> root; the shell (GET /ui) now provides it',
      ]
    : []),
  ...findExternalScriptIssues(html),
  ...findScriptSyntaxIssues(html),
];

const isNonEmptyContent = (html: string): boolean => html.trim().length > 0;

const hasHtmlDocumentRoot = (html: string): boolean => HTML_DOCUMENT_ROOT_PATTERN.test(html);

const parseScriptTag = (match: RegExpMatchArray): ScriptTag => ({ attributes: match[1] ?? '', body: match[2] ?? '' });

const normalizeScriptType = (rawType: string): string => (rawType.split(';')[0] ?? '').trim().toLowerCase();

const parseAttributes = (attributes: string): Map<string, string | true> => {
  return new Map(
    R.pipe(
      [...attributes.matchAll(ATTRIBUTE_PATTERN)],
      R.filter(([, name]) => !!name),
      R.map(
        ([, name, doubleQuoted, singleQuoted, unquoted]) =>
          [name!.toLowerCase(), (doubleQuoted ?? singleQuoted ?? unquoted ?? true) as string | true] as const,
      ),
      R.uniqueBy(([key]) => key),
    ),
  );
};

const isCheckableInlineScript = (script: ScriptTag): boolean => {
  const attributes = parseAttributes(script.attributes);
  if (attributes.has('src')) return false;
  const rawType = attributes.get('type');
  const type = typeof rawType === 'string' ? normalizeScriptType(rawType) : undefined;
  return !type || !SKIPPED_SCRIPT_TYPES.includes(type);
};

const hasExternalSrc = (script: ScriptTag): boolean => parseAttributes(script.attributes).has('src');

const findExternalScriptIssues = (html: string): string[] =>
  R.pipe(
    [...html.matchAll(SCRIPT_TAG_PATTERN)],
    R.map(parseScriptTag),
    R.filter(hasExternalSrc),
    R.map(R.constant(EXTERNAL_SCRIPT_ISSUE)),
  );

const findScriptSyntaxError = (script: ScriptTag): string | null => {
  try {
    new VmScript(script.body);
    return null;
  } catch (error) {
    return `inline <script> has a syntax error: ${(error as Error).message}`;
  }
};

const findScriptSyntaxIssues = (html: string): string[] =>
  R.pipe(
    [...html.matchAll(SCRIPT_TAG_PATTERN)],
    R.map(parseScriptTag),
    R.filter(isCheckableInlineScript),
    R.map(findScriptSyntaxError),
    R.filter(R.isNonNull),
  );
