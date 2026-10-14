export const USER_ENTITY_TAG = 'user';
export const SESSION_ENTITY_TAG = 'session';
export const SETUP_CODE_ENTITY_TAG = 'setup_code';
export const ACCESS_TOKEN_ENTITY_TAG = 'access_token';
export const CLIENT_GRANT_ENTITY_TAG = 'client_grant';

/** Entities the auth flows write — never worth telling a dashboard about. */
export const AUTH_ENTITY_TAGS: readonly string[] = [
  USER_ENTITY_TAG,
  SESSION_ENTITY_TAG,
  SETUP_CODE_ENTITY_TAG,
  ACCESS_TOKEN_ENTITY_TAG,
  CLIENT_GRANT_ENTITY_TAG,
];
