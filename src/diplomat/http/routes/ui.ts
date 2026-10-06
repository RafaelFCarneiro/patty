import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ChangeBus } from '@rfc0/effect-runner';
import { CACHE_CONTROL_NO_CACHE } from '../respond.js';

// Resolved relative to this module's own file location (not process.cwd()) so it works
// identically under `tsx src/...` (dev) and `node dist/...` (published package) — same pattern as
// diplomat/db/bootstrap.ts's DEFAULT_MIGRATIONS_FOLDER. src/diplomat/http/routes/ui.ts and its
// compiled dist/diplomat/http/routes/ui.js are both 4 levels below the package root.
const UI_ROOT = fileURLToPath(new URL('../../../../ui', import.meta.url));

const SHELL_PATH = `${UI_ROOT}/shell.html`;
const APP_CSS_PATH = `${UI_ROOT}/app.css`;
const APP_JS_PATH = `${UI_ROOT}/app.js`;
const MONEY_JS_PATH = `${UI_ROOT}/money.js`;

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
const CSS_CONTENT_TYPE = 'text/css; charset=utf-8';
const JS_CONTENT_TYPE = 'text/javascript; charset=utf-8';
const SSE_CONTENT_TYPE = 'text/event-stream; charset=utf-8';

// These four files are fixed package assets — never rewritten at runtime — so the first read of
// each is cached in memory for the life of the process; only a *successful* read is cached (never
// a rejected promise), so a transient read error doesn't wedge every later request into repeating
// the same failure. `cache-control: no-cache` below governs the browser's cache, not this one.
const fileContentCache = new Map<string, string>();

const readCached = async (path: string): Promise<string> => {
  const cached = fileContentCache.get(path);
  if (cached !== undefined) return cached;
  const content = await readFile(path, 'utf-8');
  fileContentCache.set(path, content);
  return content;
};

const serveUiFile = async (reply: FastifyReply, path: string, contentType: string): Promise<FastifyReply> => {
  const content = await readCached(path);
  return reply.header('cache-control', CACHE_CONTROL_NO_CACHE).type(contentType).send(content);
};

/**
 * Live update (ADR-027 Phase 3): the shell (`ui/app.js`) opens one long-lived `EventSource` here
 * for the life of the page; every message is `{"entities": [...]}` — the entity tags of a batch
 * that just committed, straight from the change bus's `subscribe` (`diplomat/db/effects.ts`'s
 * post-commit publish hook). `reply.hijack()` opts out of Fastify's own response lifecycle (its
 * automatic `send()`/timeout/hook handling assumes a response that ends promptly, which an SSE
 * stream deliberately never does) so this handler owns `reply.raw` until the client disconnects.
 * Not a `RouteDefinition` — same reasoning as the rest of this file: a browser-facing stream, not
 * part of the `/api` JSON contract.
 */
const registerUiEventsRoute = (app: FastifyInstance, subscribe: ChangeBus['subscribe']): void => {
  app.get('/ui/events', (_req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': SSE_CONTENT_TYPE,
      'cache-control': CACHE_CONTROL_NO_CACHE,
      connection: 'keep-alive',
    });
    // writeHead() alone only sets internal state — Node doesn't put headers on the wire until the
    // first write()/end() or an explicit flush, and a client with nothing yet to publish would
    // otherwise hang waiting for a response that was never actually sent.
    reply.raw.flushHeaders();

    const unsubscribe = subscribe((entities) => {
      // A publish can race a client disconnect that hasn't reached the 'close' handler below yet
      // — skip the write rather than push data onto a response that's already torn down.
      if (reply.raw.destroyed) return;
      reply.raw.write(`data: ${JSON.stringify({ entities })}\n\n`);
    });
    // reply.raw (not req.raw), matching the other hijacked route in this codebase
    // (diplomat/mcp/route.ts) — this handler owns the response after hijack(), and it's the
    // response's own lifecycle this cleanup is guarding.
    reply.raw.on('close', unsubscribe);
  });
};

/**
 * App shell (ADR-027 Phase 1). `GET /ui` and `GET /ui/:name` both serve the same shell —
 * `ui/app.js` resolves `:name` from the URL client-side, fetches the matching fragment
 * (`GET /api/dashboards/:name`, `routes/dashboard.ts`), and injects it into `#content`; the server
 * makes no existence check here, a missing dashboard becomes a client-side not-found state.
 * `/ui/assets/*` serves the shell's own static files. `GET /ui/events` is the live-update stream
 * (ADR-027 Phase 3, see `registerUiEventsRoute`). None of these are `RouteDefinition`s (no OpenAPI
 * entry) — a browser-facing HTML/asset/stream surface, not part of the `/api` JSON contract,
 * mirroring how the dashboard HTML route worked before this module replaced it.
 */
export const registerUiRoutes = (app: FastifyInstance, subscribeToChanges: ChangeBus['subscribe']): void => {
  app.get('/ui', async (_req, reply) => serveUiFile(reply, SHELL_PATH, HTML_CONTENT_TYPE));
  app.get('/ui/:name', async (_req, reply) => serveUiFile(reply, SHELL_PATH, HTML_CONTENT_TYPE));
  app.get('/ui/assets/app.css', async (_req, reply) => serveUiFile(reply, APP_CSS_PATH, CSS_CONTENT_TYPE));
  app.get('/ui/assets/app.js', async (_req, reply) => serveUiFile(reply, APP_JS_PATH, JS_CONTENT_TYPE));
  app.get('/ui/assets/money.js', async (_req, reply) => serveUiFile(reply, MONEY_JS_PATH, JS_CONTENT_TYPE));
  registerUiEventsRoute(app, subscribeToChanges);
};
