# Helixent MCP（Model Context Protocol）技术方案（mini 版）

> 状态：待评审
> 适用范围：`helixent` TypeScript 项目（Bun 1.3.x + TypeScript 5 + zod 4 + Ink TUI）
> 参考实现：`claude-code-sourcemap/restored-src/note/reference_mcp.md`（Claude Code MCP 实现梳理）
> 本期范围：**mini 版** —— tools + resources、stdio + Streamable HTTP、项目级 `.mcp.json`；
> 不做：OAuth、SSE 传输、`helixent mcp serve`、多 scope 配置合并、TUI 管理面板、企业策略。

---

## 0. 结论先行

1. **用官方 `@modelcontextprotocol/sdk`（client 角色）**，新增 `src/community/mcp/` 模块。它与 `community/openai` 同级，只依赖 `foundation`（产出物就是 `foundation.Tool[]`），不破坏现有四层架构。
2. **配置**：从 cwd 向上查找最近的 `.mcp.json`（Claude Code 兼容格式），zod 校验 + `${VAR}` / `${VAR:-default}` 环境变量展开。本期只读一个文件，多级合并留扩展点。
3. **连接**：`McpConnectionManager` 单例，按 server 名 memoize；stdio / http 两种传输；启动时并行连接，失败**降级不阻塞**（状态记录 + 警告，工具不注入）。
4. **发现**：MCP tool → `FunctionTool`，命名 `mcp__<server>__<tool>`；description 截断到 2048 字符；**`inputSchema` 原样透传**（新增可选字段，provider 优先使用），避免 JSON Schema → Zod 的有损转换。
5. **resources**：连接后若 server 声明 resources 能力，自动追加两个内置工具 `list_mcp_resources` / `read_mcp_resource`。
6. **调用**：`Tool.invoke(input, signal)` → `client.callTool(...)` → 结果归一化（text / structuredContent / content 数组），`isError` 映射为 `Error:` 前缀，超长输出截断。
7. **兼容性关键点**（详见 §8）：Bun × SDK 免 polyfill（但避免顶层 import `client/sse.js`）；`FunctionTool` 新增可选 `inputSchema` 字段向后兼容；`mcp__` 前缀避免与内置工具名碰撞；审批中间件按精确名匹配，MCP 工具默认不拦（显式 opt-in）。
8. **CLI**：新增 `helixent mcp list` 查看各 server 的连接/工具/资源状态；TUI 本期不加管理面板。

---

## 1. 背景与参考

### 1.1 参考文档要点

Claude Code 的 MCP 实现（`reference_mcp.md`）可归纳为一条主线：

```
多级配置（.mcp.json / ~/.claude.json / settings…）
  → connectToServer（按 server 类型选传输，memoize 单例）
  → fetchToolsForClient / fetchResourcesForClient / fetchCommandsForClient
  → 转成内部 Tool / Command
  → 模型调用时 ensureConnectedClient → callTool → processMCPResult（归一化/截断/落盘）
  → onclose / list_changed 统一失效缓存
```

其核心设计点（本方案继承）：

- **一切皆缓存**：连接按 name+config memoize；tools/resources 按 server 缓存；缓存失效点统一为 `onclose` / `list_changed`。
- **命名空间**：工具名 `mcp__<server>__<tool>`，`normalizeNameForMCP` 只保留 `[a-zA-Z0-9_-]`。
- **上下文卫生**：description 截断（2048）、大输出截断/落盘、Unicode 清洗、stderr 不污染 UI。
- **防御性处理**：连接超时、错误分类、会话失效重试，都在 client 层兜底。

### 1.2 本方案裁剪/保留对照

| 参考章节                                 | 本期（mini）                   | 说明                                                         |
| ---------------------------------------- | ------------------------------ | ------------------------------------------------------------ |
| 2 配置体系（7 种 scope、企业策略、插件） | 只做项目级`.mcp.json` 单文件 | 多 scope / 启用禁用 / 插件留扩展点                           |
| 3 连接生命周期（7 种传输）               | stdio + Streamable HTTP        | SSE/WS/IDE/SDK/进程内留扩展点                                |
| 4.1 tools 发现                           | 保留                           | 命名、截断、inputSchema 透传                                 |
| 4.2 resources 发现                       | 保留                           | 两个内置工具                                                 |
| 4.3 prompts → 斜杠命令                  | 不做                           | 需动 TUI 命令体系，扩展点                                    |
| 5 调用链路与结果处理                     | 保留（不落盘）                 | 归一化 + 截断；落盘留扩展点                                  |
| 6 认证（OAuth / XAA）                    | 不做                           | HTTP 静态`headers` 可带 Bearer；401 置 `needs-auth` 提示 |
| 7 UI 与`/mcp` 命令                     | 只做 CLI`helixent mcp list`  | TUI 管理面板扩展点                                           |
| 9`claude mcp serve`                    | 不做                           | 明确不在本期                                                 |

