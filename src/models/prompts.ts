import { z } from 'zod';

/** Which statement kind the `import_statement` MCP prompt is walking the user through. */
export const ImportStatementSource = z.enum(['card', 'account']);
export type ImportStatementSource = z.infer<typeof ImportStatementSource>;

/** The guided-workflow MCP prompts the server registers (Feature Design 019). */
export const PromptName = z.enum(['monthly_review', 'budget_checkup', 'import_statement', 'tour']);
export type PromptName = z.infer<typeof PromptName>;
