import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEMO_TITLE_PREFIX, INSTANCE_KIND_ATTRIBUTE } from '../../../src/diplomat/http/hooks/demo-marker.js';
import { InstanceKind } from '../../../src/models/instance.js';

const read = (path: string): string => readFileSync(new URL(`../../../ui/${path}`, import.meta.url), 'utf8');

describe('the demo marker shared with ui/', () => {
  it('app.js reads the same attribute, value and title prefix the server writes', () => {
    const script = read('app.js');
    expect(script).toContain(`'${INSTANCE_KIND_ATTRIBUTE}'`);
    expect(script).toContain(`'${InstanceKind.enum.demo}'`);
    expect(script).toContain(`'${DEMO_TITLE_PREFIX}'`);
  });

  it('app.css styles the banner and the attribute the server writes', () => {
    const css = read('app.css');
    expect(css).toContain('.demo-banner');
    expect(css).toContain(`body[${INSTANCE_KIND_ATTRIBUTE}="${InstanceKind.enum.demo}"]`);
  });
});
