import type { Command } from "commander";

import { registerConfigCommands } from "./config";
import { registerMcpCommands } from "./mcp";

export function registerCommands(program: Command): void {
  registerConfigCommands(program);
  registerMcpCommands(program);
}
