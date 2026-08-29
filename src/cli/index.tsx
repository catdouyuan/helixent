import { join } from "node:path";

import { Command } from "commander";
import { render } from "ink";

import { validateIntegrity } from "@/cli/bootstrap";
import { registerCommands } from "@/cli/commands";
import { loadConfig } from "@/cli/config";
import { SettingsLoader, SettingsWriter } from "@/cli/settings";
import { createCodingAgent, globalApprovalManager, globalAskUserQuestionManager } from "@/coding";
import { AnthropicModelProvider } from "@/community/anthropic";
import { createMcpTools, loadMcpConfig, McpConnectionManager } from "@/community/mcp";
import { OpenAIModelProvider } from "@/community/openai";
import type { ModelProvider, Tool } from "@/foundation";
import { Model } from "@/foundation";

import { App } from "./tui";
import { loadAvailableCommands, type SlashCommand } from "./tui/command-registry";
import { AgentLoopProvider } from "./tui/hooks/use-agent-loop";
import { HELIXENT_NAME, HELIXENT_VERSION } from "./version";

const program = new Command();
program
  .name(HELIXENT_NAME)
  .description("Helixent — a blue rabbit that writes code")
  .version(HELIXENT_VERSION, "-v, --version");

registerCommands(program);

const args = process.argv.slice(2);

if (args.length > 0) {
  await program.parseAsync(process.argv);
} else {
  console.info();
  await validateIntegrity();

  const config = loadConfig();
  const defaultModelName = config.defaultModel ?? config.models[0]?.name;
  const entry = defaultModelName ? config.models.find((m) => m.name === defaultModelName) : undefined;
  if (!entry) {
    throw new Error("No models configured. Run `helixent config model add` to add one.");
  }

  let provider: ModelProvider;
  if (entry.provider === "anthropic") {
    provider = new AnthropicModelProvider({
      baseURL: entry.baseURL,
      apiKey: entry.APIKey,
    });
  } else {
    provider = new OpenAIModelProvider({
      baseURL: entry.baseURL,
      apiKey: entry.APIKey,
    });
  }

  const model = new Model(entry.name, provider, {
    max_tokens: 16 * 1024,
    thinking: {
      type: "enabled",
    },
  });

  const skillsDirs = [
    join(process.cwd(), "skills"),
    join(process.cwd(), ".agents/skills"),
    join(Bun.env.HELIXENT_HOME!, "skills"),
    "~/.agents/skills",
    "~/.helixent/skills",
  ];

  const mcpConfigResult = await loadMcpConfig({ cwd: process.cwd() });
  for (const warning of mcpConfigResult.warnings) {
    console.warn(`[mcp] ${warning.message}`);
  }
  for (const error of mcpConfigResult.errors) {
    console.warn(`[mcp] ${error.message}`);
  }
  const mcpManager =
    Object.keys(mcpConfigResult.config.mcpServers).length > 0
      ? new McpConnectionManager(mcpConfigResult.config, { errors: mcpConfigResult.errors })
      : null;
  const extraTools: Tool[] = mcpManager ? await createMcpTools(mcpManager) : [];
  const warnedServers = new Set(
    mcpConfigResult.errors.map((error) => error.serverName).filter((name): name is string => name !== undefined),
  );
  for (const state of mcpManager?.listStates() ?? []) {
    if (warnedServers.has(state.name)) continue;
    if (state.status === "error" || state.status === "needs-auth") {
      console.warn(`[mcp] Server "${state.name}" unavailable (${state.status}): ${state.errorMessage ?? "unknown error"}`);
    }
  }

  const settingsLoader = new SettingsLoader();
  const settingsWriter = new SettingsWriter(settingsLoader);
  const agent = await createCodingAgent({
    model,
    skillsDirs,
    extraTools,
    askUser: globalApprovalManager.askUser,
    askUserQuestion: globalAskUserQuestionManager.askUserQuestion,
    approvalPersistence: {
      loadAllowList: (cwd) => settingsLoader.loadAllowList(cwd),
      persistAllowedTool: (cwd, toolName) => settingsWriter.appendAllowedTool(cwd, toolName),
    },
  });
  const commands: SlashCommand[] = await loadAvailableCommands(skillsDirs);

  render(
    <AgentLoopProvider agent={agent} commands={commands}>
      <App commands={commands} supportProjectWideAllow />
    </AgentLoopProvider>,
    { patchConsole: false },
  );
}
