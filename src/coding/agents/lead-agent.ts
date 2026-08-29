import { join } from "path";

import { Agent } from "@/agent";
import { createSkillsMiddleware } from "@/agent/skills/skills-middleware";
import { createTodoSystem } from "@/agent/todos/todos";
import type { Model, NonSystemMessage, Tool, ToolUseContent } from "@/foundation";

import {
  type ApprovalDecision,
  type ApprovalPersistence,
  CODING_TOOLS_REQUIRING_APPROVAL,
  createCodingApprovalMiddleware,
} from "../permissions";
import { applyPatchTool } from "../tools/apply-patch";
import {
  createAskUserQuestionTool,
  type AskUserQuestionParameters,
  type AskUserQuestionResult,
} from "../tools/ask-user-question";
import { createBashTool } from "../tools/bash";
import { fileInfoTool } from "../tools/file-info";
import { globSearchTool } from "../tools/glob-search";
import { grepSearchTool } from "../tools/grep-search";
import { listFilesTool } from "../tools/list-files";
import { mkdirTool } from "../tools/mkdir";
import { movePathTool } from "../tools/move-path";
import { readFileTool } from "../tools/read-file";
import { strReplaceTool } from "../tools/str-replace";
import { writeFileTool } from "../tools/write-file";

export async function createCodingAgent({
  model,
  cwd = process.cwd(),
  skillsDirs = [join(process.cwd(), ".agents/skills")],
  extraTools = [],
  askUser,
  askUserQuestion,
  approvalPersistence,
}: {
  model: Model;
  cwd?: string;
  skillsDirs?: string[];
  extraTools?: Tool[];
  // eslint-disable-next-line no-unused-vars
  askUser?: (toolUse: ToolUseContent) => Promise<ApprovalDecision>;
  // eslint-disable-next-line no-unused-vars
  askUserQuestion?: (params: AskUserQuestionParameters) => Promise<AskUserQuestionResult>;
  approvalPersistence?: ApprovalPersistence;
}) {
  const agentsFile = Bun.file(`${cwd}/AGENTS.md`);
  const messages: NonSystemMessage[] = [];
  if (await agentsFile.exists()) {
    const agentsFileContent = await agentsFile.text();
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: "> The `AGENTS.md` file has been automatically loaded. Here is the content:\n\n" + agentsFileContent,
        },
      ],
    });
  }
  const { tool: todoTool, middleware: todoMiddleware } = createTodoSystem();

  const bashTool = createBashTool({ cwd });

  const askUserQuestionTool = askUserQuestion ? createAskUserQuestionTool(askUserQuestion) : null;

  const middlewares = [createSkillsMiddleware(skillsDirs), todoMiddleware];
  if (askUser) {
    middlewares.push(
      createCodingApprovalMiddleware({
        cwd,
        requiresApproval: CODING_TOOLS_REQUIRING_APPROVAL,
        askUser,
        approvalPersistence,
      }),
    );
  }

  return new Agent({
    model,
    prompt: `<agent name="Helixent" role="leading_agent" description="A coding agent">
Use the given tools and skills to perform parallel/sequential operations and solve the user's problem in the given working directory.
</agent>

<working_directory dir="${cwd}/" />

<tool_usage>
- Inspect directories before assuming file paths.
- Prefer list_files or glob_search to discover files.
- Prefer grep_search to locate relevant content.
- Read a file before editing it.
- Prefer apply_patch for targeted edits.
- If apply_patch fails, re-read the file and choose a safer edit strategy.
- Do not repeat the same failing tool call with unchanged invalid input.
- Use tool result summaries and error codes to decide the next step.
</tool_usage>

<shell>
The bash tool executes commands using the configured platform shell.

- HELIXENT_SHELL controls the shell explicitly.
- On Windows without HELIXENT_SHELL, the order is PowerShell 7,
  Windows PowerShell 5.1, then cmd.exe.
- On macOS/Linux without HELIXENT_SHELL, the order is zsh, bash, then sh.
- Git Bash and WSL are never selected automatically.
- Command syntax is not translated between shells.
- Use PowerShell syntax when the active shell is PowerShell.
- Use POSIX syntax only when Git Bash, WSL, bash, zsh, or sh is selected.
</shell>

<notes>
- Never try to start a local static server. Let the user do it.
- If the user's input is a simple task or a greeting, you should just respond with a simple answer and then stop.
</notes>
`,
    messages,
    tools: [
      bashTool,
      fileInfoTool,
      listFilesTool,
      globSearchTool,
      grepSearchTool,
      mkdirTool,
      movePathTool,
      readFileTool,
      writeFileTool,
      strReplaceTool,
      applyPatchTool,
      todoTool,
      ...(askUserQuestionTool ? [askUserQuestionTool] : []),
      ...extraTools,
    ],
    middlewares,
  });
}
