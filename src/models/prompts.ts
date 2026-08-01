import { z } from 'zod';

/** Which statement kind the `import_statement` MCP prompt is walking the user through. */
export const ImportStatementSource = z.enum(['card', 'account']);
export type ImportStatementSource = z.infer<typeof ImportStatementSource>;
