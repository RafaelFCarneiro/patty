import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll } from 'vitest'
import { buildApp } from './app-builder.js'

const TEST_PORT = 3099

process.env['MCP_URL'] = `http://127.0.0.1:${TEST_PORT}/mcp`

let app: FastifyInstance | undefined

beforeAll(async () => {
  const ctx = await buildApp({ port: TEST_PORT })
  app = ctx.app
  await app.listen({ port: TEST_PORT, host: '127.0.0.1' })
})

afterAll(async () => {
  await app?.close()
})
