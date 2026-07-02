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
});
