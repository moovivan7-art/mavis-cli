import { browserTool } from './browser.js';
import { bashTool } from './bash.js';
import { fsTool } from './fs.js';
import { jobsTool } from './jobs.js';
import { draftsTool } from './drafts.js';
import { threadsTool } from './threads.js';
import { sendMessageTool } from './send.js';
import { memoryTool } from './memory.js';
import { todoTool } from './todo.js';
import { playbookTool } from './playbook.js';
import { delegateTool } from './delegate.js';

export const ALL_TOOLS = [
  browserTool,
  bashTool,
  fsTool,
  jobsTool,
  draftsTool,
  threadsTool,
  sendMessageTool,
  memoryTool,
  todoTool,
  playbookTool,
  delegateTool,
];

export function buildTools(names) {
  if (!names || !names.length) return ALL_TOOLS;
  return ALL_TOOLS.filter((t) => names.includes(t.name));
}

export function toolByName(name) {
  return ALL_TOOLS.find((t) => t.name === name) || null;
}
