import { topMerchants } from '../../../controllers/merchants.js';
import { READ_ONLY } from '../annotations.js';
import { defineTool } from '../definition.js';
import { merchantsTopDescription } from '../resources.js';
import { json } from '../respond.js';
import { ToolName } from '../tool-name.js';

const listTopMerchantsTool = defineTool({
  name: ToolName.enum.list_top_merchants,
  config: {
    annotations: READ_ONLY,
    title: 'List top merchants',
    description: merchantsTopDescription,
    inputSchema: {},
  },
  handle: async (_args, { deps }) => json(await topMerchants(deps)),
});

export const merchantTools = [listTopMerchantsTool];
