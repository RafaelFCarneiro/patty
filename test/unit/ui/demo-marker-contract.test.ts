import { readdirSync, readFileSync } from 'node:fs';
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

  it('keeps the banner above every other z-index in ui/', () => {
    const banner = Number(/\.demo-banner \{[^}]*?z-index: (\d+)/.exec(read('app.css'))?.[1]);
    const dashboards = readdirSync(new URL('../../../ui/dashboards/', import.meta.url)).map((f) =>
      read(`dashboards/${f}`),
    );
    const others = [read('app.css').replace(/\.demo-banner \{[^}]*\}/, ''), read('app.js'), ...dashboards]
      .flatMap((text) => [...text.matchAll(/z-index:\s*(\d+)/g)])
      .map((match) => Number(match[1]));
    expect(banner).toBeGreaterThan(Math.max(...others));
  });
});
