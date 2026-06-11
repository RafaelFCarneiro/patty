import { z } from 'zod'

const Env = z.object({
  NEO4J_URI: z.string().default('bolt://localhost:7687'),
  NEO4J_USER: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string().default('fintrack123'),
  PORT: z.coerce.number().default(3001),
})

export type Config = z.infer<typeof Env>

export const loadConfig = (): Config => Env.parse(process.env)
