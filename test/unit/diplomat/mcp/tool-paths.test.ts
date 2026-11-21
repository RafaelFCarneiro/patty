import { describe, expect, it } from 'vitest';
import { PROMPT_TOOL_PATH, RESOURCE_TOOL_PATHS } from '../../../../src/diplomat/mcp/tool-paths.js';
import { promptDefinitions, workflowCall } from '../../../../src/diplomat/mcp/prompts.js';
import { resourceDefinitions } from '../../../../src/diplomat/mcp/resources.js';
import { ToolName } from '../../../../src/diplomat/mcp/tool-name.js';
import { toolDefinitions } from '../../../../src/diplomat/mcp/tools/index.js';
import { PromptName } from '../../../../src/models/prompts.js';

// Tools are the one surface every client gets: anything offered as a prompt, resource or skill is also reachable
// through a tool (Feature Design 024). A prompt or resource without a registered tool cannot ship.
const registeredTools = new Set<string>(toolDefinitions.map(({ name }) => name));
const toolOf = (name: string) => toolDefinitions.find((definition) => definition.name === name);

describe('the tool path of every prompt and resource', () => {
  it('gives every registered resource a registered tool', () => {
    resourceDefinitions({}).forEach(({ uri }) => {
      const tool = (RESOURCE_TOOL_PATHS as Record<string, string | undefined>)[uri];
      expect(tool, `${uri} has no tool path`).toBeDefined();
      expect(registeredTools.has(tool!), `${uri} → ${tool} is not a registered tool`).toBe(true);
    });
  });

  it('names no resource that is not registered', () => {
    const uris = resourceDefinitions({}).map(({ uri }) => uri);
    expect(Object.keys(RESOURCE_TOOL_PATHS).sort()).toEqual([...uris].sort());
  });

  it('reaches the OpenAPI document through get_api_contract and each data resource through a list tool', () => {
    expect(RESOURCE_TOOL_PATHS['patty://openapi']).toBe(ToolName.enum.get_api_contract);
    Object.entries(RESOURCE_TOOL_PATHS)
      .filter(([uri]) => uri !== 'patty://openapi')
      .forEach(([uri, tool]) => expect(tool, uri).toMatch(/^list_/));
  });

  it('runs every prompt through get_workflow, which takes the prompt’s name and arguments', () => {
    const workflow = toolOf(PROMPT_TOOL_PATH);
    expect(workflow).toBeDefined();
    promptDefinitions.forEach(({ name, config }) => {
      expect(PromptName.safeParse(name).success).toBe(true);
      Object.keys(config.argsSchema ?? {}).forEach((argument) =>
        expect(Object.keys(workflow!.config.inputSchema), `${name}.${argument}`).toContain(argument),
      );
    });
  });

  it('has every prompt description name its get_workflow call', () => {
    promptDefinitions.forEach(({ name, config }) => expect(config.description).toContain(workflowCall(name)));
  });

  it('keeps the tool path read-only: a tool-only client reads what a resource or prompt offered', () => {
    Object.values(RESOURCE_TOOL_PATHS).forEach((tool) =>
      expect(toolOf(tool)?.config.annotations.readOnlyHint, tool).toBe(true),
    );
    expect(toolOf(PROMPT_TOOL_PATH)?.config.annotations.readOnlyHint).toBe(true);
  });
});
