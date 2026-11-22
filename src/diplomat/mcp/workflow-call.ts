import type { PromptName } from '../../models/prompts.js';
import { ToolName } from './tool-name.js';

export const workflowCall = (name: PromptName): string => `${ToolName.enum.get_workflow}({ name: "${name}" })`;
