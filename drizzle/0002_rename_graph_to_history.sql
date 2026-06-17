-- Rename the classification origin/method value 'graph' (a Neo4j-era fossil) to 'history'.
-- Columns are plain TEXT (no CHECK constraint), so this is a pure data migration —
-- the enum change lives in the Drizzle schema only. Existing rows must be updated so the
-- stricter model enum (zod) does not reject them on read.
UPDATE transactions       SET classification_method = 'history' WHERE classification_method = 'graph';
--> statement-breakpoint
UPDATE merchant_category  SET origin = 'history' WHERE origin = 'graph';