---

## 2. 总体架构

### 2.1 分层位置

```
foundation  (Tool / FunctionTool / Message —— 唯一被依赖的核心)
   ↑
community/mcp  (MCP SDK client 封装；只依赖 foundation，产出 Tool[])
   ↑
coding  (lead-agent：createCodingAgent 新增可选 extraTools?: Tool[])
   ↑
cli  (加载 .mcp.json、创建连接管理器、注入工具、注册 `helixent mcp list`)
```

放 `community/` 的理由：

- 与 `community/openai`、`community/anthropic` 同级，符合「第三方集成是可选的 adapter」的项目约定；
- 它对外只输出 `foundation.Tool[]`，`agent` 层（ReAct 循环）完全无感知；
- 不污染 `foundation`（除一个向后兼容的可选字段 `inputSchema`，见 §5.2）。

### 2.2 数据流

```
cli/index.tsx
  ├─ loadMcpConfig({ cwd })                  # 向上找最近的 .mcp.json；没有则空
  ├─ new McpConnectionManager(config)
  ├─ createMcpTools(manager)                 # 并行 connect → listTools/listResources → FunctionTool[]
  │     └─ 注入 createCodingAgent({ extraTools })
  │           └─ Agent._act → tool.invoke(input, signal)
  │                 └─ manager.ensure(server).callTool(...)
  │                       └─ normalizeMcpResult(...) → string
  └─ registerMcpCommands(program)            # helixent mcp list
```

### 2.3 模块划分

```
src/community/mcp/
├── index.ts               # 公共 API：loadMcpConfig / McpConnectionManager / createMcpTools / 类型
├── config.ts              # .mcp.json 发现 + zod schema + 环境变量展开 + 错误元信息
├── connection-manager.ts  # 连接生命周期（memoize、超时、状态、关闭、list_changed 失效）
├── tools.ts               # 工具/资源发现与 FunctionTool 封装（含 list/read resource 内置工具）
├── result.ts              # callTool + 结果归一化/截断
├── names.ts               # normalizeNameForMCP / mcpInfoFromString
└── __tests__/             # 见 §10
```

---

## 3. 配置体系

### 3.1 发现 `.mcp.json`

- 从 `cwd` 起逐级向上查找，取**最近的一个** `.mcp.json`（与 Claude Code 的项目级一致；多文件按层级 merge 留扩展点）。
- 找不到文件 → 空配置（MCP 完全关闭，行为与现状一致）。
- 文件存在但解析失败 → 打印带文件路径的错误，**降级为无 MCP**（不阻塞启动；`helixent mcp list` 可复现错误）。
- 用 zod 校验，错误带 `mcpErrorMetadata`（scope、severity、serverName），便于以后接到 UI。

### 3.2 Schema（Claude Code 兼容）

```ts
// 每个 server 二选一
const stdioServerSchema = z.object({
  type: z.literal("stdio").optional(),   // 缺省即 stdio
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional().default({}),
});

const httpServerSchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional().default({}),
});

export const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string().min(1), z.union([stdioServerSchema, httpServerSchema])),
});
```

示例 `.mcp.json`（见附录）。

### 3.3 环境变量展开

- 对 `command` / `args` / `env` 的值做 `${VAR}` 与 `${VAR:-default}` 展开（Claude Code 同款语义）。
- 缺失且无默认值 → 该 server 标记为 error，警告信息给出变量名与建议。

### 3.4 Windows 提醒

- 裸 `npx` 作为 `command` 时给出提示：建议写成 `cmd /c npx ...` 或直接使用 `npx.cmd`，避免 Windows 下 spawn 失败（Claude Code 同款 warning，仅提示不阻断）。

### 3.5 启用/禁用

本期不做 enable/disable（删除 server 即禁用）。作为扩展点：settings 层加 `disabledMcpServers` 列表。

---

## 4. 连接生命周期

### 4.1 传输选择

| 类型              | SDK 类                            | 细节                                                                                                                                                                                    |
| ----------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stdio`（缺省） | `StdioClientTransport`          | `command`/`args` 直接 spawn（不经 shell，天然防注入）；`env: { ...process.env, ...cfg.env }`；`stderr: "pipe"` 收集到**环形缓冲（默认 64KB）**，不打印到 UI，仅失败诊断用 |
| `http`          | `StreamableHTTPClientTransport` | `new URL(cfg.url)` + `requestInit.headers = cfg.headers`（可带 `Authorization: Bearer ...` 静态头）；**懒加载 import**（见 §8.1）                                          |

SDK 版本建议 `^1.25.0`（2025-11-25 协议版本，Bun 兼容性已稳定）。

### 4.2 Memoize 单例

- `McpConnectionManager` 持有 `Map<serverName, ServerHandle>`，key = `name + JSON.stringify(config)`。
- `ensure(serverName)`：命中直接返回；未命中则连接并缓存；`onclose` / `list_changed` 通知 / 显式 `invalidate()` 时删除缓存，下次调用重建。
- 调用级断线重试：工具调用时若连接已断开（transport closed / server 重启 / 网络抖动），会失效缓存、重建连接并**重试一次**；仍失败才报错。后台自动重连不做（扩展点）。

### 4.3 状态机

```
connecting → connected → closed
   │            │
   └── error ←──┘
