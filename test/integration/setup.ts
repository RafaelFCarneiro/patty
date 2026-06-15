import type { StartedNeo4jContainer } from '@testcontainers/neo4j'
import { Neo4jContainer } from '@testcontainers/neo4j'
import type { TestProject } from 'vitest/node'

let container: StartedNeo4jContainer

export const setup = async (ctx: TestProject) => {
  container = await new Neo4jContainer('neo4j:5-community').start()
  ctx.provide('NEO4J_URI', container.getBoltUri())
  ctx.provide('NEO4J_PASSWORD', container.getPassword())
}

export const teardown = async () => {
  await container?.stop()
}
