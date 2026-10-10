import type { accessTokens } from '../../diplomat/db/schema.js';

export type AccessTokenRow = typeof accessTokens.$inferSelect;
