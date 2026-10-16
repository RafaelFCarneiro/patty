import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getPreferences, setBaseCurrency, setLocale } from '../../../controllers/settings.js';
import { getStatus } from '../../../controllers/status.js';
import { Locale, LocaleSource } from '../../../models/locale.js';
import { CurrencyCode } from '../../../models/money.js';
import * as settingsAdapters from '../../../adapters/settings.js';
import type { McpContext } from '../context.js';
import { fromResult, json } from '../respond.js';
import { MUTATING, READ_ONLY } from '../annotations.js';

export const registerSystemTools = (server: McpServer, ctx: McpContext): void => {
  const { version } = ctx;

  server.registerTool(
    'set_locale',
    {
      annotations: MUTATING,
      title: 'Set locale',
      description:
        'Set the display language for default categories (en/es/pt). The AI agent should call this ' +
        'when it detects the user\'s language from conversation — use source "inferred". ' +
        'When the user explicitly requests a locale change, use source "explicit". ' +
        'GUARDRAILS: (1) Anti-churn — only switch on a clear, sustained language change, not on ' +
        'isolated foreign words, merchant names, or proper nouns. (2) Respect explicit — if the ' +
        'current locale_source is "explicit", do not auto-switch with source "inferred"; the user ' +
        'must explicitly request the change. Use get_preferences to check the current locale and source.',
      inputSchema: {
        locale: Locale,
        source: LocaleSource.exclude([LocaleSource.enum.default]),
      },
    },
    async (args, extra) => {
      const { deps, runEffects, resetLocale } = ctx.as(extra);
      const flow = () => setLocale(deps, args).map(settingsAdapters.outcomeToDb);
      const result = await runEffects(flow);
      if (result.isOk()) resetLocale();
      return fromResult(result);
    },
  );

  server.registerTool(
    'get_preferences',
    {
      annotations: READ_ONLY,
      title: 'Get user preferences',
      description:
        'Returns the stored locale preference, locale_source, and the resolved base currency. Use this to ' +
        'check whether the user set the locale explicitly before attempting an inferred switch. Note: the ' +
        'FINTRACK_LOCALE env var can override the effective display locale used by list_categories; ' +
        'this tool reports the stored preference, not the effective override. base_currency is either an ' +
        'explicit override (set_base_currency) or derived from locale (pt→BRL, en/es→USD) when unset.',
      inputSchema: {},
    },
    async (_args, extra) => {
      const { deps } = ctx.as(extra);
      return json(await getPreferences(deps));
    },
  );

  server.registerTool(
    'set_base_currency',
    {
      annotations: MUTATING,
      title: 'Set base currency',
      description:
        'Set the explicit base currency — the default target for future read-time valuation (ADR-026). ' +
        "Unset, it's derived from locale (pt→BRL, en/es→USD); this tool overrides that derivation. " +
        'Use get_preferences to check the currently resolved value.',
      inputSchema: { baseCurrency: CurrencyCode },
    },
    async (args, extra) => {
      const { deps, runEffects } = ctx.as(extra);
      const flow = () => setBaseCurrency(deps, args).map(settingsAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );

  server.registerTool(
    'get_status',
    {
      annotations: READ_ONLY,
      title: 'Get server status',
      description:
        'Returns server name, version, database reachability, and active locale. ' +
        'A convenience for tool-only callers (the AI agent / chat user) — complements the ' +
        'protocol-native initialize serverInfo (version) and ping (liveness), which are not ' +
        'accessible via tools.',
      inputSchema: {},
    },
    async (_args, extra) => {
      const { deps } = ctx.as(extra);
      return json(await getStatus(deps, version));
    },
  );
};
