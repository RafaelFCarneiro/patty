import { z } from 'zod';

export const ServersKey = z.enum(['mcpServers', 'servers']);
export type ServersKey = z.infer<typeof ServersKey>;
