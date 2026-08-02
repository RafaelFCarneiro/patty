import type { Result } from 'neverthrow';
import type { AppError } from '../../common/errors.js';

/** Shared MCP tool response helpers (ADR-025) — one implementation for every tool module. */

export const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

export const jsonError = (e: AppError) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: e }, null, 2) }],
  isError: true,
});

export const fromResult = <T>(result: Result<T, AppError>) => result.match(json, jsonError);

/** Shared by every static-URI JSON resource (`fintrack://openapi` and the Feature Design 018
 *  reference resources) — one `contents` entry, `application/json`, pretty-printed. */
export const jsonResource = (uri: URL, value: unknown) => ({
  contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
});