```

每个 server 记录：`status`、`tools`、`resources`、`errorMessage`、`stderrTail`。`helixent mcp list` 与失败降级都读这份状态。

### 4.4 超时与错误分类

- 连接超时：`Promise.race([connect, timeout])`，默认 **15s**（`HELIXENT_MCP_CONNECT_TIMEOUT_MS` 可调），超时关闭 transport/进程。
- 工具调用超时：默认不限制（与 Claude Code 一致，MCP 长任务常见）；`HELIXENT_MCP_TOOL_TIMEOUT_MS` 可调；超时后会**中止 SDK 调用**（HTTP 可真正取消 fetch；stdio 只能丢弃迟到结果）。
- 错误分类：spawn 失败（`ENOENT`/`EACCES`）、连接失败、HTTP 401（置 `needs-auth` 提示"该 server 需要认证，本期仅支持静态 headers"）、HTTP 403/404/405/429/5xx（细分可操作提示，如 404 提示检查 `url` 路径）、协议错误（JSON-RPC code）→ 统一写进 `errorMessage`。

### 4.5 关闭

- `closeAll()`：遍历关闭 transport（stdio 会终止子进程）。
- 挂 `process.on("exit")` / `SIGINT` / `SIGTERM`，避免 stdio 子进程孤儿（Bun 下 `process.on` 可用，`bun build --compile` 产物同样生效）。

---

## 5. 工具与资源发现

### 5.1 工具发现（fetchToolsForClient）

连接成功后 `client.listTools()`，逐工具转成 `FunctionTool`：

- **命名**：`mcp__${normalizeNameForMCP(server)}__${normalizeNameForMCP(tool)}`；`normalizeNameForMCP` 只保留 `[a-zA-Z0-9_-]`，其余换 `_`。工具名里的 `__` 保留（解析 `mcpInfoFromString` 时只按前两个 `__` 切分）。
- **description**：截断到 `MAX_MCP_DESCRIPTION_LENGTH = 2048`（OpenAPI 生成的 server 常塞 15-60KB 文档）。
- **inputSchema**：`tool.inputSchema` 原样保存，不转 Zod（见 §5.2）。
- **annotations**：`readOnlyHint` / `destructiveHint` / `openWorldHint` 等本期只记录在工具包装对象上，不映射到 helixent 内部 flag（helixent 工具目前无这些 flag），留作后续审批/并发安全的输入。
- **缓存**：按 server 名缓存；`onclose` / `notifications/tools/list_changed` 时失效（`client.setNotificationHandler` 订阅）。

```ts
// tools.ts（示意）
function toFunctionTool(server: string, t: McpTool): FunctionTool {
  const name = buildMcpToolName(server, t.name);
  return defineTool({
    name,
    description: truncate(t.description ?? "", MAX_MCP_DESCRIPTION_LENGTH),
    parameters: z.record(z.string(), z.unknown()),   // 兜底；实际以 inputSchema 为准
    inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    invoke: async (input, signal) => {
      const handle = await manager.ensure(server);
      const result = await callMcpTool(handle, t.name, input, signal);
      return normalizeMcpResult(result, server);
    },
  });
}
```

### 5.2 `inputSchema` 透传（关键兼容设计）

**问题**：helixent 的 `FunctionTool.parameters` 是 zod schema，provider 转换时走 `parameters.toJSONSchema()`。MCP server 给的是 JSON Schema，若先转成 zod 再转回 JSON Schema，会丢失 `$ref`、`anyOf`、`additionalProperties` 等关键字，属于有损转换。

**方案**：给 `FunctionTool` 增加一个**可选**字段（向后兼容，默认行为不变）：

```ts
// foundation/tools/function-tool.ts
export interface FunctionTool<P, R> {
  name: string;
  description: string;
  parameters: P;
  /** 可选：直接发给模型的原始 JSON Schema，优先于 parameters.toJSONSchema() */
  inputSchema?: Record<string, unknown>;
  invoke: (input: z.infer<P>, signal?: AbortSignal) => Promise<R>;
}
```

两个 provider 转换函数改为「优先 `inputSchema`，缺省回退 `parameters.toJSONSchema()`」：

```ts
// community/openai/utils.ts 与 community/anthropic/utils.ts
const schema = tool.inputSchema ?? (tool.parameters.toJSONSchema() as ...);
```

防御：若 `inputSchema` 根不是 `object`，回退到 `parameters.toJSONSchema()`（部分 MCP server 返回的根 schema 不规范）。

> 备选方案（不推荐本期做）：写一个 JSON Schema → Zod 的 mapper。代码量更大、且要适配 zod v4 API，收益只是不动 foundation，得不偿失。

### 5.3 resources 发现与内置工具

- 连接后调 `client.listResources()`；有结果且 server 声明了 resources 能力时，给 agent 追加两个内置工具（只加一次）：

| 工具名                 | 参数                    | 行为                                                                                                                                                     |
| ---------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_mcp_resources` | `server?`（可选过滤） | 返回各 server 的`uri / name / mimeType / description`                                                                                                  |
| `read_mcp_resource`  | `server`, `uri`     | `client.readResource({ uri })`；text 直接返回，**blob（base64）本期不落盘**，返回 `[binary resource <uri> omitted]` 提示（落盘写文件留扩展点） |

