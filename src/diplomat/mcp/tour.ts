import { DEMO_SERVER_NAME } from '../../models/demo/core.js';
import { InstanceKind } from '../../models/instance.js';
import { Locale } from '../../models/locale.js';
import { NPX_COMMAND } from '../../models/package.js';
import type { TourContext, TourStatementDated } from '../../models/demo/tour.js';
import { ToolName } from './tool-name.js';

const T = ToolName.enum;

/** What the tour's prose needs from a context, per language: the six steps, then the closing. Each is a function of the
 *  trip's destination or the formatted statement, so the language owns its whole sentence. */
type TourCopy = {
  intro: string;
  balances: string;
  lastMonth: string;
  budgets: string;
  importStep: (statement: string) => string;
  income: string;
  trip: (destination: string) => string;
  closing: string;
  step: (n: number) => string;
  /** A standard database: the tour is the demo's. */
  notDemo: string;
};

const SETUP_DEMO = `${NPX_COMMAND} setup <client> --demo`;
const REMOVE_DEMO = `${NPX_COMMAND} setup <client> --remove-demo`;
const DEMO_COMMAND = `${NPX_COMMAND} demo`;

const TOUR_COPY = {
  [Locale.enum.en]: {
    intro:
      'You are guiding the person through a short tour of PATTY on its sample data. Do the six steps in order, one ' +
      'at a time: run the tools, tell them what you found in a few sentences, and wait for them before the next step. ' +
      `Group every figure by currency and never sum across currencies.`,
    balances: `What are my balances? Call ${T.get_account_balances} (accounts and cards, and the total converted to the base currency).`,
    lastMonth: `Where did my money go last month? Call ${T.get_spending_summary} for last month, by category.`,
    budgets: `Am I over budget? Call ${T.get_budget_status} for the current month, counting what is still pending.`,
    importStep: (statement) =>
      `Import this statement. Show the lines below, import them into the checking account with ${T.import_account_statement}, ` +
      `and walk through the result: what was classified, and the line flagged needs_review.\n${statement}`,
    income: 'income',
    trip: (destination) =>
      `Tag everything from my trip to ${destination} as travel, then build me a travel dashboard. The trip is in the ` +
      `data but untagged and spread over several categories and accounts: find it with ${T.search_transactions} by dates ` +
      `and descriptions, create the tag with ${T.create_tag}, tag the purchases, then build the dashboard with ${T.save_dashboard}.`,
    closing:
      `Ready for your own data? Tell them how to install PATTY for real, and that this demo is sample data. To remove ` +
      `the demo from their AI client: \`${REMOVE_DEMO}\`.`,
    step: (n) => `Step ${n}`,
    notDemo:
      'The tour is for the PATTY demo, and this server holds real data, so do not run it here. Tell the person to ' +
      `start the demo with \`${DEMO_COMMAND}\` and to add it to their AI client with \`${SETUP_DEMO}\`, then run the ` +
      `tour prompt on the \`${DEMO_SERVER_NAME}\` server.`,
  },
  [Locale.enum.pt]: {
    intro:
      'Você vai guiar a pessoa por um tour curto do PATTY com dados de exemplo. Faça os seis passos em ordem, um ' +
      'de cada vez: execute as ferramentas, conte em poucas frases o que encontrou e espere a pessoa antes do passo ' +
      'seguinte. Agrupe todo valor por moeda e nunca some moedas diferentes.',
    balances: `Quais são meus saldos? Chame ${T.get_account_balances} (contas e cartões, e o total convertido para a moeda base).`,
    lastMonth: `Para onde foi meu dinheiro no mês passado? Chame ${T.get_spending_summary} do mês passado, por categoria.`,
    budgets: `Estou acima do orçamento? Chame ${T.get_budget_status} do mês atual, contando o que ainda está pendente.`,
    importStep: (statement) =>
      `Importe este extrato. Mostre as linhas abaixo, importe-as na conta corrente com ${T.import_account_statement} ` +
      `e comente o resultado: o que foi classificado e a linha marcada como needs_review.\n${statement}`,
    income: 'receita',
    trip: (destination) =>
      `Marque tudo da minha viagem a ${destination} como viagem e monte um dashboard de viagem. A viagem está nos ` +
      `dados, sem tag e espalhada por várias categorias e contas: encontre-a com ${T.search_transactions} por datas ` +
      `e descrições, crie a tag com ${T.create_tag}, marque as compras e monte o dashboard com ${T.save_dashboard}.`,
    closing:
      `Pronto para os seus dados? Explique como instalar o PATTY de verdade e que esta demo é de exemplo. Para ` +
      `remover a demo do cliente de IA: \`${REMOVE_DEMO}\`.`,
    step: (n) => `Passo ${n}`,
    notDemo:
      'O tour é da demo do PATTY e este servidor guarda dados reais, então não o execute aqui. Diga à pessoa para ' +
      `iniciar a demo com \`${DEMO_COMMAND}\` e adicioná-la ao cliente de IA com \`${SETUP_DEMO}\`, e então rodar o ` +
      `prompt tour no servidor \`${DEMO_SERVER_NAME}\`.`,
  },
  [Locale.enum.es]: {
    intro:
      'Vas a guiar a la persona por un tour corto de PATTY con datos de ejemplo. Haz los seis pasos en orden, de ' +
      'uno en uno: ejecuta las herramientas, cuenta en pocas frases lo que encontraste y espera a la persona antes del ' +
      'siguiente paso. Agrupa cada cifra por moneda y nunca sumes monedas distintas.',
    balances: `¿Cuáles son mis saldos? Llama a ${T.get_account_balances} (cuentas y tarjetas, y el total convertido a la moneda base).`,
    lastMonth: `¿A dónde se fue mi dinero el mes pasado? Llama a ${T.get_spending_summary} del mes pasado, por categoría.`,
    budgets: `¿Me pasé del presupuesto? Llama a ${T.get_budget_status} del mes actual, contando lo que sigue pendiente.`,
    importStep: (statement) =>
      `Importa este extracto. Muestra las líneas de abajo, impórtalas en la cuenta corriente con ${T.import_account_statement} ` +
      `y comenta el resultado: lo que se clasificó y la línea marcada como needs_review.\n${statement}`,
    income: 'ingreso',
    trip: (destination) =>
      `Etiqueta todo lo de mi viaje a ${destination} como viaje y arma un dashboard de viaje. El viaje está en los ` +
      `datos, sin etiqueta y repartido en varias categorías y cuentas: encuéntralo con ${T.search_transactions} por fechas ` +
      `y descripciones, crea la etiqueta con ${T.create_tag}, etiqueta las compras y arma el dashboard con ${T.save_dashboard}.`,
    closing:
      `¿Listo para tus datos? Explica cómo instalar PATTY de verdad y que esta demo es de ejemplo. Para quitar la ` +
      `demo del cliente de IA: \`${REMOVE_DEMO}\`.`,
    step: (n) => `Paso ${n}`,
    notDemo:
      'El tour es de la demo de PATTY y este servidor guarda datos reales, así que no lo ejecutes aquí. Dile a la ' +
      `persona que inicie la demo con \`${DEMO_COMMAND}\` y la agregue a su cliente de IA con \`${SETUP_DEMO}\`, y ` +
      `luego ejecute el prompt tour en el servidor \`${DEMO_SERVER_NAME}\`.`,
  },
} as const satisfies Record<Locale, TourCopy>;

const statementLine = (income: string) => (line: TourStatementDated) =>
  `${line.date} · ${line.description} · ${line.amount}${line.income ? ` (${income})` : ''}`;

export const tourPromptText = (context: TourContext): string => {
  const copy: TourCopy = TOUR_COPY[context.locale];
  if (context.kind === InstanceKind.enum.standard) return copy.notDemo;
  const statement = context.statement.map(statementLine(copy.income)).join('\n');
  const steps = [
    copy.balances,
    copy.lastMonth,
    copy.budgets,
    copy.importStep(statement),
    copy.trip(context.destination),
    copy.closing,
  ];
  return [copy.intro, ...steps.map((text, index) => `${copy.step(index + 1)}. ${text}`)].join('\n\n');
};
