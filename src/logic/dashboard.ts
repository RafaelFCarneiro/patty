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

// Types this checker can't validate as classic-script syntax, for two different reasons:
// `application/json`/`application/ld+json`/`importmap` are genuinely inert data, not code, so
// checking them as JS would misreport valid data as a syntax error; `module` IS executed by the
// browser, but as an ES module (different grammar — e.g. top-level `import`/`export` — than the
// classic-script goal `vm.Script` parses), so checking it here would misreport valid module
// syntax as broken. Either way, this checker has nothing useful to say about the script.
const SKIPPED_SCRIPT_TYPES = ['application/json', 'application/ld+json', 'importmap', 'module'];

const SCRIPT_TAG_PATTERN = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
// HTML attribute values may be double-quoted, single-quoted, or unquoted (e.g. `type=module` is
// valid HTML) — match all three forms, whichever one is present. `type` must start right after
// whitespace or the beginning of the attribute list, so `data-type=` isn't mistaken for the real
// `type` attribute (same boundary issue `SCRIPT_SRC_ATTRIBUTE_PATTERN` below guards against).
const SCRIPT_TYPE_ATTRIBUTE_PATTERN = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
// `\b` alone would also match inside `data-src=` (the `-` still counts as a word boundary before
// `src`) — require `src` to start right after whitespace or the start of the attribute list, so a
// custom `data-src` attribute doesn't get mistaken for the real `src` and skip validation.
const SCRIPT_SRC_ATTRIBUTE_PATTERN = /(?:^|\s)src\s*=/i;

type ScriptTag = { attributes: string; body: string };

const parseScriptTag = (match: RegExpMatchArray): ScriptTag => ({ attributes: match[1] ?? '', body: match[2] ?? '' });

// A MIME type may carry parameters (`application/json; charset=utf-8`) and stray whitespace —
// strip both before comparing, so a parameterized type still matches its base type.
const normalizeScriptType = (rawType: string): string => (rawType.split(';')[0] ?? '').trim().toLowerCase();

/** Whichever of the pattern's three quoting-style groups matched holds the value. */
const extractScriptType = (attributes: string): string | undefined => {
  const match = attributes.match(SCRIPT_TYPE_ATTRIBUTE_PATTERN);
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

/** External (`src=`) tags have no inline body to check; skipped `type`s can't be classic-script-checked. */
const isCheckableInlineScript = (script: ScriptTag): boolean => {
  if (SCRIPT_SRC_ATTRIBUTE_PATTERN.test(script.attributes)) return false;
  const rawType = extractScriptType(script.attributes);
  const type = rawType ? normalizeScriptType(rawType) : undefined;
  return !type || !SKIPPED_SCRIPT_TYPES.includes(type);
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
    R.filter(isCheckableInlineScript),
    R.map(findScriptSyntaxError),
    R.filter(R.isNonNull),
  );
