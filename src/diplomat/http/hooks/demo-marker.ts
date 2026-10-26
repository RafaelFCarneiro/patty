import type { FastifyInstance } from 'fastify';
import { InstanceKind, isDemoInstance } from '../../../models/instance.js';
import { REPOSITORY_URL } from '../../../models/package.js';
import { escapeHtml } from '../auth-pages.js';
import { HTML_CONTENT_TYPE } from '../ui-files.js';

/** The attribute `ui/app.js` reads to keep `[Demo]` in the titles it sets after load. */
export const INSTANCE_KIND_ATTRIBUTE = 'data-instance-kind';
export const DEMO_TITLE_PREFIX = '[Demo] ';

const BANNER_LABEL = 'Demo';
const BANNER_MESSAGE = 'sample data, not your finances.';
const BANNER_LINK_TEXT = 'Install FinTrack for your own data';
const BANNER_LINK_URL = `${REPOSITORY_URL}#readme`;

// Classes live in ui/app.css: the auth pages' CSP allows `style-src 'self'` only, so no inline style can carry this.
const BANNER_HTML =
  '<div class="demo-banner" role="note">' +
  `<strong>${escapeHtml(BANNER_LABEL)}</strong> — ${escapeHtml(BANNER_MESSAGE)} ` +
  `<a href="${BANNER_LINK_URL}" target="_blank" rel="noopener noreferrer">${escapeHtml(BANNER_LINK_TEXT)}</a>` +
  '</div>';

const TITLE_OPEN = /<title>/;
const BODY_OPEN = /<body([^>]*)>/;

/** A full HTML document gets the banner as the first thing in `<body>` and `[Demo]` at the start of its title. A
 *  fragment (no `<body>`) is returned as is: the page that embeds it already carries both. */
export const markDemoPage = (html: string): string =>
  BODY_OPEN.test(html)
    ? html
        .replace(TITLE_OPEN, `<title>${DEMO_TITLE_PREFIX}`)
        .replace(BODY_OPEN, `<body$1 ${INSTANCE_KIND_ATTRIBUTE}="${InstanceKind.enum.demo}">${BANNER_HTML}`)
    : html;

const isHtmlDocument = (contentType: unknown, payload: unknown): payload is string =>
  typeof payload === 'string' && String(contentType ?? '').startsWith(HTML_CONTENT_TYPE.split(';')[0] ?? '');

/**
 * Marks every HTML page — the shell and the auth pages alike — when the database says it is a demo. The marker is
 * read from the database on each page, not from a path or an env var, so a demo database cannot be served without it.
 */
export const registerDemoMarkerHook = (app: FastifyInstance, instanceKind: () => Promise<InstanceKind>): void => {
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!isHtmlDocument(reply.getHeader('content-type'), payload)) return payload;
    return isDemoInstance(await instanceKind()) ? markDemoPage(payload) : payload;
  });
};
