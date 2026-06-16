import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/diplomat/db/schema.ts',
  out: './drizzle',
})
