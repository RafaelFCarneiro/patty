import type { FastifyInstance } from 'fastify';
import type { Tenancy } from '../../../controllers/deps.js';
import { instanceFactsOf } from '../../../controllers/instance.js';
import { InstanceKind, isDemoInstance } from '../../../models/instance.js';
import { Locale } from '../../../models/locale.js';
import { REPOSITORY_URL } from '../../../models/package.js';
import { escapeHtml } from '../auth-pages.js';
import { HTML_CONTENT_TYPE } from '../ui-files.js';

/** The attribute `ui/app.js` reads to keep `[Demo]` in the titles it sets after load. */
export const INSTANCE_KIND_ATTRIBUTE = 'data-instance-kind';
export const DEMO_TITLE_PREFIX = '[Demo] ';

type BannerCopy = { label: string; message: string; linkText: string };

/** The banner in the demo's language (`user_settings.locale`, set by the seeder). */
export const DEMO_BANNER_COPY = {
  [Locale.enum.en]: {
    label: 'Demo',
    message: 'sample data, not your finances.',
    linkText: 'Install FinTrack for your own data',
  },
  [Locale.enum.pt]: {
    label: 'Demo',
    message: 'dados de exemplo, não as suas finanças.',
    linkText: 'Instale o FinTrack para usar seus próprios dados',
  },
  [Locale.enum.es]: {
    label: 'Demo',
    message: 'datos de ejemplo, no tus finanzas.',
    linkText: 'Instala FinTrack para usar tus propios datos',
  },
} as const satisfies Record<Locale, BannerCopy>;

const BANNER_LINK_URL = `${REPOSITORY_URL}#readme`;

// Classes live in ui/app.css: the auth pages' CSP allows `style-src 'self'` only, so no inline style can carry this.
const bannerHtml = (locale: Locale): string => {
  const { label, message, linkText } = DEMO_BANNER_COPY[locale];
  return (
    `<div class="demo-banner" role="note" lang="${locale}">` +
    `<strong>${escapeHtml(label)}</strong> — ${escapeHtml(message)} ` +
    `<a href="${BANNER_LINK_URL}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkText)}</a>` +
    '</div>'
  );
};

const TITLE_OPEN = /<title>/;
const BODY_OPEN = /<body([^>]*)>/;

/** A full HTML document gets the banner as the first thing in `<body>` and `[Demo]` at the start of its title. A
 *  fragment (no `<body>`) is returned as is: the page that embeds it already carries both. */
export const markDemoPage = (html: string, locale: Locale): string =>
  BODY_OPEN.test(html)
    ? html
        .replace(TITLE_OPEN, `<title>${DEMO_TITLE_PREFIX}`)
        .replace(BODY_OPEN, `<body$1 ${INSTANCE_KIND_ATTRIBUTE}="${InstanceKind.enum.demo}">${bannerHtml(locale)}`)
    : html;

const isHtmlDocument = (contentType: unknown, payload: unknown): payload is string =>
  typeof payload === 'string' && String(contentType ?? '').startsWith(HTML_CONTENT_TYPE.split(';')[0] ?? '');

/**
 * Marks every HTML page — the shell and the auth pages alike — when the database says it is a demo, in the language
 * the demo speaks. The marker is read from the database on each page, not from a path or an env var, so a demo
 * database cannot be served without it.
 */
export const registerDemoMarkerHook = (
  app: FastifyInstance,
  tenancy: Pick<Tenancy, 'instanceKind' | 'instanceLocale'>,
): void => {
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!isHtmlDocument(reply.getHeader('content-type'), payload)) return payload;
    const { kind, locale } = await instanceFactsOf(tenancy);
    return isDemoInstance(kind) ? markDemoPage(payload, locale) : payload;
  });
};
