import { ToolName } from '../tool-name.js';
import { getPreferences, setBaseCurrency, setLocale } from '../../../controllers/settings.js';
import { getStatus } from '../../../controllers/status.js';
import { Locale, LocaleSource } from '../../../models/locale.js';
import { CurrencyCode } from '../../../models/money.js';
import * as settingsAdapters from '../../../adapters/settings.js';
import { defineTool } from '../definition.js';
import { fromResult, json } from '../respond.js';
import { MUTATING, READ_ONLY } from '../annotations.js';

const setLocaleDescription =
  'Set the display language for default categories (en/es/pt). The AI agent should call this ' +
  'when it detects the user\'s language from conversation — use source "inferred". ' +
  'When the user explicitly requests a locale change, use source "explicit". ' +
  'GUARDRAILS: (1) Anti-churn — only switch on a clear, sustained language change, not on ' +
  'isolated foreign words, merchant names, or proper nouns. (2) Respect explicit — if the ' +
  'current locale_source is "explicit", do not auto-switch with source "inferred"; the user ' +
  'must explicitly request the change. Use get_preferences to check the current locale and source.';

const setLocaleTool = defineTool({
  name: ToolName.enum.set_locale,
  config: {
    annotations: MUTATING,
    title: 'Set locale',
    description: setLocaleDescription,
    inputSchema: {
      locale: Locale,
      source: LocaleSource.exclude([LocaleSource.enum.default]),
    },
  },
  handle: async (args, { deps, runEffects, resetLocale }) => {
    const flow = () => setLocale(deps, args).map(settingsAdapters.outcomeToDb);
    const result = await runEffects(flow);
    if (result.isOk()) resetLocale();
    return fromResult(result);
  },
});

const getPreferencesDescription =
  'Returns the stored locale preference, locale_source, and the resolved base currency. Use this to ' +
  'check whether the user set the locale explicitly before attempting an inferred switch. Note: the ' +
  'FINTRACK_LOCALE env var can override the effective display locale used by list_categories; ' +
  'this tool reports the stored preference, not the effective override. base_currency is either an ' +
  'explicit override (set_base_currency) or derived from locale (pt→BRL, en/es→USD) when unset.';

const getPreferencesTool = defineTool({
  name: ToolName.enum.get_preferences,
  config: {
    annotations: READ_ONLY,
    title: 'Get user preferences',
    description: getPreferencesDescription,
    inputSchema: {},
  },
  handle: async (_args, { deps }) => {
    return json(await getPreferences(deps));
  },
});

const setBaseCurrencyDescription =
  'Set the explicit base currency — the default target for future read-time valuation (ADR-026). ' +
  "Unset, it's derived from locale (pt→BRL, en/es→USD); this tool overrides that derivation. " +
  'Use get_preferences to check the currently resolved value.';

const setBaseCurrencyTool = defineTool({
  name: ToolName.enum.set_base_currency,
  config: {
    annotations: MUTATING,
    title: 'Set base currency',
    description: setBaseCurrencyDescription,
    inputSchema: { baseCurrency: CurrencyCode },
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => setBaseCurrency(deps, args).map(settingsAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const getStatusDescription =
  'Returns server name, version, database reachability, and active locale. ' +
  'A convenience for tool-only callers (the AI agent / chat user) — complements the ' +
  'protocol-native initialize serverInfo (version) and ping (liveness), which are not ' +
  'accessible via tools.';

const getStatusTool = defineTool({
  name: ToolName.enum.get_status,
  config: {
    annotations: READ_ONLY,
    title: 'Get server status',
    description: getStatusDescription,
    inputSchema: {},
  },
  handle: async (_args, { deps }, { version }) => json(await getStatus(deps, version)),
});

export const systemTools = [setLocaleTool, getPreferencesTool, setBaseCurrencyTool, getStatusTool];
