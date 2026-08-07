import type { Command } from "commander";

import { runModelWizard } from "@/cli/bootstrap";
import type { ModelEntry } from "@/cli/config";
import {
  ensureHelixentHomeDirectory,
  ensureHelixentHomeEnv,
  getConfigFilePath,
  isHelixentSetupComplete,
  loadConfig,
  saveConfig,
} from "@/cli/config";

export function registerAddCommand(parent: Command): void {
  parent
    .command("add")
    .description("Add a new model configuration")
    .action(async () => {
      ensureHelixentHomeEnv();
      ensureHelixentHomeDirectory();

      
      const entry = await runModelWizard();

      let models: ModelEntry[];
      let defaultModel: string | undefined;
      try {
        if (isHelixentSetupComplete()) {
          const config = loadConfig();
          models = config.models;
          defaultModel = config.defaultModel;
        } else {
          models = [];
        }
      } catch {
        models = [];
      }

      models.push(entry);
      saveConfig({ models, defaultModel: defaultModel ?? entry.name });
      console.info(`\nModel "${entry.name}" added. Config saved to: ${getConfigFilePath()}`);
    });
}
