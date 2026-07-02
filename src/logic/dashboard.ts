import vm from 'node:vm';
import * as R from 'remeda';

/**
 * Cheap, non-sanitizing render-ability checks (ADR-013): catches an empty/non-HTML save or a
 * `<script>` syntax error that would silently break every fetch on the page with no visible
 * error — not a full HTML validator or sanitizer (deliberately out of scope for this local
 * single-user app, see ADR-013 Phase A).
 */
export const findHtmlValidationIssues = (html: string): string[] => [
  ...(hasHtmlDocumentShape(html) ? [] : ['html must contain a <!doctype html> or <html> root element']),
  ...findScriptSyntaxIssues(html),
];

const HTML_DOCUMENT_ROOT_PATTERN = /<!doctype html|<html[\s>]/i;

const hasHtmlDocumentShape = (html: string): boolean => HTML_DOCUMENT_ROOT_PATTERN.test(html);

// Script types the browser treats as inert data rather than code to execute — checking their
// syntax as JavaScript would produce false positives (e.g. embedded JSON-LD, an import map).
const NON_EXECUTABLE_SCRIPT_TYPES = ['application/json', 'application/ld+json', 'importmap', 'module'];

const SCRIPT_TAG_PATTERN = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
const SCRIPT_TYPE_ATTRIBUTE_PATTERN = /type\s*=\s*["']([^"']+)["']/i;
const SCRIPT_SRC_ATTRIBUTE_PATTERN = /\bsrc\s*=/i;

type ScriptTag = { attributes: string; body: string };

const parseScriptTag = (match: RegExpMatchArray): ScriptTag => ({ attributes: match[1] ?? '', body: match[2] ?? '' });

/** External (`src=`) tags have no inline body to check; non-JS `type`s are inert data, not code. */
const isExecutableInlineScript = (script: ScriptTag): boolean => {
  if (SCRIPT_SRC_ATTRIBUTE_PATTERN.test(script.attributes)) return false;
  const type = script.attributes.match(SCRIPT_TYPE_ATTRIBUTE_PATTERN)?.[1]?.toLowerCase();
  return !type || !NON_EXECUTABLE_SCRIPT_TYPES.includes(type);
};

/** Compile-only (never executes the script) — just proves the browser could parse it. */
const findScriptSyntaxError = (script: ScriptTag): string | null => {
  try {
    new vm.Script(script.body);
    return null;
  } catch (error) {
    return `inline <script> has a syntax error: ${(error as Error).message}`;
  }
};

const findScriptSyntaxIssues = (html: string): string[] =>
  R.pipe(
    [...html.matchAll(SCRIPT_TAG_PATTERN)],
    R.map(parseScriptTag),
    R.filter(isExecutableInlineScript),
    R.map(findScriptSyntaxError),
    R.filter(R.isNonNull),
  );
