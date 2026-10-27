import { describe, expect, it } from 'vitest';
import { databaseAheadMessage, databaseErrors } from '../../../src/models/database.js';
import { demoNotReady } from '../../../src/models/demo.js';
import { startupRefusalMessage } from '../../../src/models/startup.js';

describe('startupRefusalMessage', () => {
  it('words a database ahead of this build as the one shared message', () => {
    expect(startupRefusalMessage(databaseErrors.ahead('9.9.9'))).toBe(databaseAheadMessage('9.9.9'));
  });

  it('names the database a demo process refused, and how to create the demo', () => {
    const message = startupRefusalMessage(demoNotReady('/x/demo.db'));
    expect(message).toContain('FINTRACK_DEMO');
    expect(message).toContain('/x/demo.db');
    expect(message).toMatch(/demo$/);
  });
});
