import { z } from 'zod';
import { listAssets } from '../../../controllers/investment/assets.js';
import { listInvestmentEvents } from '../../../controllers/investment/events.js';
import { getPortfolio } from '../../../controllers/investment/portfolio.js';
import { READ_SCOPE } from '../../../models/auth/scope.js';
import { AssetViewSchema } from '../../../models/investment/asset.js';
import {
  GetPortfolioSchema,
  InvestmentEventViewSchema,
  ListInvestmentEventsSchema,
  PortfolioViewSchema,
} from '../../../models/investment/core.js';
import { ListAssetsInputSchema, ListAssetsQuerySchema } from '../../../wire/in/investment.js';
import { okResponse, type RouteDefinition } from '../openapi.js';
import { notFound404, parse, send, validation422 } from '../respond.js';

const INVESTMENTS_TAG = 'Investments';

const getPortfolioRoute: RouteDefinition = {
  method: 'get',
  scope: READ_SCOPE,
  path: '/api/portfolio',
  tags: [INVESTMENTS_TAG],
  summary: 'Get the portfolio: positions valued at read time',
  request: { query: GetPortfolioSchema },
  responses: { 200: okResponse('Portfolio', PortfolioViewSchema), 404: notFound404, 422: validation422 },
  handler: async (req, reply, scope) => {
    const input = parse(GetPortfolioSchema, req.query, reply);
    if (!input) return reply;
    return send(reply, await getPortfolio(scope().deps, input));
  },
};

const listAssetsRoute: RouteDefinition = {
  method: 'get',
  scope: READ_SCOPE,
  path: '/api/assets',
  tags: [INVESTMENTS_TAG],
  summary: 'List assets with their latest price',
  request: { query: ListAssetsQuerySchema },
  responses: { 200: okResponse('Assets', z.array(AssetViewSchema)), 422: validation422 },
  handler: async (req, reply, scope) => {
    const input = parse(ListAssetsInputSchema, req.query, reply);
    if (!input) return reply;
    return reply.send(await listAssets(scope().deps, input));
  },
};

const listInvestmentEventsRoute: RouteDefinition = {
  method: 'get',
  scope: READ_SCOPE,
  path: '/api/investment-events',
  tags: [INVESTMENTS_TAG],
  summary: 'List investment events (the events that make up the positions)',
  request: { query: ListInvestmentEventsSchema },
  responses: {
    200: okResponse('Investment events, oldest first', z.array(InvestmentEventViewSchema)),
    404: notFound404,
    422: validation422,
  },
  handler: async (req, reply, scope) => {
    const input = parse(ListInvestmentEventsSchema, req.query, reply);
    if (!input) return reply;
    return send(reply, await listInvestmentEvents(scope().deps, input));
  },
};

export const investmentRoutes: RouteDefinition[] = [getPortfolioRoute, listAssetsRoute, listInvestmentEventsRoute];
