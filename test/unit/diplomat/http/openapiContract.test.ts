import { describe, expect, it } from 'vitest';
import { documentationContext } from '../../../../src/diplomat/http/context.js';
import { buildOpenApiDocument } from '../../../../src/diplomat/http/openapi.js';
import { buildRouteDefinitions } from '../../../../src/diplomat/http/routes.js';

// Freezes the REST contract: any diff here is a behavior change, not a refactor.
describe('OpenAPI contract', () => {
  it('documents exactly the committed surface', async () => {
    const document = buildOpenApiDocument(buildRouteDefinitions(documentationContext('0.0.0-test')), '0.0.0-test');
    await expect(JSON.stringify(document, null, 2)).toMatchFileSnapshot('__snapshots__/openapi.json');
  });
});
