import { describe, expect, it } from 'vitest';
import { findHtmlValidationIssues } from '../../../src/logic/dashboard.js';

const FRAGMENT_ROOT_ISSUE =
  'content must be a fragment (sections + script) — remove the <!doctype>/<html> root; ' +
  'the shell (GET /ui) now provides it';

describe('findHtmlValidationIssues', () => {
  it('accepts a well-formed data-less fragment with an inline script', () => {
    const html = '<section><script>fetch("/api/summary");</script></section>';
    expect(findHtmlValidationIssues(html)).toEqual([]);
  });

  it('rejects an empty string', () => {
    expect(findHtmlValidationIssues('')).toContain('content must not be empty');
  });

  it('rejects a string that is only whitespace', () => {
    expect(findHtmlValidationIssues('   \n  ')).toContain('content must not be empty');
  });

  it('accepts plain text with no markup at all (not a structural fragment validator)', () => {
    expect(findHtmlValidationIssues('just some text, not a dashboard')).toEqual([]);
  });

  it('rejects an <html> root, even without a doctype — the shell now owns that root', () => {
    expect(findHtmlValidationIssues('<html><body>ok</body></html>')).toContain(FRAGMENT_ROOT_ISSUE);
  });

  it('rejects a broken inline <script>', () => {
    const html = '<script>function( { broken</script>';
    const issues = findHtmlValidationIssues(html);
    expect(issues.some((issue) => issue.includes('syntax error'))).toBe(true);
  });

  it('reports both a stray document root and a broken script together', () => {
    const issues = findHtmlValidationIssues('<!doctype html><html><script>{{{</script></html>');
    expect(issues).toHaveLength(2);
  });

  it('rejects an external <script src="..."> tag — fragments carry zero external references now', () => {
    const html = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>';
    const issues = findHtmlValidationIssues(html);
    expect(issues.some((issue) => issue.includes('no external <script src>'))).toBe(true);
  });

  it('does not also run a syntax check on a rejected external script (no inline body to check)', () => {
    const html = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>';
    expect(findHtmlValidationIssues(html)).toHaveLength(1);
  });

  it('ignores script types that are not classic-script syntax (JSON-LD, import maps, modules)', () => {
    const html = '<script type="application/ld+json">{ this is not valid JS, but that is fine }</script>';
    expect(findHtmlValidationIssues(html)).toEqual([]);
  });

  it('still validates an inline script carrying a custom data-src attribute (not the real src)', () => {
    const html = '<script data-src="not-a-real-src">function( { broken</script>';
    const issues = findHtmlValidationIssues(html);
    expect(issues.some((issue) => issue.includes('syntax error'))).toBe(true);
  });

  it('recognizes a skipped script type even with MIME parameters and stray whitespace', () => {
    const html = '<script type=" application/json; charset=utf-8 ">{ this is not valid JS, but that is fine }</script>';
    expect(findHtmlValidationIssues(html)).toEqual([]);
  });

  it('recognizes an unquoted type=module attribute (valid HTML) and skips module-only syntax', () => {
    const html = '<script type=module>import { render } from "/chart.js"; render();</script>';
    expect(findHtmlValidationIssues(html)).toEqual([]);
  });

  it('still validates a classic inline script with an unquoted type attribute', () => {
    const html = '<script type=text/javascript>function( { broken</script>';
    const issues = findHtmlValidationIssues(html);
    expect(issues.some((issue) => issue.includes('syntax error'))).toBe(true);
  });

  it('recognizes a skipped type regardless of the attribute name’s casing', () => {
    const html = '<script TYPE="module">import { render } from "/chart.js";</script>';
    expect(findHtmlValidationIssues(html)).toEqual([]);
  });

  it('uses the first type attribute when duplicated, matching how browsers parse attributes', () => {
    const html = '<script type="module" type="text/javascript">import { render } from "/chart.js";</script>';
    expect(findHtmlValidationIssues(html)).toEqual([]);
  });

  it('still validates a classic inline script carrying a custom data-type attribute (not the real type)', () => {
    const html = '<script data-type="module">function( { broken</script>';
    const issues = findHtmlValidationIssues(html);
    expect(issues.some((issue) => issue.includes('syntax error'))).toBe(true);
  });

  it('treats the first literal "</script>" as the tag end, matching real browser parsing', () => {
    // An unescaped "</script>" inside a JS string breaks out of the element in real browsers too
    // — this is why such literals must be authored as "<\/script>". The validator mirrors that
    // boundary: it stops extracting the body at the same point a browser's HTML parser would, so
    // an unescaped occurrence surfaces as a syntax error (an unterminated string here) instead of
    // being silently missed.
    const html = '<script>var s = "</script>';
    const issues = findHtmlValidationIssues(html);
    expect(issues.some((issue) => issue.includes('syntax error'))).toBe(true);
  });

  it('does not flag a stray doctype-like substring that never leads the content as a real root', () => {
    // A doctype only does anything as the very first thing in the document — a substring further
    // in, with no real <html> tag anywhere, must not be mistaken for a document root that needs
    // rejecting.
    const issues = findHtmlValidationIssues('some preamble text <!doctype html> and more text after');
    expect(issues).toEqual([]);
  });

  it('rejects a doctype preceded only by leading whitespace', () => {
    expect(findHtmlValidationIssues('\n  <!doctype html><html></html>')).toContain(FRAGMENT_ROOT_ISSUE);
  });

  it('does not let a > inside a quoted attribute value prematurely close the <script> tag', () => {
    // A naive [^>]* attribute matcher would stop at the ">" inside "a>b", splitting this single
    // tag into a bogus "closed" tag plus garbage "body" text that fails to compile as JS — even
    // though the actual script content (a plain fetch call) is completely valid.
    const html = '<script data-note="a>b" type="text/javascript">fetch("/api/summary");</script>';
    expect(findHtmlValidationIssues(html)).toEqual([]);
  });

  it('does not treat a "src=" substring inside another attribute\'s quoted value as the real src', () => {
    // Scanning for "src=" against the raw, unparsed attribute-list string (rather than tokenizing
    // attributes one at a time) would find this substring inside data-note's value and wrongly
    // treat the script as external, skipping the syntax check on a body that is actually broken.
    const html = '<script data-note="foo src=bar">function( { broken</script>';
    const issues = findHtmlValidationIssues(html);
    expect(issues.some((issue) => issue.includes('syntax error'))).toBe(true);
  });

  it('does not treat a "type=" substring inside another attribute\'s quoted value as the real type', () => {
    const html = '<script data-note=" type=module ">function( { broken</script>';
    const issues = findHtmlValidationIssues(html);
    expect(issues.some((issue) => issue.includes('syntax error'))).toBe(true);
  });
});
