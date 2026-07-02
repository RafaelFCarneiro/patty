import { describe, expect, it } from 'vitest';
import { findHtmlValidationIssues } from '../../../src/logic/dashboard.js';

describe('findHtmlValidationIssues', () => {
  it('accepts a well-formed data-less shell with an inline script', () => {
    const html = '<!doctype html><html><body><script>fetch("/api/summary");</script></body></html>';
    expect(findHtmlValidationIssues(html)).toEqual([]);
  });

  it('rejects an empty string', () => {
    expect(findHtmlValidationIssues('')).toContain('html must contain a <!doctype html> or <html> root element');
  });

  it('rejects plain text with no html root element', () => {
    const issues = findHtmlValidationIssues('just some text, not a dashboard');
    expect(issues).toContain('html must contain a <!doctype html> or <html> root element');
  });

  it('accepts an <html> root without a doctype', () => {
    expect(findHtmlValidationIssues('<html><body>ok</body></html>')).toEqual([]);
  });

  it('rejects a broken inline <script>', () => {
    const html = '<!doctype html><html><body><script>function( { broken</script></body></html>';
    const issues = findHtmlValidationIssues(html);
    expect(issues.some((issue) => issue.includes('syntax error'))).toBe(true);
  });

  it('reports both an invalid root and a broken script together', () => {
    const issues = findHtmlValidationIssues('<script>{{{</script>');
    expect(issues).toHaveLength(2);
  });

  it('ignores external <script src="..."> tags (no inline body to check)', () => {
    const html =
      '<!doctype html><html><body>' +
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>' +
      '</body></html>';
    expect(findHtmlValidationIssues(html)).toEqual([]);
  });

  it('ignores script types that are not classic-script syntax (JSON-LD, import maps, modules)', () => {
    const html =
      '<!doctype html><html><body>' +
      '<script type="application/ld+json">{ this is not valid JS, but that is fine }</script>' +
      '</body></html>';
    expect(findHtmlValidationIssues(html)).toEqual([]);
  });

  it('still validates an inline script carrying a custom data-src attribute (not the real src)', () => {
    const html =
      '<!doctype html><html><body>' +
      '<script data-src="not-a-real-src">function( { broken</script>' +
      '</body></html>';
    const issues = findHtmlValidationIssues(html);
    expect(issues.some((issue) => issue.includes('syntax error'))).toBe(true);
  });

  it('recognizes a skipped script type even with MIME parameters and stray whitespace', () => {
    const html =
      '<!doctype html><html><body>' +
      '<script type=" application/json; charset=utf-8 ">{ this is not valid JS, but that is fine }</script>' +
      '</body></html>';
    expect(findHtmlValidationIssues(html)).toEqual([]);
  });

  it('recognizes an unquoted type=module attribute (valid HTML) and skips module-only syntax', () => {
    const html =
      '<!doctype html><html><body>' +
      '<script type=module>import { render } from "/chart.js"; render();</script>' +
      '</body></html>';
    expect(findHtmlValidationIssues(html)).toEqual([]);
  });

  it('still validates a classic inline script with an unquoted type attribute', () => {
    const html = '<!doctype html><html><body><script type=text/javascript>function( { broken</script></body></html>';
    const issues = findHtmlValidationIssues(html);
    expect(issues.some((issue) => issue.includes('syntax error'))).toBe(true);
  });

  it('recognizes a skipped type regardless of the attribute name’s casing', () => {
    const html =
      '<!doctype html><html><body>' +
      '<script TYPE="module">import { render } from "/chart.js";</script>' +
      '</body></html>';
    expect(findHtmlValidationIssues(html)).toEqual([]);
  });

  it('uses the first type attribute when duplicated, matching how browsers parse attributes', () => {
    const html =
      '<!doctype html><html><body>' +
      '<script type="module" type="text/javascript">import { render } from "/chart.js";</script>' +
      '</body></html>';
    expect(findHtmlValidationIssues(html)).toEqual([]);
  });

  it('still validates a classic inline script carrying a custom data-type attribute (not the real type)', () => {
    const html =
      '<!doctype html><html><body>' + '<script data-type="module">function( { broken</script>' + '</body></html>';
    const issues = findHtmlValidationIssues(html);
    expect(issues.some((issue) => issue.includes('syntax error'))).toBe(true);
  });

  it('treats the first literal "</script>" as the tag end, matching real browser parsing', () => {
    // An unescaped "</script>" inside a JS string breaks out of the element in real browsers too
    // — this is why such literals must be authored as "<\/script>". The validator mirrors that
    // boundary: it stops extracting the body at the same point a browser's HTML parser would, so
    // an unescaped occurrence surfaces as a syntax error (an unterminated string here) instead of
    // being silently missed.
    const html = '<!doctype html><html><body><script>var s = "</script></body></html>';
    const issues = findHtmlValidationIssues(html);
    expect(issues.some((issue) => issue.includes('syntax error'))).toBe(true);
  });

  it('rejects a doctype that appears after other content instead of at the start', () => {
    // A doctype only does anything as the very first thing in the document — browsers ignore one
    // that shows up later, so a stray "<!doctype html>" substring elsewhere in the text (with no
    // real <html> tag anywhere) must not count as HTML-shaped.
    const issues = findHtmlValidationIssues('some preamble text <!doctype html> and more text after');
    expect(issues).toContain('html must contain a <!doctype html> or <html> root element');
  });

  it('accepts a doctype preceded only by leading whitespace', () => {
    expect(findHtmlValidationIssues('\n  <!doctype html><html></html>')).toEqual([]);
  });

  it('does not let a > inside a quoted attribute value prematurely close the <script> tag', () => {
    // A naive [^>]* attribute matcher would stop at the ">" inside "a>b", splitting this single
    // tag into a bogus "closed" tag plus garbage "body" text that fails to compile as JS — even
    // though the actual script content (a plain fetch call) is completely valid.
    const html =
      '<!doctype html><html><body><script data-note="a>b" type="text/javascript">' +
      'fetch("/api/summary");' +
      '</script></body></html>';
    expect(findHtmlValidationIssues(html)).toEqual([]);
  });
});
