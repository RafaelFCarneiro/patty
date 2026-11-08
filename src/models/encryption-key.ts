import { z } from 'zod';

export const EncryptionKey = z.string().regex(/^[0-9a-f]{64}$/i, 'must be a 64-character hex string');
