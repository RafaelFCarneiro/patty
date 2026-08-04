import { Script as VmScript } from 'node:vm';
import * as R from 'remeda';

/**
 * Cheap, non-sanitizing render-ability checks (ADR-013, revised by ADR-027 Phase 1 for the
 * fragment content model): catches an empty save, a save that's still a full page instead of a
 * fragment, an external `<script src>` reference (fragments carry zero external references now —
 * the shell already loads Chart.js once, see `skills/dashboard-building/SKILL.md` hard rule #4),
 * or an inline `<script>` syntax error that would silently break every fetch with no visible
 * error — not a full HTML validator or sanitizer (deliberately out of scope for this local
 * single-user app, see ADR-013 Phase A).
 */
export const findHtmlValidationIssues = (html: string): string[] => [
  ...(isNonEmptyContent(html) ? [] : ['content must not be empty']),
  ...(hasHtmlDocumentRoot(html)
    ? ['content must be a fragment (sections + script) — remove the <!doctype>/<html> root; the shell (GET /ui) now provides it']
    : []),
  ...findExternalScriptIssues(html),
  ...findScriptSyntaxIssues(html),
];

const isNonEmptyContent = (html: string): boolean => html.trim().length > 0;

// The doctype only does anything if it's the very first thing in the document (leading whitespace
// aside) — browsers ignore one that shows up after other content, so require it to start at
// position 0 here too, rather than merely appearing anywhere in the string.
const HTML_DOCUMENT_ROOT_PATTERN = /^\s*<!doctype html|<html[\s>]/i;

const hasHtmlDocumentRoot = (html: string): boolean => HTML_DOCUMENT_ROOT_PATTERN.test(html);

// Types this checker can't validate as classic-script syntax, for two different reasons:
// `application/json`/`application/ld+json`/`importmap` are genuinely inert data, not code, so
// checking them as JS would misreport valid data as a syntax error; `module` IS executed by the
// browser, but as an ES module (different grammar — e.g. top-level `import`/`export` — than the
// classic-script goal `vm.Script` parses), so checking it here would misreport valid module
// syntax as broken. Either way, this checker has nothing useful to say about the script.
const SKIPPED_SCRIPT_TYPES = ['application/json', 'application/ld+json', 'importmap', 'module'];

// The attribute list uses a quote-aware repetition instead of a bare `[^>]*` so that a `>`
// character inside a quoted attribute value (legal HTML, e.g. `aria-label=">"`) doesn't prematurely
// close the tag — each iteration consumes either one non-quote, non-`>` character, or an entire
// quoted string (any content, `>` included), so only a real unquoted `>` ends the attribute list.
const SCRIPT_TAG_PATTERN = /<script((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script>/gi;

// Matches one HTML attribute at a time: a name, optionally followed by `=` and a double-quoted,
// single-quoted, or unquoted value. Scanning attribute-by-attribute (rather than testing a
// name= pattern against the raw, unparsed attribute-list string) is what makes this safe against
// a `src=`/`type=`-shaped substring appearing *inside* another attribute's quoted value (e.g.
// `data-note="foo src=bar"`) — the whole quoted value is consumed as this one attribute's value,
// so its contents are never re-scanned as if they were separate attributes. Attribute names here
// are scoped to the practical case (letter start, then word/hyphen/colon/dot) — this is still the
// cheap render-ability check ADR-013 describes, not a spec-complete HTML5 attribute tokenizer.
const ATTRIBUTE_PATTERN = /([a-zA-Z][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

type ScriptTag = { attributes: string; body: string };

const parseScriptTag = (match: RegExpMatchArray): ScriptTag => ({ attributes: match[1] ?? '', body: match[2] ?? '' });

// A MIME type may carry parameters (`application/json; charset=utf-8`) and stray whitespace —
// strip both before comparing, so a parameterized type still matches its base type.
const normalizeScriptType = (rawType: string): string => (rawType.split(';')[0] ?? '').trim().toLowerCase();

/** Boolean attributes (no `=value`) parse to `true`; real HTML keeps the first of a duplicate name. */
const parseAttributes = (attributes: string): Map<string, string | true> => {
  const result = new Map<string, string | true>();
  for (const [, name, doubleQuoted, singleQuoted, unquoted] of attributes.matchAll(ATTRIBUTE_PATTERN)) {
    if (!name) continue;
    const key = name.toLowerCase();
    if (result.has(key)) continue;
    result.set(key, doubleQuoted ?? singleQuoted ?? unquoted ?? true);
  }
  return result;
};

/** External (`src=`) tags have no inline body to check; skipped `type`s can't be classic-script-checked. */
const isCheckableInlineScript = (script: ScriptTag): boolean => {
  const attributes = parseAttributes(script.attributes);
  if (attributes.has('src')) return false;
  const rawType = attributes.get('type');
  const type = typeof rawType === 'string' ? normalizeScriptType(rawType) : undefined;
  return !type || !SKIPPED_SCRIPT_TYPES.includes(type);
};

const hasExternalSrc = (script: ScriptTag): boolean => parseAttributes(script.attributes).has('src');

const EXTERNAL_SCRIPT_ISSUE =
  'no external <script src> allowed in a fragment — the shell already loads Chart.js once; fetch data from /api instead';

// The shell (ui/app.js) executes every <script> tag a saved fragment carries once it's injected
// into the live page — rejecting an external src here, not just documenting it as a skill
// guideline, closes that off server-side instead of trusting every future caller of save_dashboard
// to follow the convention.
const findExternalScriptIssues = (html: string): string[] =>
  R.pipe(
    [...html.matchAll(SCRIPT_TAG_PATTERN)],
    R.map(parseScriptTag),
    R.filter(hasExternalSrc),
    R.map(R.constant(EXTERNAL_SCRIPT_ISSUE)),
  );

/** Compile-only (never executes the script) — just proves the browser could parse it. */
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