- resources 同样按 server 缓存，`onclose` / `notifications/resources/list_changed` 失效。
- 不声明 `roots` 能力（避免 server 反向请求工作区根）；作为扩展点，后续可声明 `roots: { cwd }`。

---

## 6. 调用链路与结果处理

### 6.1 调用

```
Tool.invoke(input, signal)
  └─ manager.ensure(server)              // memoize 命中或重建
  └─ client.callTool({ name, arguments: input }, undefined, { signal })
      └─ normalizeMcpResult(result, server)
```

- `signal`：agent 的 AbortSignal 透传。HTTP 下 SDK 可取消 fetch；stdio 下无法真正取消已发出的请求，只能丢弃迟到结果（记录一条 debug 日志）。
- 断线重试：调用时发现连接已断开（transport closed），`callMcpToolWithRetry` 会失效缓存、重建连接并重试一次；只有传输级"连接关闭"错误才重试，server 端工具错误 / `isError` 结果绝不重试（避免副作用重复）。
- 调用异常：协议错误（含 JSON-RPC code）、连接断开、超时 → 包装成 `Error` 抛出；agent 循环已有兜底（catch 后转 `Error: <msg>` 回写）。

### 6.2 结果归一化（normalizeMcpResult）

按返回结构分三类：

| 结构                  | 处理                                                                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isError: true`     | 取 content 文本拼接，返回`Error: <text>`（可被现有 `normalizeToolResult` 识别为失败）                                                                                                                                                                        |
| `structuredContent` | `JSON.stringify(structuredContent, null, 2)`                                                                                                                                                                                                                   |
| `content[]`         | 逐块转换后`\n` 拼接：`text` → 原文；`resource(text)` → `[Resource from <server> at <uri>] <text>`；`resource_link` → 链接文本；`image`/`audio` → `[<type> from <server> omitted]`；`resource(blob)` → `[binary resource <uri> omitted]` |

归一化后的字符串直接进入现有工具结果管线：`formatToolResultForMessage` → `ToolMessage`，模型侧无感知，兼容现有 provider 转换。

### 6.3 大输出截断

- 字符级截断（Claude Code 用 token 估算，本期简化）：`HELIXENT_MCP_MAX_OUTPUT_CHARS`，默认 **24000**。
- 超限 → `truncateText(text, max)`，追加 `[OUTPUT TRUNCATED ...]` 说明（复用 `coding/tools/tool-utils.ts` 的 `truncateText`）。
- 落盘（`mcp-<server>-<tool>-<ts>.txt` + 强指令）留扩展点。

### 6.4 与现有结果管线的兼容

- MCP 工具名带 `mcp__` 前缀，不会命中 `getToolResultPolicy` 里 `read_file` 等特殊分支，走默认策略（`maxStringLength: 4000` 用于 summary；工具结果本体由 §6.3 控制）。若需要，可后续按 `mcp__` 前缀加统一策略。

---

## 7. CLI 与状态

### 7.1 `helixent mcp list`

新增 commander 子命令（与 `helixent config model ...` 并列），复用与 TUI 启动完全相同的加载/连接代码：

```
$ helixent mcp list
SERVER      TYPE   STATUS     TOOLS  RESOURCES  ERROR
filesystem  stdio  connected  5      0
weather     http   needs-auth -      -         401 Unauthorized
```

- 输出：server 名、类型、状态（connecting/connected/error/needs-auth）、工具数、资源数、错误信息。
- 连接失败的 server 不中断命令；非交互模式连接超时用较小值（如 5s）。

### 7.2 TUI

本期不加 `/mcp` 斜杠命令与管理面板（扩展点）。启动时的降级警告打印到终端即可。

---

## 8. 与 helixent 的兼容性分析

### 8.1 运行时 / 构建（Bun × SDK）

- 官方 `@modelcontextprotocol/sdk` v1.x 在 Bun ≥1.2 上**免 polyfill**（stdio / streamable HTTP 均可用），Bun 1.3.14 满足。
- **避免顶层静态 import `@modelcontextprotocol/sdk/client/sse.js`**：它会拖入 `eventsource`（CJS/ESM 混用在 Bun 下加载期报错）。本期不用 SSE，只 import `client/index.js`、`client/stdio.js`、`client/streamableHttp.js`。
- `bun build --compile`（`build:bin`）打包 SDK 时需要验证动态 import（SDK 内部对可选依赖用动态 import）。在 CI 里跑一次 `bun run build:bin` 回归。
- ESM：helixent `"type": "module"`，SDK 双格式，无冲突。

### 8.2 类型与 Schema

- **zod v4（项目）与 SDK 内置 zod v3 并存**：依赖隔离，互不干扰；但不要混用两侧的 zod 类型。
- `FunctionTool` 新增可选 `inputSchema`：现有所有 `defineTool` 调用零改动（可选字段），`toJSONSchema()` 回退逻辑保证行为不变。
- `parameters` 仍须满足 `z.ZodSchema<Record<string, unknown>>` 约束：MCP 工具用 `z.record(z.string(), z.unknown())` 兜底（真实 schema 走 `inputSchema` 透传）。

### 8.3 Agent Loop 与中间件

- `Agent._act` 只按 `tool.name` 查找并调用 `invoke(input, signal)`，对 MCP 工具透明。
- `mcp__` 前缀避免与内置工具（`bash`、`read_file`…）碰撞。
- **审批中间件**：`CODING_TOOLS_REQUIRING_APPROVAL` 按精确名匹配，MCP 工具名不会命中 → 默认不拦。设计意图：把 server 加进 `.mcp.json` 已是显式 opt-in（等价于安装插件）；若后续要拦，扩展点是把「以 `mcp__` 开头的工具」加入需审批集合，或给 `FunctionTool` 加 `requiresApproval` 可选字段。
- **skills / todos 中间件**：对工具列表无耦合，不冲突。

### 8.4 结果管线

- MCP 结果统一为字符串后走 `formatToolResultForMessage`，与现有工具一致；`Error:` 前缀可被 `normalizeToolResult` 识别为失败。
- 不会误命中 `read_file` 等特判分支（名字带前缀）。

### 8.5 TUI / 渲染

- 工具名 `mcp__server__tool` 较长，TUI 渲染按现有宽度截断即可，无需改动。
- `helixent mcp list` 走非交互路径，不依赖 Ink。

### 8.6 安全

- `.mcp.json` 会提交进仓库：stdio server 的 `command` 在**用户权限**下执行任意代码，等于新增了受信任的启动进程；必须在 README/文档中明示「只添加可信 server」，并在 code review 中关注 `.mcp.json` 变更。
- `command`/`args` 数组直接 spawn（不经 shell），无 shell 注入面。
- stderr 不进 UI（避免 server 刷屏/注入终端转义）。
- 输出截断 + 二进制省略，防第三方 server 撑爆上下文或注入格式。
- 环境变量展开只读 `process.env`，不把 `.mcp.json` 里的值写回环境。

---

## 9. 文件改动清单

新增：

```
src/community/mcp/index.ts
src/community/mcp/config.ts
src/community/mcp/connection-manager.ts
src/community/mcp/tools.ts
src/community/mcp/result.ts
src/community/mcp/names.ts
src/community/mcp/__tests__/{config,names,result,e2e}.test.ts
src/cli/commands/mcp/index.ts
src/cli/commands/mcp/__tests__/list.test.ts
```

修改：

| 文件                                      | 改动                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `package.json`                          | 新增依赖`@modelcontextprotocol/sdk`（`^1.25.0`）                               |
| `src/foundation/tools/function-tool.ts` | 加可选`inputSchema?: Record<string, unknown>`                                    |
| `src/community/openai/utils.ts`         | `convertToOpenAITools` 优先 `inputSchema`                                      |
| `src/community/anthropic/utils.ts`      | `convertToAnthropicTools` 优先 `inputSchema`                                   |
| `src/coding/agents/lead-agent.ts`       | `createCodingAgent` 增加 `extraTools?: Tool[]`，并入 `tools`                 |
| `src/cli/index.tsx`                     | 启动时`loadMcpConfig` → `createMcpTools` → 注入 `extraTools`；挂 exit 清理 |
| `src/cli/commands/index.ts`             | 注册`registerMcpCommands`                                                        |

---

## 10. 测试计划（bun test）

| 文件                                            | 覆盖                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.test.ts`                              | `.mcp.json` 向上发现（临时目录）；schema 校验错误；`${VAR}`/`${VAR:-default}` 展开；Windows npx 提示；UTF-8 BOM                                                                                                                                                                    |
| `names.test.ts`                               | `normalizeNameForMCP`；`mcpInfoFromString`（含工具名里的 `__`）                                                                                                                                                                                                                    |
| `result.test.ts`                              | `isError` / `structuredContent` / content 数组 / resource / 截断；工具超时中止 SDK 调用；断线重试一次 / 非连接错误不重试                                                                                                                                                                                                                     |
| `e2e.test.ts`                                 | 用 SDK`Server` + `StdioServerTransport` 写一个 fixture server（如 echo），经 `Bun.spawn` 起子进程，走「连接 → listTools → callTool → 归一化」全链路；HTTP 用本地 `node:http` fixture 起 `StreamableHTTPServerTransport`，标记为集成测试；缺失 stdio 命令 → ENOENT 错误分类；发现失败降级不崩溃；0 工具/资源不重复查询；HTTP 401 → needs-auth、404 → 可操作提示 |
| `src/cli/commands/mcp/__tests__/list.test.ts` | `helixent mcp list` 状态收集：connected server 的工具/资源计数；失败 server 不中断命令                                                                                                                                                                                                 |

