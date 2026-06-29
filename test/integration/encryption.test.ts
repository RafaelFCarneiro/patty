import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpTransport } from '../../src/config.js'
import { bootstrap } from '../../src/diplomat/db/bootstrap.js'
import { openDatabase } from '../../src/diplomat/db/driver.js'

const CORRECT_KEY = 'b'.repeat(64)
const WRONG_KEY = 'c'.repeat(64)

let tmpDir: string
let dbPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-enc-test-'))
  dbPath = join(tmpDir, 'enc.db')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('openDatabase directory creation', () => {
  it('creates nested parent directories that do not yet exist', async () => {
    const nestedPath = join(tmpDir, 'a', 'b', 'c', 'nested.db')
    const db = openDatabase({
      DB_PATH: nestedPath, FINTRACK_DB_KEY: CORRECT_KEY, PORT: 3001, MCP_TRANSPORT: McpTransport.enum.http,
    })
    await bootstrap(db)
  })
})

describe('encryption at rest', () => {
  it('opens and seeds the DB with the correct key', async () => {
    const db = openDatabase({
      DB_PATH: dbPath, FINTRACK_DB_KEY: CORRECT_KEY, PORT: 3001, MCP_TRANSPORT: McpTransport.enum.http,
    })
    await bootstrap(db)

    const rows = await db.query.currencies.findMany()
    expect(rows.length).toBeGreaterThan(0)
  })

  it('fails to open the DB with a wrong key', async () => {
    // Write an encrypted DB with the correct key
    const db = openDatabase({
      DB_PATH: dbPath, FINTRACK_DB_KEY: CORRECT_KEY, PORT: 3001, MCP_TRANSPORT: McpTransport.enum.http,
    })
    await bootstrap(db)

    // Attempt to open the same file with a different key — must throw (wrong key is never silently accepted)
    const wrongDb = openDatabase({
      DB_PATH: dbPath, FINTRACK_DB_KEY: WRONG_KEY, PORT: 3001, MCP_TRANSPORT: McpTransport.enum.http,
    })
    await expect(wrongDb.query.currencies.findMany()).rejects.toThrow()
  })
})
