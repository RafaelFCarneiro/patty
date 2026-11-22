import type { PromptName } from '../../models/prompts.js';
import { ToolName } from './tool-name.js';

/** How a client that only receives tools runs the same workflow a prompt offers. */
export const workflowCall = (name: PromptName): string => `${ToolName.enum.get_workflow}({ name: "${name}" })`;
