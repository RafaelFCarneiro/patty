/**
 * Migrations that rewrite or add rows to data that already exists (ADR-033 §7), as opposed to ones
 * that only add empty structure. Startup copies the database file aside before applying any of these
 * to a database that already holds applied migrations. The one place this list lives — add a tag here
 * in the same change as the migration that needs it.
 */
export const DATA_REWRITING_MIGRATIONS: readonly string[] = [
  '0018_auth_identity', // inserts the owner user (ADR-033 Phase 1)
  '0021_tenancy_data', // rebuilds every user-owned table with user_id, backfilled to the owner (ADR-033 Phase 4)
];
