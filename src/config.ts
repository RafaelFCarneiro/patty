import { z } from 'zod'

const Env = z.object({
  DB_PATH: z.string().default('fintrack.db'),
  FINTRACK_DB_KEY: z.string().optional(),
  PORT: z.coerce.number().default(3001),
})

export type Config = z.infer<typeof Env>

export const loadConfig = (): Config => Env.parse(process.env)