另在 CI 加 `bun run build:bin` 回归，验证 SDK 打包兼容（§8.1）。

---

## 11. 扩展点（本期明确不做）

1. 传输：SSE、WebSocket、IDE/SDK 桥、进程内 linked transport。
2. 认证：OAuth 2.0 PKCE、token 刷新、XAA。
3. 配置：多 scope 合并（user/project/local）、启用/禁用、企业策略、插件 MCP、claude.ai connector。
4. prompts → 斜杠命令；MCP skills。
5. 大输出落盘 + 强指令；token 级估算替代字符级截断。
6. `helixent mcp serve`（反向暴露 helixent 工具）。
7. TUI `/mcp` 管理面板；MCP 工具审批策略。
8. `roots` 能力声明。

---

## 12. 风险与对策

| 风险                                         | 对策                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| SDK × Bun 打包（`build:bin` 动态 import） | CI 回归`build:bin`；锁 `^1.25.0`；SSE 模块不 import                                                        |
| HTTP 长连接/SSE fallback 在 Bun 下偶发不稳   | 集成测试覆盖；SDK 1.25+ 已修复主要 SSE 问题（本期实际只用 streamable HTTP）                                    |
| zod v3/v4 并存混淆                           | 只在`community/mcp` 内部接触 SDK 类型；`FunctionTool` 侧只用 `inputSchema: Record<string, unknown>` 透传 |
| `inputSchema` 根非 object                  | converter 防御回退`parameters.toJSONSchema()`                                                                |
| stdio 子进程孤儿                             | exit/SIGINT/SIGTERM 挂`closeAll()`                                                                           |
| 恶意/不可信 server                           | 文档安全提示；stderr 不外泄；输出截断；`.mcp.json` 纳入 code review                                          |
| 连接慢拖慢启动                               | 并行连接 + 超时 + 失败降级；`helixent mcp list` 可诊断                                                       |

