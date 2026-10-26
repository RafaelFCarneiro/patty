/**
 * The one lazy loader of the HTTP surface: Fastify and the route table load only for a flow that serves (the stdio
 * sidecar, `demo`), never for a CLI command that does not.
 */
export const loadHttpModule = () => import('./http.js');
