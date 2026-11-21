import { err } from 'neverthrow';
import { z } from 'zod';
import { HttpMethod } from '../../../models/api-contract.js';
import { validation } from '../../../models/error.js';
import { PromptName } from '../../../models/prompts.js';
import * as apiContract from '../../../logic/api-contract.js';
import { READ_ONLY } from '../annotations.js';
import { defineTool, type PromptDefinition } from '../definition.js';
import {
  ImportStatementPromptArgsSchema,
  PeriodPromptArgsSchema,
  promptDefinitions,
  promptsByName,
} from '../prompts.js';
import { ResourceUri } from '../resources.js';
import { fromResult, json, text } from '../respond.js';
import { ToolName } from '../tool-name.js';

/**
 * What a client that only receives tools gets in place of the resources, prompts and skills the server also offers
 * each tool returns the same content from the same source.
 */
const T = ToolName.enum;

const CONTRACT_INDEX_INTRO =
  `Every /api route, one per line. Call ${T.get_api_contract} again with \`path\` (and \`method\`) for a route’s full ` +
  'request and response schema.';

const getApiContractTool = defineTool({
  name: T.get_api_contract,
  config: {
    annotations: READ_ONLY,
    title: 'Get API contract',
    description:
      'The REST API contract a dashboard fetches from. With no input: a compact index of every /api route (method, ' +
      'path, summary, query and body parameter names, response type). With `path` (and optionally `method`): that ' +
      'route’s full request and response schema. An unknown path is a validation error that lists the close matches. ' +
      `The same contract as the ${ResourceUri.openapi} resource and GET /api/openapi.json, for clients that only receive tools.`,
    inputSchema: {
      path: z
        .string()
        .min(1)
        .optional()
        .describe('A route path from the index, e.g. "/api/summary" or "/api/dashboards/{name}"'),
      method: HttpMethod.optional().describe('Only this method of the path; omit for every method'),
    },
  },
  handle: async ({ path, method }, _scoped, { openApiDocument }) =>
    path === undefined
      ? text([CONTRACT_INDEX_INTRO, ...apiContract.index(openApiDocument).map(apiContract.formatIndexEntry)].join('\n'))
      : fromResult(apiContract.routeDetail(openApiDocument, path, method)),
});

const getDashboardGuideTool = defineTool({
  name: T.get_dashboard_guide,
  config: {
    annotations: READ_ONLY,
    title: 'Get dashboard guide',
    description:
      'The guide to building a PATTY dashboard: the data-less fragment model, the hard rules and the self-check. Call ' +
      `it, then ${T.get_api_contract}, before ${T.save_dashboard}. The same guide the dashboard-building skill points to.`,
    inputSchema: {},
  },
  handle: async (_args, _scoped, { dashboardGuide }) => text(await dashboardGuide()),
});

const describeWorkflow = ({ name, config }: PromptDefinition) => ({
  name,
  title: config.title,
  description: config.description,
  arguments: Object.keys(config.argsSchema ?? {}),
});

const getWorkflowTool = defineTool({
  name: T.get_workflow,
  config: {
    annotations: READ_ONLY,
    title: 'Get workflow',
    description:
      'A guided workflow (monthly review, budget checkup, statement import, quote refresh, demo tour): the messages ' +
      'the MCP prompt of the same name returns, for clients that only receive tools. Pass `name` and, where the ' +
      'workflow takes them, its arguments (`month`/`year` for monthly_review and budget_checkup, `source` for ' +
      'import_statement); follow the messages it returns. With no `name`: the list of workflows.',
    inputSchema: { name: PromptName.optional(), ...PeriodPromptArgsSchema, ...ImportStatementPromptArgsSchema },
  },
  handle: async ({ name, ...args }, scoped, ctx) => {
    if (name === undefined) return json(promptDefinitions.map(describeWorkflow));
    const definition = promptsByName[name];
    const parsed = z.object(definition.config.argsSchema ?? {}).safeParse(args);
    if (!parsed.success) return fromResult(err(validation(parsed.error.issues.map(({ message }) => message))));
    return json(await definition.handle(parsed.data, scoped, ctx));
  },
});

export const referenceTools = [getApiContractTool, getDashboardGuideTool, getWorkflowTool];