---

## 13. 实现与测试记录（踩坑与解决方案）

> 本节记录按本方案实现并跑通测试（`bun test`，全仓 `bun run check` 278 通过）过程中遇到的几个比较奇怪/典型的问题与对应解决方案，供后续维护参考。

### 13.1 `mcpInfoFromString` 解析规则修正：工具名里的 `__`

- **现象**：`mcpInfoFromString("mcp__github__create_issue")` 返回 `null`，最简单的两段式工具名都解析不出来。
- **原因**：最初按「只按前两个 `__` 切分」的字面理解，先去掉 `mcp__` 前缀后，又在剩余串里找**两个** `__`。但 `mcp__server__tool` 去掉前缀后只剩 `server__tool`（一个 `__`），第二个 `__` 永远找不到 → 返回 `null`。
- **解决**：去掉 `mcp__` 前缀后只找**第一个** `__` 切分 server/tool，`__` 之后的工具名原样保留（天然满足「工具名里的 `__` 保留」）。
- **测试**：`src/community/mcp/__tests__/names.test.ts`（含 `mcp__server__tool__with__sep` → `{ server: "server", tool: "tool__with__sep" }`）。

### 13.2 Bun 下 HTTP fixture 挂起：用 `WebStandardStreamableHTTPServerTransport` + `Bun.serve`，而不是 Node `http` 封装

- **现象**：用 `node:http` + `StreamableHTTPServerTransport` 起 HTTP fixture，SDK client 连接一直超时；裸 `fetch(POST)` 也永不返回。
- **原因**（两层）：
  1. fixture 忘了 `await server.connect(transport)`，Protocol 没有与 transport 接线，`initialize` 请求无人应答 → 连接挂起。streamable HTTP 也是「先 connect 再 handleRequest」。
  2. `StreamableHTTPServerTransport` 是 Node 封装（内部用 `@hono/node-server` 把 Node req/res 转成 Web 标准），在 Bun 下请求体读取/响应容易挂起；SDK 类型注释明确写「Bun 等 web 标准环境应直接用 `WebStandardStreamableHTTPServerTransport`」。
