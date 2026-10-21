import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ChangeBus } from '@rfc0/effect-runner';
import { SHARED_ENTITY_TAGS, type ChangeEvent } from '../../../models/tenancy.js';
import { LOGOUT_PATH, TOKENS_PATH, UI_APP_CSS_PATH, UI_ROOT_PATH } from '../auth-paths.js';
import { authErrors } from '../../../models/auth/errors.js';
import { CACHE_CONTROL_NO_CACHE, replyError } from '../respond.js';
import { HTML_CONTENT_TYPE, readCached, UI_ROOT } from '../ui-files.js';

const SHELL_PATH = `${UI_ROOT}/shell.html`;
const APP_CSS_PATH = `${UI_ROOT}/app.css`;
const APP_JS_PATH = `${UI_ROOT}/app.js`;
const MONEY_JS_PATH = `${UI_ROOT}/money.js`;

const CSS_CONTENT_TYPE = 'text/css; charset=utf-8';
const JS_CONTENT_TYPE = 'text/javascript; charset=utf-8';
const SSE_CONTENT_TYPE = 'text/event-stream; charset=utf-8';
const SSE_SESSION_RECHECK_MS = 30_000;

// Where ui/shell.html reserves room for controls that only exist when sessions do (ADR-033).
const AUTH_CONTROLS_MARKER = '<!--fintrack:auth-controls-->';
const TOKENS_CONTROL =
  `<a href="${TOKENS_PATH}" class="sidebar-more-btn sidebar-tokens" aria-label="Access tokens" title="Access tokens">` +
  '<i class="fa-solid fa-key"></i></a>';
const LOGOUT_CONTROL =
  `<form method="post" action="${LOGOUT_PATH}" class="sidebar-logout">` +
  '<button type="submit" class="sidebar-more-btn" aria-label="Log out" title="Log out">' +
  '<i class="fa-solid fa-right-from-bracket"></i></button></form>';

const serveUiFile = async (reply: FastifyReply, path: string, contentType: string): Promise<FastifyReply> => {
  const content = await readCached(path);
  return reply.header('cache-control', CACHE_CONTROL_NO_CACHE).type(contentType).send(content);
};

type ChangeSubscribe = ChangeBus<ChangeEvent>['subscribe'];

// Own changes in full; another user's only where they are shared (userId null = bookkeeping, heard by no one).
const entitiesFor = (event: ChangeEvent, userId: string) => {
  if (event.userId === userId) return event.entities;
  return event.userId === null ? [] : event.entities.filter((tag) => SHARED_ENTITY_TAGS.includes(tag));
};

const openEventStream = (reply: FastifyReply): void => {
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
};

const forwardChanges = (reply: FastifyReply, subscribe: ChangeSubscribe, userId: string): void => {
  const unsubscribe = subscribe((event) => {
    const entities = entitiesFor(event, userId);
    if (entities.length === 0) return;
    // A publish can race a client disconnect that hasn't reached the 'close' handler below yet
    // — skip the write rather than push data onto a response that's already torn down.
    if (reply.raw.destroyed) return;
    reply.raw.write(`data: ${JSON.stringify({ entities })}\n\n`);
  });
  // reply.raw (not req.raw), matching the other hijacked route in this codebase
  // (diplomat/mcp/route.ts) — this handler owns the response after hijack(), and it's the
  // response's own lifecycle this cleanup is guarding.
  reply.raw.on('close', unsubscribe);
};

// With sessions on, the cookie was checked only when this stream opened. Logout, expiry or a disabled
// user must end it too, or it would keep delivering change notifications to someone no longer signed in.
const endWhenSessionLapses = (req: FastifyRequest, reply: FastifyReply, session: SessionRecheck): void => {
  const recheck = setInterval(() => {
    // Fail closed: a check that cannot be completed ends the stream rather than leaving it authorized.
    void session
      .isActive(req)
      .catch(() => false)
      .then((active) => {
        if (!active) reply.raw.end();
      });
  }, session.everyMs ?? SSE_SESSION_RECHECK_MS);
  recheck.unref();
  reply.raw.on('close', () => clearInterval(recheck));
};

/**
 * Live update (ADR-027 Phase 3): the shell (`ui/app.js`) opens one long-lived `EventSource` here
 * for the life of the page; every message is `{"entities": [...]}` — the entity tags of a batch
 * that just committed, straight from the change bus's `subscribe` (`@rfc0/effect-runner`'s
 * post-commit publish hook). `reply.hijack()` opts out of Fastify's own response lifecycle (its
 * automatic `send()`/timeout/hook handling assumes a response that ends promptly, which an SSE
 * stream deliberately never does) so this handler owns `reply.raw` until the client disconnects.
 * Not a `RouteDefinition` — same reasoning as the rest of this file: a browser-facing stream, not
 * part of the `/api` JSON contract.
 */
const registerUiEventsRoute = (app: FastifyInstance, subscribe: ChangeSubscribe, session?: SessionRecheck): void => {
  app.get(`${UI_ROOT_PATH}/events`, (req, reply) => {
    // Without a principal, open no stream rather than everyone's events.
    const userId = req.principal?.userId;
    if (userId === undefined) return replyError(reply, authErrors.unauthenticated);
    openEventStream(reply);
    forwardChanges(reply, subscribe, userId);
    if (session) endWhenSessionLapses(req, reply, session);
    return undefined;
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
export type SessionRecheck = { isActive: (req: FastifyRequest) => Promise<boolean>; everyMs?: number };

export const registerUiRoutes = (
  app: FastifyInstance,
  subscribeToChanges: ChangeBus<ChangeEvent>['subscribe'],
  options: { authControls: boolean; session?: SessionRecheck } = { authControls: false },
): void => {
  const serveShell = async (_req: unknown, reply: FastifyReply) => {
    const shell = await readCached(SHELL_PATH);
    const html = shell.replace(AUTH_CONTROLS_MARKER, options.authControls ? `${TOKENS_CONTROL}${LOGOUT_CONTROL}` : '');
    return reply.header('cache-control', CACHE_CONTROL_NO_CACHE).type(HTML_CONTENT_TYPE).send(html);
  };
  app.get(UI_ROOT_PATH, serveShell);
  app.get(`${UI_ROOT_PATH}/:name`, serveShell);
  app.get(UI_APP_CSS_PATH, async (_req, reply) => serveUiFile(reply, APP_CSS_PATH, CSS_CONTENT_TYPE));
  app.get(`${UI_ROOT_PATH}/assets/app.js`, async (_req, reply) => serveUiFile(reply, APP_JS_PATH, JS_CONTENT_TYPE));
  app.get(`${UI_ROOT_PATH}/assets/money.js`, async (_req, reply) => serveUiFile(reply, MONEY_JS_PATH, JS_CONTENT_TYPE));
  registerUiEventsRoute(app, subscribeToChanges, options.session);
};
