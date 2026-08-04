import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { CACHE_CONTROL_NO_CACHE } from '../respond.js';

// Resolved relative to this module's own file location (not process.cwd()) so it works
// identically under `tsx src/...` (dev) and `node dist/...` (published package) — same pattern as
// diplomat/db/bootstrap.ts's DEFAULT_MIGRATIONS_FOLDER. src/diplomat/http/routes/ui.ts and its
// compiled dist/diplomat/http/routes/ui.js are both 4 levels below the package root.
const UI_ROOT = fileURLToPath(new URL('../../../../ui', import.meta.url));

const SHELL_PATH = `${UI_ROOT}/shell.html`;
const APP_CSS_PATH = `${UI_ROOT}/app.css`;
const APP_JS_PATH = `${UI_ROOT}/app.js`;

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
const CSS_CONTENT_TYPE = 'text/css; charset=utf-8';
const JS_CONTENT_TYPE = 'text/javascript; charset=utf-8';

const serveUiFile = async (reply: FastifyReply, path: string, contentType: string): Promise<FastifyReply> => {
  const content = await readFile(path, 'utf-8');
  return reply.header('cache-control', CACHE_CONTROL_NO_CACHE).type(contentType).send(content);
};

/**
 * App shell (ADR-027 Phase 1). `GET /ui` and `GET /ui/:name` both serve the same shell —
 * `ui/app.js` resolves `:name` from the URL client-side, fetches the matching fragment
 * (`GET /api/dashboards/:name`, `routes/dashboard.ts`), and injects it into `#content`; the server
 * makes no existence check here, a missing dashboard becomes a client-side not-found state.
 * `/ui/assets/*` serves the shell's own static files. None of these are `RouteDefinition`s (no
 * OpenAPI entry) — a browser-facing HTML/asset surface, not part of the `/api` JSON contract,
 * mirroring how the dashboard HTML route worked before this module replaced it.
 */
export const registerUiRoutes = (app: FastifyInstance): void => {
  app.get('/ui', async (_req, reply) => serveUiFile(reply, SHELL_PATH, HTML_CONTENT_TYPE));
  app.get('/ui/:name', async (_req, reply) => serveUiFile(reply, SHELL_PATH, HTML_CONTENT_TYPE));
  app.get('/ui/assets/app.css', async (_req, reply) => serveUiFile(reply, APP_CSS_PATH, CSS_CONTENT_TYPE));
  app.get('/ui/assets/app.js', async (_req, reply) => serveUiFile(reply, APP_JS_PATH, JS_CONTENT_TYPE));
};