- **解决**：fixture 改用 `Bun.serve` + `WebStandardStreamableHTTPServerTransport`（`handleRequest(request): Promise<Response>`），并补上 `await server.connect(transport)`。HTTP e2e 稳定通过（~130ms）。
- **调试注意**：streamable HTTP 默认 `enableJsonResponse: false`（SSE 优先），POST 的响应可能是**持续打开的 SSE 流**。用裸 `fetch + resp.text()` 调试会「挂起」——这是预期行为，不是 bug；要用 SDK client 消费，或在 fixture 里开 `enableJsonResponse: true`。

### 13.3 stdio fixture 的 stdout 卫生

- **注意**：stdio 传输用 stdout 传 JSON-RPC 帧，fixture 里任何额外输出（`console.log`/`console.info` 等）都会污染协议流，导致解析失败。fixture 只允许把诊断写 stderr；需要向测试上报信息（如 HTTP 端口）时，走 HTTP/独立通道，stdout 只留给协议帧。

### 13.4 类型小坑

- **`Bun.spawn` 的 `stdout` 不会因 `stdout: "pipe"` 收窄类型**：`Subprocess.stdout` 的类型是 `ReadableStream<Uint8Array> | number | undefined`，直接 `proc.stdout.getReader()` 报 TS 错。解决：显式断言 `proc.stdout as ReadableStream<Uint8Array>`。
- **http server 配置字面量必须带 `headers`**：`McpServerConfig` 的 http 分支里 `headers` 经 zod `default({})` 后类型上**非可选**，`{ type: "http", url }` 直接构造会报类型错。解决：补 `headers: {}`。

### 13.5 构建回归

- `bun run build:bin` 通过（1104 modules 打包 + 编译成 `dist/bin/helixent`），验证了 §8.1 的 SDK × Bun 打包兼容：顶层只 import `client/index.js`、`client/stdio.js`，`client/streamableHttp.js` 保持懒加载，

### 13.6 `helixent mcp list` 工具/资源计数恒为 0（发现逻辑不在 CLI 路径上）

- **现象**：`helixent mcp list` 对已连接的 server 始终显示 `TOOLS 0  RESOURCES 0`，与 §7.1 示例输出（`filesystem  connected  5  0`）不符。
- **原因**：工具/资源发现（`fetchToolsForClient` / `fetchResourcesForClient`）只在 `createMcpTools()`（`tools.ts`）里被调用；CLI 命令只 `manager.ensure()` 建连就打印 `listStates()`，从未触发发现，`state.tools` / `state.resources` 恒为空数组。
- **解决**：把 CLI 的「建连 + 发现 + 快照」抽成 `collectServerStates()`（`src/cli/commands/mcp/index.ts`）：`ensure` 后对每个 connected server 并行调 `fetchToolsForClient` / `fetchResourcesForClient`（与 TUI 启动同一套发现代码），并在 `closeAll()` **之前**快照状态（否则 status 会被 `closeAll()` 翻成 `closed`，表格就看不到 `connected` 了）。
- **测试**：`src/cli/commands/mcp/__tests__/list.test.ts`（connected server 计数、失败 server 不中断命令）。

### 13.7 `.mcp.json` 带 UTF-8 BOM 导致整体解析失败

- **现象**：用 Windows 常见方式写出的 `.mcp.json`（PowerShell `Set-Content -Encoding UTF8`、部分编辑器「UTF-8 with BOM」另存为），`helixent mcp list` 报 `Invalid JSON ... Unrecognized token`，MCP 整体静默降级为关闭，只在 stderr 留一条警告，很难排查。
- **原因**：`JSON.parse` 不接受文件开头的 `\uFEFF`（BOM）；`readFile(..., "utf8")` 不会自动去掉 BOM。
- **解决**：`parseMcpConfigText` 解析前先 `raw.replace(/^\uFEFF/, "")` 去掉 BOM。
- **测试**：`config.test.ts` 新增「UTF-8 BOM」用例。

### 13.8 Windows 下 spawn 失败只显示泛化 "Connection closed"

- **现象**：stdio server 的 `command` 不存在时（Windows），`helixent mcp list` 显示 `MCP error -32000: Connection closed`，而不是 §4.4 承诺的 ENOENT 提示；且 `stderrTail` 是乱码，无法诊断。
- **原因**（两层）：
  1. SDK `StdioClientTransport` 用 `cross-spawn`（`shell: false`）。Bun + Windows 下找不到命令时，实际由 cmd.exe 把错误信息写到 stderr 后退出，client 侧只看到「连接未完成握手即关闭」→ 泛化 `-32000 Connection closed`，ENOENT 没有透传上来。
  2. cmd.exe 的 stderr 是 Windows 控制台代码页（中文系统为 GBK），按 UTF-8 解码成 `�` 乱码。
     另：`describeMcpError` 里 `cfg.type === "stdio"` 的判断漏掉了「缺省 stdio」（`type` 未显式写时是 `undefined`），导致 ENOENT 消息里命令名显示 `"(unknown)"`。
