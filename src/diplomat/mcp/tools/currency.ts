import { listCurrencies } from '../../../controllers/currencies.js';
import { READ_ONLY } from '../annotations.js';
import { defineTool } from '../definition.js';
import { currenciesDescription } from '../resources.js';
import { json } from '../respond.js';
import { ToolName } from '../tool-name.js';

const listCurrenciesTool = defineTool({
  name: ToolName.enum.list_currencies,
  config: {
    annotations: READ_ONLY,
    title: 'List currencies',
    description: currenciesDescription,
    inputSchema: {},
  },
  handle: async (_args, { deps }) => json(await listCurrencies(deps)),
});

export const currencyTools = [listCurrenciesTool];
