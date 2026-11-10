import { PRODUCT_NAME } from '../package.js';
export const BEARER_SCHEME = 'Bearer';
export const BEARER_HEADER = new RegExp(`^${BEARER_SCHEME}[ \\t]+(\\S+)$`, 'i');

export const RESOURCE_NAME = PRODUCT_NAME;
export const BEARER_METHOD_HEADER = 'header';

/** The HTTP surfaces a bearer token is accepted on. `/ui` is a browser surface and stays session-only. */
export const API_PATH_PREFIX = '/api';
export const MCP_PATH = '/mcp';
/** RFC 9728 §3: the metadata of resource `<origin>/mcp` lives at the well-known URI with the path inserted. */
export const PRM_WELL_KNOWN_PATH = '/.well-known/oauth-protected-resource';
export const MCP_PRM_PATH = `${PRM_WELL_KNOWN_PATH}${MCP_PATH}`;

export type Credential = { kind: 'none' } | { kind: 'bearer'; token: string } | { kind: 'malformed' };
