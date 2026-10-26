import { isDemoInstance, type InstanceFacts } from '../../models/instance.js';
import { Locale } from '../../models/locale.js';

export const MCP_SERVER_NAME = 'fintrack';

/** What a client is told when it connects to a demo database, in the demo's language. The `fintrack` server name is
 *  the real install's. */
export const DEMO_SERVER_INSTRUCTIONS = {
  [Locale.enum.en]:
    "This FinTrack server is a DEMO: its data is sample data, not the person's finances. " +
    'Say so once, when you start working with it. Never record, import or change anything here as if it were the ' +
    `person's real money; for their real finances use the \`${MCP_SERVER_NAME}\` server instead.`,
  [Locale.enum.pt]:
    'Este servidor FinTrack é uma DEMO: os dados são de exemplo, não as finanças da pessoa. ' +
    'Diga isso uma vez, ao começar a trabalhar com ele. Nunca registre, importe ou altere nada aqui como se fosse ' +
    `o dinheiro real da pessoa; para as finanças reais use o servidor \`${MCP_SERVER_NAME}\`.`,
  [Locale.enum.es]:
    'Este servidor FinTrack es una DEMO: sus datos son de ejemplo, no las finanzas de la persona. ' +
    'Dilo una sola vez, al empezar a trabajar con él. Nunca registres, importes ni cambies nada aquí como si fuera ' +
    `el dinero real de la persona; para sus finanzas reales usa el servidor \`${MCP_SERVER_NAME}\`.`,
} as const satisfies Record<Locale, string>;

/** Sent at initialize only for a demo database; a standard one sends none. */
export const serverInstructions = ({ kind, locale }: InstanceFacts): string | undefined =>
  isDemoInstance(kind) ? DEMO_SERVER_INSTRUCTIONS[locale] : undefined;