- **解决**：
  1. `_createStdioTransport` 建连前用 `Bun.which()` 预检命令（覆盖 PATH + PATHEXT，如 `npx` → `npx.cmd`；绝对路径直接可解析；相对路径带分隔符回退 `access()` 检查），不可解析则抛 `code = "ENOENT"` 的错误 → `describeMcpError` 输出 `Failed to spawn command "...": executable not found.`，跨平台且确定性。
  2. stderr 环形缓冲改用 `decodeStderrChunk()`：先按 UTF-8 解码，若出现 U+FFFD 替换符则回退 `TextDecoder("gbk")` 重解（Bun 运行时支持 GBK；类型上用 `node:util` 的 `TextDecoder`，其构造器接受任意 string label）。
  3. `describeMcpError` 的 ENOENT 分支改为 `"command" in cfg` 判断，缺省 stdio 也能拿到真实命令名。
- **测试**：`e2e.test.ts` 新增「missing command → ENOENT」用例（`manager.ensure` 抛错、state 为 `error`、`errorMessage` 含 `executable not found`）。


### 13.9 发现阶段无失败兜底，可能让启动崩掉（A 类）

- **现象**：`createMcpTools()` 里连接用了 `Promise.allSettled`（连接失败可降级），但紧随其后的 `fetchToolsForClient()` / `fetchResourcesForClient()` 没有 try/catch；`src/cli/index.tsx` 的 `await createMcpTools(...)` 也没有兜底。一个 server 连上了但 `listTools` 报错，整个 CLI 启动会抛异常，与「失败降级不阻塞」的承诺不符。
- **解决**：`createMcpTools` 对每个 server 的发现包 try/catch，失败时把该 server 状态标为 `error` 并继续（工具不注入，状态供 `helixent mcp list` 诊断）。
- **测试**：`e2e.test.ts` 新增 `failing-discovery-server.ts` fixture（连接成功但 listTools 抛错），断言 `createMcpTools` 不抛、返回空、状态为 error。

### 13.10 工具/资源「空结果不缓存」（A 类）

- **现象**：`fetchToolsForClient` / `fetchResourcesForClient` 用 `state.tools.length > 0` 判断是否已抓取；声明了 tools 能力但返回 0 个工具的 server，每次调用都会重复 `listTools()`。
- **解决**：给 `McpServerState` 增加 `toolsFetched` / `resourcesFetched` 标志位（「无此能力」「抓取为空」都置位），`invalidate()` 时复位。
- **测试**：`e2e.test.ts` 新增 `empty-server.ts` fixture（0 工具/资源，每次 listTools 向 stderr 打 `LT` 标记），断言 4 次抓取只发生 1 次往返。

### 13.11 HTTP 错误分类太粗（A 类）

- **现象**：只有 401 → `needs-auth`；403/404/429/5xx 全部归为 `error`，提示也不可操作（404 只显示 `Unable to connect...`）。
- **解决**：`describeMcpError` 按 `httpStatusOf(error)`（SDK 的 `StreamableHTTPError.code` 就是 HTTP 状态码）细分：401 认证提示、403 凭据被拒、404 检查 `url` 路径（常见 /mcp）、405 端点不接受 MCP 请求、429 限流、5xx server 错误。
- **测试**：`e2e.test.ts` 新增 `http-status-server.ts` fixture（按 `HTTP_STATUS` 环境变量返回固定状态码），断言 401 → needs-auth、404 → 含 `/mcp` 的可操作提示。

### 13.12 工具超时只「丢弃」不「取消」（A 类）

- **现象**：超时只是 race 拒绝，底层的 `client.callTool` 仍在跑（HTTP 的 fetch 也没取消），连接/资源被占用。
- **解决**：`callMcpTool` 用自建的 `AbortController`——外层 signal 中断或超时触发时 abort 它并透传给 SDK；同一计时器里先 abort 再以「Timed out」消息 settle，保证报错信息确定、底层调用真正被取消。
- **测试**：`result.test.ts` 新增「超时后 SDK signal 已 aborted」用例。

### 13.13 断线不重试（A 类）

- **现象**：MCP server 重启 / 网络抖动导致连接断开时，当前调用直接失败；只能等下一次调用靠 memoize 失效重建。
- **解决**：新增 `callMcpToolWithRetry()`（工具 invoke 入口使用）：调用抛「传输级 connection closed」错误时，失效缓存 → 重建连接 → **重试一次**；server 端工具错误 / `isError` 结果不重试（避免副作用重复）。
- **测试**：`result.test.ts` 新增「stale 连接重试一次 / 非连接错误不重试」两个用例。

## 附录：示例 `.mcp.json`

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/scratch"]
    },
    "github": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${GITHUB_MCP_TOKEN}"
      }
    }
  }
}
```
