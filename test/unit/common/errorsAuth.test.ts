import { describe, expect, it } from 'vitest';
import { formatAppError, httpStatus, type AppError } from '../../../src/common/errors.js';
import { AUTH_MESSAGES, authErrors } from '../../../src/models/auth.js';

describe('auth errors', () => {
  const CASES: Array<[AppError, number, string]> = [
    [authErrors.unauthenticated, 401, AUTH_MESSAGES.unauthenticated],
    [authErrors.invalidCredentials, 401, AUTH_MESSAGES.invalidCredentials],
    [authErrors.invalidSetupCode, 403, AUTH_MESSAGES.invalidSetupCode],
    [authErrors.setupUnavailable, 409, AUTH_MESSAGES.setupUnavailable],
    [authErrors.rateLimited, 429, AUTH_MESSAGES.rateLimited],
    [authErrors.crossOrigin, 403, AUTH_MESSAGES.crossOrigin],
    [authErrors.unknownOrigin, 403, AUTH_MESSAGES.crossOriginUnknownOrigin],
  ];

  it.each(CASES)('maps %j to HTTP %i', (error, status) => {
    expect(httpStatus(error)).toBe(status);
  });

  it.each(CASES)('formats %j with its message', (error, _status, message) => {
    expect(formatAppError(error)).toContain(message);
    expect(formatAppError(error)).toContain(error.code);
  });

  it('keeps the login failure generic — one message for every way a login can fail', () => {
    expect(AUTH_MESSAGES.invalidCredentials).toBe('Invalid username or password.');
  });
});
