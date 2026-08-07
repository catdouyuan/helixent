# 第 18 节：CLI 入口、配置、命令与设置持久化

> 本节属于 **第六部分 · CLI / TUI 层（人机交互界面）**，是这一部分的**开篇**，也是整套教程里第一次让你看到「这台 Agent 是怎么被『交到用户手里』」的一节。[第 16～17 节](./17-anthropic-provider.md) 补齐了「连接真实模型」这一环，让 `new OpenAIModelProvider({ baseURL, apiKey })` / `new AnthropicModelProvider({ baseURL, apiKey })` 能真的打通厂商 API；[第 15 节](./15-human-in-the-loop.md) 造出了审批与提问的两个 `Manager`，却在结尾留下一个**至今未兑现的空白**：`approval-persistence.ts` 只定义了 `loadAllowList` / `persistAllowedTool` 两个**函数签名（契约）**，并明确写着「具体落盘留到第 18 节」。**本节就来同时兑现这两处伏笔：一是揭开敲下 `helixent` 之后的完整启动链路，二是把第 15 节那份『白名单读写契约』真正落到磁盘上。**
>
> 对应 roadmap 为本节设定的**核心问题**：
>
>> 敲下 `helixent` 之后到底发生了什么？模型配置和第 15 节的审批白名单，究竟存在哪、怎么读写？
>>
>
> **一句边界声明**：本节精讲 **`src/cli/` 下的「外壳 + 落盘」这半边**——注意，是**半边**。`src/cli/` 目录很大，但它其实由两块拼成：一块是**「命令行外壳 + 配置持久化」**（本节），另一块是**「TUI 界面」**（`tui/*`，留给第 19～20 节）。本节精讲的文件清单如下，可分为**四组**：
>
> - **入口分流**：[cli/index.tsx](../../src/cli/index.tsx)（92 行，`Commander` 解析 argv → 「有参跑子命令 / 无参进 TUI」的三岔路口，也是**全书所有零件的最终装配现场**）。
> - **config 持久化（YAML）**：[config/schema.ts](../../src/cli/config/schema.ts)（25 行，用 Zod 给 `config.yaml` 立法）、[config/index.ts](../../src/cli/config/index.ts)（73 行，`HELIXENT_HOME` 解析 + 原子写 + setup 检测）。
> - **Commander 子命令 + 首次运行向导**：[commands/*](../../src/cli/commands/index.ts)（`config model add/list/remove/set-default` 四条子命令）、[model-providers.ts](../../src/cli/model-providers.ts)（27 行，11 家厂商注册表）、[bootstrap/*](../../src/cli/bootstrap/index.ts)（完整性检查 + 首次运行向导 + 加模型向导）。
> - **settings 持久化（JSON，落地第 15 节契约）**：[settings/settings.ts](../../src/cli/settings/settings.ts)（`appendToolToAllowList` 纯合并函数 + Zod schema）、[settings-loader.ts](../../src/cli/settings/settings-loader.ts)（124 行，三层合并 + `loadAllowList`）、[settings-writer.ts](../../src/cli/settings/settings-writer.ts)（34 行，`appendAllowedTool` 只写 local 层）。
>
> **本节最大的「啊哈时刻」**：Helixent 有**两套完全独立的持久化系统**，很多人第一次读会把它们混为一谈——但它们**格式不同（YAML vs JSON）、位置不同（单一全局文件 vs 三层文件）、职责不同（「用哪个模型」vs「哪些工具免审批」）、写法不同（原子替换整份 vs 增量并入 local 层）**。看懂「为什么模型配置用 `config.yaml`、审批白名单却用 `settings.json` 三层」，你就理解了 Helixent 对「配置」这件事的分层哲学：**「机器要连哪、用什么钥匙」是全局唯一的账户信息，而「哪些危险操作我信得过」是可以按项目、按人、按机器分层叠加的信任策略**。这两件事，天然就该用两套机制。
>
> ⚠️ **一处「诚实标注」**：本节会**多次点到 TUI**（`render(<App/>)`、`AgentLoopProvider`、first-run 向导用的 Ink 组件），但**只讲到「把它们实例化并挂载」为止**——它们内部「React 如何渲染到终端、状态如何流转」的机制，是第 19～20 节的任务。凡是遇到 TUI 组件，本节一律「装配即止」，并给出后续章节的链接。请把本节读成一部**「开机启动脚本 + 磁盘读写手册」**，而不是「界面教程」。

---

## 0. 承上启下

[第 17 节](./17-anthropic-provider.md) 在结尾把这个悬念埋得明明白白，几乎是「点名」本节。它的原话是这样的：

> 但请注意 [第 15 节](./15-human-in-the-loop.md) 结尾埋下、至今**仍未兑现**的那个空白——两个 Manager（审批、提问）都还在「等一个 UI 来 `subscribe` 并 `respond`」；以及本节 1.8 那个 `cli/index.tsx` 里的分流代码，它读的 `entry.baseURL` / `entry.APIKey` 究竟**从哪来、存在哪、怎么读写**？

而更早的 [第 15 节](./15-human-in-the-loop.md)，在讲 `approval-persistence.ts` 时也留了同一个钩子：

> `approval-persistence` 只定义「白名单读写契约」，具体落盘留到第 18 节。

本节就来一次性兑现这两处伏笔。而在动手前，请先把**两条上游结论**装进脑子——它们是本节每一处设计的直接前提：

1. **[第 15 节](./15-human-in-the-loop.md) 的 `ApprovalPersistence` 契约。** 它只是一对**函数类型签名**（在 [approval-persistence.ts](../../src/coding/permissions/approval-persistence.ts) 里）：

   ```ts
   export type ApprovalPersistence = {
     loadAllowList: (cwd: string) => Promise<Set<string>>;
     persistAllowedTool: (cwd: string, toolName: string) => Promise<void>;
   };
   ```

   第 15 节反复强调：`coding` 层**只认这个契约、绝不碰磁盘**——`createCodingApprovalMiddleware` 里 `loadAllowList` 默认是「返回空集合」，`persistAllowedTool` 默认是「什么都不做」。**谁来提供真实的读写实现？** 第 15 节把这个问题原封不动推给了本节。本节的 `SettingsLoader` / `SettingsWriter` 就是那对签名的**唯一真实实现**。
2. **[第 16～17 节](./16-openai-provider.md) 的两个 `ModelProvider` 实现，以及它们的构造参数。** 两个 provider 的 `constructor` 都收 `{ baseURL, apiKey }`。第 17 节结尾专门点了一句：「`cli/index.tsx` 里 `if (entry.provider === "anthropic")` 分流实例化……`baseURL`/`apiKey` 从配置读入。」**这个 `entry` 到底是什么、从哪读？** 也留给了本节。答案就是本节 1.3 要讲的 `ModelEntry`——一条存在 `config.yaml` 里的模型配置记录。

准备好了。我们先不看任何一个具体文件，而是先建立**「一次启动的两条命运线」+「两套持久化系统」**的全局地图——因为本节最容易让人迷路的地方，就是**把「配置模型」和「审批白名单」这两套持久化搞混**。有了地图，再逐个击破。

---

## 1. 主题内容

### 1.1 先建立地图：一次启动的「两条命运线」与磁盘上的「两套持久化」

Helixent 是一个 CLI 程序，它的生命从 `index.ts`（项目根）转入 [cli/index.tsx](../../src/cli/index.tsx) 开始。整个 `src/cli/` 目录看似庞杂，但只要抓住**两个正交的维度**，就一目了然：

**维度一：一次启动，分成「两条命运线」**（由命令行有没有参数决定）：

```
                        $ helixent [args...]
                                │
                     Commander 解析 argv
                                │
              ┌─────────────────┴──────────────────┐
       args.length > 0                       args.length === 0
              │                                     │
      【命运线 A：跑子命令】                  【命运线 B：进 TUI】
      helixent config model add            (1) 完整性检查 validateIntegrity
      helixent config model list               └─ 没配置？跑「首次运行向导」
      helixent config model remove         (2) loadConfig() 读默认模型
      helixent config model set-default    (3) 按 provider 实例化 Provider（§16/§17）
              │                            (4) 组装 Model + Agent + settings 持久化
       操作 config.yaml 后退出              (5) render(<App/>) 把舞台交给 TUI（§19）
              │                                     │
           进程结束                          进入交互式对话，直到用户退出
```

**维度二：磁盘上，有「两套持久化」**（很多人会混淆，务必分清）：

| 维度                     | ① 模型配置                                                       | ② 审批白名单                                                     |
| ------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| **存什么**         | 有哪些模型、各自的`baseURL`/`APIKey`/`provider`、默认用哪个 | 哪些危险工具「本项目免审批」                                      |
| **文件**           | `~/.helixent/config.yaml`（**单一全局文件**）             | `settings.json`（**三层**：用户级 / 项目级 / 项目本地级） |
| **格式**           | **YAML**                                                    | **JSON**                                                    |
| **谁读**           | `cli/index.tsx` 启动时读一次、`commands/*` 增删改             | 每次工具审批前`loadAllowList` 读（第 15 节中间件）              |
| **谁写**           | `saveConfig`（**原子替换整份**）                          | `appendAllowedTool`（**增量并入 local 层**）              |
| **主要代码**       | `config/*`、`commands/*`、`bootstrap/*`                     | `settings/*`                                                    |
| **对接的上游契约** | 第 16/17 节 provider 的`{baseURL, apiKey}`                      | 第 15 节的`ApprovalPersistence`                                 |

**记住这张表**：本节接下来的 1.2 讲「命运线的分岔点」（`cli/index.tsx`），1.3～1.7 讲**持久化①**（配置模型：schema → 读写 → 子命令 → 向导），1.8 讲**持久化②**（审批白名单：落地第 15 节契约），1.9 再回到 `cli/index.tsx` 把两条线在「装配现场」合流。**每讲一个文件，我都会先标注它属于哪条命运线、动的是哪套持久化**，你就不会迷路。

**一个关键澄清（现在就说清，免得后面绕）**：`~/.helixent/` 这个目录（下面简称「Helixent 家目录」）里**同时住着两套持久化的一部分**——`config.yaml`（配置①）和 `settings.json`（白名单②的**用户级**那一层）。它们同处一室，但互不相干。而白名单②的另外两层（项目级、项目本地级）住在**你当前项目**的 `<cwd>/.helixent/` 里。这个「家目录 vs 项目目录」的分野，1.4 和 1.8 会各讲一半。

### 1.2 `cli/index.tsx`：入口分流 —— `args.length` 的三岔路口

先看整个程序的「大脑分岔点」。[cli/index.tsx](../../src/cli/index.tsx) 开头做的第一件事，是用 [Commander](https://github.com/tj/commander.js) 建一个 `program`，注册元信息与所有子命令：

```ts
const program = new Command();
program
  .name(HELIXENT_NAME)
  .description("Helixent — a blue rabbit that writes code")
  .version(HELIXENT_VERSION, "-v, --version");

registerCommands(program);
```

这里的 `HELIXENT_NAME` / `HELIXENT_VERSION` 来自 [version.ts](../../src/cli/version.ts)——它直接 `import pkg from "../../package.json"`，把 `package.json` 里的 `name` / `version` 拎出来（这样「版本号只有一处真相」，`-v` 打印的永远和发布版本一致，第 21 节会再提这种「单一真相源」约定）。`registerCommands(program)` 则把 `config model *` 一整棵子命令树挂上去（1.5 细讲）。

**真正的分岔在这三行**：

```ts
const args = process.argv.slice(2);

if (args.length > 0) {
  await program.parseAsync(process.argv);
} else {
  // ... 进 TUI（命运线 B）
}
```

- **`args.length > 0`（命运线 A）**：说明用户敲的是 `helixent config model add` 这类**带参命令**。直接交给 `program.parseAsync`，Commander 会匹配到对应子命令的 `action` 回调、执行、退出。**这条线根本不碰 TUI、不实例化模型、不启动 Agent**——它是纯粹的「配置管理 CLI」。
- **`args.length === 0`（命运线 B）**：说明用户只敲了一个光秃秃的 `helixent`。这才进入「启动交互式 Agent」的完整流程。

这个「有参 / 无参」的分流是 CLI 设计里极常见的模式（`git` 敲 `git` 什么都不干、`git commit` 才干活是另一路；但像 `docker`、`npm` 无参时打印帮助）。Helixent 选择「无参 = 进入主界面」，是因为它的**主要用途就是对话**，配置只是偶尔为之的辅助操作——把最高频的用途放在「零参数」这个最短路径上，符合直觉。

**本小节先只看到这个「岔路口」。** 命运线 A（子命令）的落点在 1.5，命运线 B（进 TUI）的完整装配在 1.9。中间的 1.3～1.4、1.6～1.8，是这两条线**共同依赖的底层设施**（配置读写、厂商注册表、向导、白名单落盘）——必须先把它们讲透，1.9 的装配才看得懂。

我们从两条命运线都要用到的「配置持久化」讲起。

### 1.3 `config/schema.ts`：用 Zod 给 `config.yaml` 立法（持久化①的「宪法」）

> **这属于持久化①（模型配置）。** 它是本节 1.3～1.7 的主角。

在读写任何配置之前，得先回答一个问题：**`~/.helixent/config.yaml` 里到底该长什么样？** [config/schema.ts](../../src/cli/config/schema.ts) 用 Zod 给出了「立法级」的回答——它既是**运行期的校验器**，又是**编译期的类型来源**（这正是 [第 4 节](./04-tool.md) 讲过的 Zod「一处定义、两处受益」的又一次应用）：

```ts
export const modelEntrySchema = z.object({
  name: z.string().min(1),
  baseURL: z.string().min(1),
  APIKey: z.string().min(1),
  /** Provider type: "openai" (default) or "anthropic". */
  provider: z.enum(["openai", "anthropic"]).optional().default("openai"),
});

export const helixentConfigSchema = z.object({
  models: z.array(modelEntrySchema).min(1),
  defaultModel: z.string().min(1).optional(),
}).superRefine((val, ctx) => {
  if (val.defaultModel && !val.models.some((m) => m.name === val.defaultModel)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `defaultModel "${val.defaultModel}" does not match any configured model name`,
      path: ["defaultModel"],
    });
  }
});

export type HelixentConfig = z.infer<typeof helixentConfigSchema>;
export type ModelEntry = z.infer<typeof modelEntrySchema>;
```

**逐条拆解这份「宪法」**：

1. **`ModelEntry`——一条模型记录**。四个字段：`name`（模型名，也是「主键」）、`baseURL`（厂商 API 地址）、`APIKey`（钥匙）、`provider`（`"openai"` | `"anthropic"`）。前三个都用 `.min(1)` 强制**非空字符串**——空的 `baseURL` 或 `APIKey` 是配置里最常见的「手滑」，Zod 在读盘那一刻就把它拦下（对应 [schema.test.ts](../../src/cli/config/__tests__/schema.test.ts#L53-L78) 里那三条 `rejects empty ...` 测试）。

   > **回收第 17 节的伏笔**：注意 `provider` 字段——它就是第 17 节结尾说的、`cli/index.tsx` 里 `if (entry.provider === "anthropic")` 分流所依据的那个值。这里用 `z.enum` 把它锁死成两个合法值，`.optional().default("openai")` 意味着：**老配置文件里没有这个字段也能读，且默认当成 OpenAI**——这是一个**向后兼容**的贴心设计（1.3 末尾会展开）。
   >
2. **`HelixentConfig`——整份配置**。两个字段：`models`（模型数组，`.min(1)` 要求**至少一条**）和 `defaultModel`（默认模型名，可选）。
3. **`.superRefine` 做「跨字段一致性校验」**。单看 `models`、`defaultModel` 各自合法还不够——还得保证 `defaultModel` **确实指向一个存在的模型**。`z.object` 的普通校验只能管单字段，管不了「A 字段的值必须在 B 字段里能找到」这种**关联约束**，所以用 `superRefine`：只要 `defaultModel` 设了、却在 `models` 里找不到同名项，就 `addIssue` 报一条自定义错误（对应 [schema.test.ts](../../src/cli/config/__tests__/schema.test.ts#L116-L124) 的 `rejects defaultModel that does not match`）。**这一条把「悬空的默认模型」这种脏状态挡在了门外**——否则启动时按 `defaultModel` 去找模型会找到 `undefined`，崩在更晚、更难查的地方。
4. **`z.infer` 反向导出 TS 类型**。`HelixentConfig` 和 `ModelEntry` 两个类型**不是手写的**，而是从 schema 用 `z.infer` **推导**出来的。好处是：schema 改一个字段，类型自动跟着变，**永远不会出现「schema 和类型对不上」的漂移**。全项目哪里用到配置对象，`import type { ModelEntry }` 即可，拿到的永远是这份 schema 的最新形状。

**`.optional().default("openai")` 的深意——向后兼容**：Helixent 早期可能只支持 OpenAI，那时的 `config.yaml` 里根本没有 `provider` 字段。等到第 17 节加入 Anthropic，就必须回答「老配置怎么办」。这里的答案很优雅：`provider` **可选**（老文件不写也合法）+ **默认 `"openai"`**（不写就当成 OpenAI，与老行为完全一致）。于是**升级 Helixent 不需要用户改任何配置文件**——这是「schema 演进」的教科书式处理。对应 [schema.test.ts](../../src/cli/config/__tests__/schema.test.ts#L41-L51) 的 `defaults provider to openai when not specified`。

### 1.4 `config/index.ts`：`HELIXENT_HOME` 解析、原子写与 setup 检测

> **这仍属于持久化①（模型配置）。** schema 是「宪法」，[config/index.ts](../../src/cli/config/index.ts) 就是「执法机构」——它负责**算出文件在哪、怎么安全地读写、以及判断「初始化完成了没」**。

这个文件不长（73 行）却职责密集，可分为**三组函数**：

**第一组：路径解析（文件到底在哪）**

```ts
const DEFAULT_REL = ".helixent";
const CONFIG_FILENAME = "config.yaml";

export function getDefaultHelixentHome(): string {
  return path.join(homedir(), DEFAULT_REL);   // ~/.helixent
}

export function getHelixentHomePath(): string {
  const v = Bun.env.HELIXENT_HOME?.trim();
  if (!v) {
    throw new Error("HELIXENT_HOME is not set");
  }
  return path.resolve(v);
}

export function getConfigFilePath(): string {
  return path.join(getHelixentHomePath(), CONFIG_FILENAME);   // <home>/config.yaml
}
```

这里有一个**关键的设计决策**：家目录**优先读环境变量 `HELIXENT_HOME`**，只有它没设时才回退到默认的 `~/.helixent`。为什么要绕这一层？

- **可测试性**：测试时把 `HELIXENT_HOME` 指到一个临时目录，就能完全隔离地测配置读写，不会污染开发者真实的 `~/.helixent`。
- **可移植性**：CI、Docker、多用户环境里，可以把配置放到任意位置。
- **注意** `getHelixentHomePath` 在 `HELIXENT_HOME` **未设置时直接抛错**，而不是默默回退——这是「fail fast」。它要求调用方**必须先确保环境变量已设置**。谁来设置？就是下面第三组的 `ensureHelixentHomeEnv`。

**第二组：读与写（`loadConfig` / `saveConfig`）**

```ts
export function loadConfig(): HelixentConfig {
  const p = getConfigFilePath();
  const raw = readFileSync(p, "utf8");
  const parsed: unknown = parse(raw);            // yaml.parse
  return helixentConfigSchema.parse(parsed);     // ← 读盘即校验
}

export function saveConfig(config: HelixentConfig): void {
  const validated = helixentConfigSchema.parse(config);   // ← 写盘也先校验
  const content = stringify(validated, { lineWidth: 0 });
  const target = getConfigFilePath();
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, target);                       // ← 原子替换
}
```

两处「妙笔」：

1. **读写两端都过 `helixentConfigSchema.parse`**。`loadConfig` 读进来先校验——磁盘上被手工改坏的 YAML（比如删光了 `models`）会在这里被 Zod 拦下、抛出清晰错误，而不是带着脏数据往下跑。`saveConfig` 写出去**也**先校验——保证「凡是落盘的配置，一定是合法的」，程序自己也不会写出脏文件。**schema 成了读写两个方向共同的「关卡」**，这正是 1.3 那份「宪法」的执法现场。
2. **`saveConfig` 用「临时文件 + `rename`」做原子写**。它不直接往 `config.yaml` 里写，而是先写一个带 `pid` 和时间戳的临时文件（`config.yaml.12345.1699...tmp`），写完再 `renameSync` 到目标名。**为什么？** 因为 `rename` 在同一文件系统上是**原子操作**——要么整份换成新的，要么保持旧的，**绝不会出现「写到一半进程被杀、留下半个残缺 YAML」的情况**。`pid`+时间戳后缀则避免了多进程同时写时临时文件互相踩踏。这是「安全写文件」的经典手法，第 21 节讲工程质量时还会再遇到类似思路。

**第三组：环境与目录的「就绪保障」**

```ts
export function isHelixentSetupComplete(): boolean {
  const home = getHelixentHomePath();
  if (!existsSync(home) || !statSync(home).isDirectory()) {
    return false;
  }
  return existsSync(getConfigFilePath());
}

export function ensureHelixentHomeDirectory(): void {
  mkdirSync(getHelixentHomePath(), { recursive: true });
}

export function ensureHelixentHomeEnv(): void {
  if (!process.env.HELIXENT_HOME?.trim()) {
    const p = getDefaultHelixentHome();
    process.env.HELIXENT_HOME = p;
    if (typeof Bun !== "undefined") {
      Bun.env.HELIXENT_HOME = p;
    }
  }
}
```

- **`isHelixentSetupComplete`**：判断「初始化到底完成没」——家目录存在**且**是目录、**且** `config.yaml` 存在，三者全真才算就绪。它是「首次运行向导要不要跑」的**判断依据**（1.6 会用到）。
- **`ensureHelixentHomeDirectory`**：`mkdir -p` 语义，确保家目录存在（`recursive: true` 意味着父目录不存在也一并建，且已存在时不报错）。
- **`ensureHelixentHomeEnv`**：这就是上面 `getHelixentHomePath` 「fail fast」所依赖的**前置动作**——如果 `HELIXENT_HOME` 没设，就把它设成默认的 `~/.helixent`（**同时写 `process.env` 和 `Bun.env` 两处**，因为 Helixent 跑在 Bun 上，代码里两种读法都有）。**几乎每一条子命令的 `action` 第一行都会先调它**（1.5 会看到），保证后续所有「读 `HELIXENT_HOME`」的调用都不会踩到「未设置」的雷。

**这三组函数合起来，就是持久化①的完整基础设施**：算路径、原子读写、就绪检测。下面 1.5 的子命令、1.6 的向导、1.9 的启动，全都站在它们之上。

### 1.5 `commands/*`：`config model add/list/remove/set-default` 四条子命令（命运线 A 的落点）

> **这是命运线 A 的终点，动的是持久化①。** 回到 1.2 那个岔路口：当 `args.length > 0`，`program.parseAsync` 会把控制权交给这里注册的某条子命令。

Helixent 的子命令用「**注册函数逐层嵌套**」的方式组织，形成一棵和目录结构一一对应的命令树。层层 `register` 的调用链是：

```
registerCommands(program)                    commands/index.ts
  └─ registerConfigCommands(program)         commands/config/index.ts
        program.command("config")
        └─ registerModelCommands(config)     commands/config/model/index.ts
              config.command("model")
              ├─ registerAddCommand(model)        → helixent config model add
              ├─ registerListCommand(model)       → helixent config model list
              ├─ registerRemoveCommand(model)     → helixent config model remove
              └─ registerSetDefaultCommand(model) → helixent config model set-default
```

最外层 [commands/index.ts](../../src/cli/commands/index.ts) 只有一句 `registerConfigCommands(program)`；[commands/config/index.ts](../../src/cli/commands/config/index.ts) 建一个 `config` 子命令、把 `model` 挂上去；[commands/config/model/index.ts](../../src/cli/commands/config/model/index.ts) 再把四条叶子命令挂到 `model` 下。**这种「一个文件一层、每层一个 `register*` 函数」的拆法**，好处是每条命令的实现都独立成文件、互不干扰，新增一条命令只要写个新文件 + 在父级 `register` 里加一行——是「[第 1 节](./01-overview.md) 里那套『小文件、单一职责、桶文件聚合』约定」在 CLI 层的又一次体现。

**四条命令的实现，全都是同一个套路**（读配置 → 改内存 → `saveConfig` 写回），我们精讲最典型的 `add`，其余三条对照着看即可。

**`add`——加一个模型**（[commands/config/model/add.ts](../../src/cli/commands/config/model/add.ts)）：

```ts
parent
  .command("add")
  .description("Add a new model configuration")
  .action(async () => {
    ensureHelixentHomeEnv();          // ① 先保证 HELIXENT_HOME 已设
    ensureHelixentHomeDirectory();    // ② 保证家目录存在

    const entry = await runModelWizard();   // ③ 交互式向导收集一条 ModelEntry（1.6 讲）

    let models: ModelEntry[];
    let defaultModel: string | undefined;
    try {
      if (isHelixentSetupComplete()) {      // ④ 已有配置就读出来、往上追加
        const config = loadConfig();
        models = config.models;
        defaultModel = config.defaultModel;
      } else {
        models = [];
      }
    } catch {
      models = [];                          // ⑤ 读失败（脏文件）也不崩，当空处理
    }

    models.push(entry);
    saveConfig({ models, defaultModel: defaultModel ?? entry.name });  // ⑥ 原子写回
    console.info(`\nModel "${entry.name}" added. Config saved to: ${getConfigFilePath()}`);
  });
```

把这六步和 1.4 的基础设施对照，套路就清清楚楚：

1. **`ensureHelixentHomeEnv()` + `ensureHelixentHomeDirectory()` 打头**——这就是 1.4 说的「每条命令第一行先确保环境与目录就绪」，后续所有 `getConfigFilePath` 才不会踩雷。
2. **`runModelWizard()` 收集输入**——弹一个 Ink 向导让用户选厂商、填 key、填模型名（1.6 讲），返回一条校验过的 `ModelEntry`。
3. **「读旧 → 追加 → 写回」**——`add` 不能覆盖已有配置，所以先 `loadConfig` 把已有 `models` 读出来，`push` 新条目，再整份 `saveConfig`。
4. **容错兜底**（第 ⑤ 步的 `catch { models = [] }`）：如果磁盘上是一份读不动的脏配置，`add` 不会崩，而是**当作「从空开始」**，让用户至少能加进一个能用的模型来自救。
5. **`defaultModel ?? entry.name`**：如果之前没有默认模型（第一次加），就把这条新加的设为默认——**保证「加完至少有一个默认模型」这个不变量**，正好满足 1.3 那条 `superRefine`（默认模型必须存在）。

**其余三条，一句话各表**：

- **`list`**（[list.ts](../../src/cli/commands/config/model/list.ts)）：只读。`isHelixentSetupComplete` 为假就提示「还没配置」；否则遍历打印每个模型的序号、名字、`baseURL`，以及**打码后的 API Key**（`****` + 后四位，`m.APIKey.slice(-4)`）——**永不完整打印密钥**，这是安全惯例。默认模型标 `(default)`。
- **`remove [model_name]`**（[remove.ts](../../src/cli/commands/config/model/remove.ts)）：删一个。有几处防御值得学：**不允许删到只剩零个**（`models.length === 1` 时报错退出，呼应 1.3 的 `.min(1)`）；**删掉的若正好是默认模型，自动把默认改成剩下的第一个**（`config.defaultModel = config.models[0]?.name`）——又一次维护「默认模型必须存在」的不变量。
- **`set-default [model_name]`**（[set-default.ts](../../src/cli/commands/config/model/set-default.ts)）：改默认。先确认目标名存在，再 `config.defaultModel = resolvedName` 写回。

**一个共享的交互细节——`promptSelectModelName`**（[prompt-select-model.ts](../../src/cli/commands/config/model/prompt-select-model.ts)）：`remove` 和 `set-default` 都支持「不带参数」调用（`remove [model_name]` 里的 `[]` 表示可选）。此时没有指定模型名，就调这个函数弹一个**编号选择菜单**让用户挑。它有一处很讲究的健壮性处理：

```ts
// Commander actions can be invoked in contexts where stdin is not a TTY
// (e.g. when stdin is piped), even though the user is still at a terminal.
// Use /dev/tty when available so interactive selection still works.
const input = process.stdin.isTTY ? process.stdin : createReadStream("/dev/tty");
const output = process.stdout.isTTY ? process.stdout : createWriteStream("/dev/tty");
```

当 `stdin` 被管道占用（比如 `echo x | helixent ...`）而非真正的终端时，直接读 `process.stdin` 会读到管道内容而非用户按键。这里**回退到直接打开 `/dev/tty`**——那是「当前控制终端」的设备文件，能绕过管道直接和用户的键盘/屏幕对话。这是命令行工具处理「交互 + 管道」共存的老练技巧。

**至此，命运线 A 讲完了**：四条子命令全都是「`ensure*` 就绪 → 读/改内存 → `saveConfig` 原子写回」的变奏，操作的对象始终是持久化①的 `config.yaml`，且处处维护「至少一个模型、默认模型必存在」两条不变量。**它们跑完就退出，永远不进 TUI。**

### 1.6 `model-providers.ts` + `bootstrap/*`：厂商注册表与首次运行向导

> **这是命运线 A（`add` 命令）和命运线 B（首次启动）共享的输入设施，产出的是持久化①的 `ModelEntry`。**

1.5 的 `add` 命令里调了一个 `runModelWizard()`，1.2 的命运线 B 里也提到「没配置就跑首次运行向导」。这两个「向导」都来自 `bootstrap/*`，而它们展示给用户选的「厂商清单」来自 [model-providers.ts](../../src/cli/model-providers.ts)。先看这份清单：

```ts
export type ProviderType = "openai" | "anthropic";

export type ModelProviderConfig = {
  label: string;        // 显示给用户看的名字
  id: string;           // 内部标识
  baseURL: string;      // 预置的 API 地址（"" 表示要用户自己填）
  providerType: ProviderType;   // 决定用哪个 ModelProvider 实现
};

export const MODEL_PROVIDERS: ModelProviderConfig[] = [
  { label: "Anthropic (Claude)", id: "anthropic", baseURL: "https://api.anthropic.com", providerType: "anthropic" },
  { label: "OpenAI", id: "openai", baseURL: "https://api.openai.com/v1", providerType: "openai" },
  { label: "Volcengine - General", id: "volcengine", baseURL: "https://ark.cn-beijing.volces.com/api/v3", providerType: "openai" },
  // ... Qwen / Minimax / GLM / Kimi / DeepSeek ...
  { label: "Other", id: "other", baseURL: "", providerType: "openai" },
];
```

**这份注册表是「把两个 Provider 实现（第 16/17 节）翻译成用户能懂的选项」的关键一环**，有三个设计点：

1. **`providerType` 就是 1.3 那个 `provider` 字段的来源**。你会发现清单里**只有 Anthropic 一家是 `"anthropic"`，其余全是 `"openai"`**——这印证了第 16 节的核心结论：**OpenAI 的 wire 协议是「兼容生态」的事实标准**，Volcengine、Qwen、GLM、Kimi、DeepSeek 等一大批厂商都兼容它，因此都能复用 `OpenAIModelProvider`；只有 Anthropic 自成一派，需要 `AnthropicModelProvider`。**「11 个选项，却只有 2 个 Provider 实现」——这就是第 16/17 节那套抽象省下的成本。**
2. **`baseURL` 预置**：常见厂商直接内置了 `baseURL`，用户选完不用再手输——降低配置门槛。
3. **`"Other"` 兜底且 `baseURL: ""`**：清单最后留一个「Other」，`baseURL` 为空。空 `baseURL` 是一个**信号**——向导据此判断「要额外弹一步让用户手输自定义地址」（下面就会看到）。这让「接一个清单里没有、但兼容 OpenAI 的私有部署」成为可能。

接着看 `bootstrap/` 的三个文件：

**`integrity.ts`——完整性检查（命运线 B 的第一道关）**：命运线 B 启动时第一件事就是 `await validateIntegrity()`（1.9 会看到）。它的逻辑是：

```ts
export async function validateIntegrity(): Promise<void> {
  ensureHelixentHomeEnv();

  if (isHelixentSetupComplete()) {
    try {
      const config = loadConfig();
      if (config.models.length > 0) {
        return;                    // ← 已有可用配置，直接放行
      }
    } catch (err) {
      // ... 特判「models: [] 空数组」的情况，容忍它、往下走 bootstrap
    }
  }

  ensureHelixentHomeDirectory();
  try {
    const config = await runFirstRunWizard();   // ← 没配置，跑首次运行向导
    saveConfig(config);
    console.info(`\n\nHelixent setup completed. ...`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
```

它的职责是回答一个问题：**「这台机器能不能跑起来？」** ——即「有没有至少一个可用模型」。如果 `isHelixentSetupComplete()` 且能 `loadConfig()` 出非空 `models`，直接 `return` 放行；否则就 `runFirstRunWizard()` 引导用户现场配一个，配完 `saveConfig` 落盘。注意它对「`config.yaml` 存在但 `models: []`」这种半初始化状态做了**专门的容错特判**（因为 1.3 的 schema 要求 `models.min(1)`，这种文件会导致 `loadConfig` 抛错，但这里不该崩，而应引导重配）——这是「不信任磁盘上任何一种脏状态」的防御性编程。

**`first-run-wizard.tsx`——首次运行向导**（[first-run-wizard.tsx](../../src/cli/bootstrap/first-run-wizard.tsx)）：它先用 Ink 渲染一个 `WelcomeScreen`（打印 ASCII art 的 "HELIXENT" logo + 一句欢迎语，Enter 继续 / Esc 退出），然后调 `runModelWizard()` 收集一条模型配置，最后拼成一份**最小可用配置**返回：

```ts
export async function runFirstRunWizard(): Promise<HelixentConfig> {
  await showWelcomeScreen();
  const entry = await runModelWizard();
  return { models: [entry], defaultModel: entry.name };   // ← 单模型 + 设为默认
}
```

返回的配置**恰好满足 1.3 的两条约束**（`models` 非空、`defaultModel` 指向存在的模型）——首次配置的用户不用懂这些约束，向导替他保证了。

**`model-wizard.tsx`——加模型向导**（[model-wizard.tsx](../../src/cli/bootstrap/model-wizard.tsx)，223 行，是 bootstrap 里最重的一个）：它是一个 Ink 组件，用一个 `step` 状态机走 5 步：`provider`（↑↓ 选厂商）→ `apiKey`（输入 key，用 `mask="*"` 打码）→ `modelName`（输入模型名）→ 可能的 `baseURL`（**仅当选了 `baseURL: ""` 的「Other」时才出现这一步**）→ `confirm`（最后确认，显示打码后的 key，Enter 确认 / n 重来）。确认后通过 `buildModelEntry` 拼出一条 `ModelEntry` 交回调。

```ts
const goFromModelName = () => {
  if (!selectedProvider.baseURL) {       // ← 1.6 说的「空 baseURL 是信号」
    setStep("baseURL");                  //   选了 Other，多走一步手输地址
  } else {
    const entry = buildModelEntry(selectedProvider.baseURL, apiKey, modelName, selectedProvider.providerType);
    setPendingEntry(entry);
    setStep("confirm");                  //   预置了地址，直接进确认
  }
};
```

**注意本节对这个向导的边界**：它是一个 React/Ink 组件，`useInput` 处理按键、`useState` 管步骤——这些「Ink 怎么用 React 写终端界面」的机制，是**第 19～20 节**的主题。本节只需知道：**它是持久化①的「输入端」——把用户的选择收集成一条合法 `ModelEntry`，交给 `add` 命令或 `validateIntegrity` 去 `saveConfig`。** 它产出的 `providerType` 会写进 `ModelEntry.provider`，最终决定 1.9 装配时实例化哪个 Provider。

**小结这条输入链**：`MODEL_PROVIDERS`（有哪些厂商）→ `model-wizard`（收集用户选择）→ `ModelEntry`（一条配置记录）→ `saveConfig`（落盘到 `config.yaml`）。命运线 A 的 `add` 和命运线 B 的首次启动，都走这同一条链。

### 1.7 `settings/*`：落地第 15 节的审批白名单契约（持久化②）

> **切换舞台——从这里开始讲持久化②（审批白名单）。** 前面 1.3～1.6 全是「配置模型」（`config.yaml`）；本小节完全另起一摊，讲的是 [第 15 节](./15-human-in-the-loop.md) 那份「白名单读写契约」的**真实落盘实现**。请务必把它和前面切割开——它**格式是 JSON、分三层、增量写入**，和 `config.yaml` 毫无关系。

**先回到第 15 节的悬念**。[第 15 节](./15-human-in-the-loop.md) 的审批中间件里有这么一段（`coding-approval-middleware.ts`）：当用户对某个危险工具选择「永久允许（本项目）」时，中间件会调 `persistAllowedTool` 把它记下来；而每次审批前，又会先 `loadAllowList` 看看这个工具是不是已经在白名单里、在的话就免审批直接放行：

```ts
const loadAllowList = options.approvalPersistence?.loadAllowList ?? emptyAllowList;
const persistAllowedTool = options.approvalPersistence?.persistAllowedTool;
// ...
const allowed = await loadAllowList(options.cwd);
if (allowed.has(toolUse.name)) return;           // 已在白名单 → 免审批
// ...
if (decision === "allow_always_project" && persistAllowedTool) {
  await persistAllowedTool(options.cwd, toolUse.name);   // 记住这个决定
}
```

但第 15 节反复强调：`coding` 层**只持有这对函数的类型签名（`ApprovalPersistence`），自己绝不碰磁盘**——`approvalPersistence` 是可选的，不注入时 `loadAllowList` 默认返回空集、`persistAllowedTool` 压根不存在。**「谁来提供真实的读写？」这个问题，第 15 节明确甩给了第 18 节。** `settings/*` 三个文件就是答案。

**为什么白名单不复用 `config.yaml`，而要另起一套 `settings.json`？** 这是本小节最该想清的问题。因为「哪些工具免审批」这件事，天然需要**分层**：

- 有些信任是**跨所有项目**的（比如「我永远信任 `read_file`」）——该放在**用户级**（`~/.helixent/settings.json`）。
- 有些信任是**某个项目专属**的（比如「这个项目里 `bash` 免审批」）——该放在**项目级**（`<项目>/.helixent/settings.json`，可提交进 Git、团队共享）。
- 还有些是**「只在我这台机器上」**的临时信任——该放在**项目本地级**（`<项目>/.helixent/settings.local.json`，通常 `.gitignore` 掉，不共享）。

而「用哪个模型」是**全局唯一**的账户信息，没有分层需求。**「一个要分层叠加、一个全局唯一」——这就是两套持久化必须分开的根本原因。** 这个「三层 settings + `.local` 不入库」的布局，直接对标了 **Claude Code / VS Code** 的 settings 分层模型（3.x 会展开对比）。

三个文件分工如下：

**`settings.ts`——schema + 纯合并函数**（[settings.ts](../../src/cli/settings/settings.ts)）：

```ts
export const settingsSchema = z
  .object({
    permissions: z
      .object({ allow: z.array(z.string()).optional() })
      .passthrough()      // ← 允许 permissions 里有未知字段（如未来的 deny）
      .optional(),
  })
  .passthrough();         // ← 允许顶层有未知字段（前向兼容）

export function appendToolToAllowList(document, toolName) {
  const permissions = /* 安全地取出已有 permissions（非对象/数组则视为空）*/;
  const existing = /* 取出 allow 数组、过滤掉非字符串项 */;
  const allow = existing.includes(toolName) ? existing : [...existing, toolName];  // 去重
  return { ...document, permissions: { ...permissions, allow } };
}
```

两个要点：

1. **`.passthrough()` 双层前向兼容**：schema 只关心 `permissions.allow`，但顶层和 `permissions` 里都用 `.passthrough()` 允许**未知字段原样保留**。这样即便未来加了 `permissions.deny`、或用户手写了别的字段，本版本读写时也不会把它们弄丢（对应 [settings.test.ts](../../src/cli/settings/__tests__/settings.test.ts#L18-L31) 的 passthrough 测试）。这是「配置格式前向兼容」的关键——**只读你懂的，别动你不懂的**。
2. **`appendToolToAllowList` 是纯函数**：它不碰磁盘，只做「把一个工具名并进 allow 数组」的**纯计算**——已存在则去重、非对象的 `permissions` 优雅降级成空对象、过滤掉数组里的非字符串脏值、保留文档里的其他字段。**把「合并逻辑」抽成无副作用的纯函数**，好处是能被 [settings.test.ts](../../src/cli/settings/__tests__/settings.test.ts#L34-L104) 那一大批用例**脱离文件系统单测**（第 21 节会讲这种「纯函数易测」的价值），真正写盘的 `SettingsWriter` 只要调它一次即可。

**`settings-loader.ts`——三层加载与合并**（[settings-loader.ts](../../src/cli/settings/settings-loader.ts)）：这是「读」的一侧，核心是 `load` 把三层文件读出来合并、`loadAllowList` 再从合并结果里抽出 allow 集合：

```ts
class SettingsLoader {
  userSettingsPath()          { return join(this.helixentHome, "settings.json"); }
  projectSettingsPath(cwd)    { return join(cwd, ".helixent", "settings.json"); }
  projectLocalSettingsPath(cwd){ return join(cwd, ".helixent", "settings.local.json"); }

  async load(cwd: string): Promise<Settings> {
    const paths = [this.userSettingsPath(), this.projectSettingsPath(cwd), this.projectLocalSettingsPath(cwd)];
    const layers = await Promise.all(paths.map((p) => loadLayer(p)));   // 并发读三层
    return mergeSettingsLayers(layers);
  }

  async loadAllowList(cwd: string): Promise<Set<string>> {
    const s = await this.load(cwd);
    return new Set(Array.isArray(s.permissions?.allow) ? s.permissions.allow : []);
  }
}
```

**三处设计值得学**：

1. **三层路径 = 三个来源**：用户级在 Helixent 家目录，项目级和项目本地级都在 `<cwd>/.helixent/` 下。注意家目录的算法（`defaultHelixentHome`）和 1.4 的 `getDefaultHelixentHome` 遥相呼应——都是「优先 `HELIXENT_HOME`、否则 `~/.helixent`」，保证两套持久化的「家」在同一处。
2. **`Promise.all` 并发读三层**：三个文件互相独立，没必要串行等，一把并发读回来。
3. **合并语义的精细分野**（`mergeSettingsLayers`）：这是最讲究的一点——**`permissions.allow` 是「并集累加」（union），其余字段是「后层覆盖前层」（last-wins）**。也就是说，三层里的 allow 列表会被**求并集**（用户信任的 + 项目信任的 + 本地信任的，全都算数）；而别的普通字段则是「越靠后（越本地）的层优先」。为什么 allow 要用并集？因为白名单是**「信任的叠加」**——用户级信任的、项目级信任的，都应该生效，不该被本地层「覆盖没了」。这个分野由 [settings-loader.test.ts](../../src/cli/settings/__tests__/settings-loader.test.ts#L27-L74) 的 `unions permissions.allow` 和 `last layer wins for non-allow keys` 两条测试锁死。

   > 加载时还有**容错**：某一层文件读不动（不存在 / 非法 JSON / schema 不过）不会让整个加载崩溃，而是把那一层当成空 `{}` 跳过（`loadLayer` 里的 `safeParse` + `console.warn`）——对应 [settings-loader.test.ts](../../src/cli/settings/__tests__/settings-loader.test.ts#L45-L56) 的 `ignores invalid user layer and still merges ...`。**一层坏了不牵连另外两层**。
   >

**`settings-writer.ts`——只写 local 层的增量写入**（[settings-writer.ts](../../src/cli/settings/settings-writer.ts)）：这是「写」的一侧，也是 `persistAllowedTool` 的真身：

```ts
class SettingsWriter {
  async appendAllowedTool(cwd: string, toolName: string): Promise<void> {
    const path = this.loader.projectLocalSettingsPath(cwd);   // ← 永远只写 .local
    const file = Bun.file(path);
    let base: Record<string, unknown> = {};
    if (await file.exists()) {
      // 读出已有内容（safeParse 失败也尽量宽松保留，避免弄丢用户手写字段）
    }
    const merged = appendToolToAllowList(base, toolName);      // ← 复用 1.7 的纯函数
    await Bun.write(path, JSON.stringify(merged, null, 2) + "\n");
  }
}
```

**两个关键决策**：

1. **写入永远只落在「项目本地级」`settings.local.json`**。想想 `allow_always_project`（永久允许本项目）这个动作的语义：它是**「我，在我这台机器上，信任这个项目里的这个工具」**——所以理应写进「本地、不入库」的那一层，而**绝不该**去改用户级（影响所有项目）或项目级（会被提交、影响队友）。「读三层、只写最本地的一层」——这个「读广、写窄」的不对称，正是分层配置系统的精髓。对应 [settings-loader.test.ts](../../src/cli/settings/__tests__/settings-loader.test.ts#L77-L89) 的 `appendAllowedTool writes only to project settings.local.json`。
2. **「读旧 → 合并 → 写回」的增量语义**：它先把 `settings.local.json` 已有内容读出来，用 1.7 的纯函数 `appendToolToAllowList` 并入新工具名，再整份写回（`JSON.stringify(..., 2)` 保持可读缩进）。**它不会覆盖掉这个文件里已有的别的字段**——这又一次呼应了 `.passthrough()` 的前向兼容立场。

**这三个文件合起来，正好实现第 15 节的 `ApprovalPersistence` 契约**：

```ts
// ApprovalPersistence（第 15 节定义的契约）        →  第 18 节的真实实现
loadAllowList:      (cwd) => Promise<Set<string>>   →  settingsLoader.loadAllowList(cwd)
persistAllowedTool: (cwd, name) => Promise<void>    →  settingsWriter.appendAllowedTool(cwd, name)
```

**这就是第 15 节那句「具体落盘留到第 18 节」的兑现现场**：`coding` 层定义抽象契约、`cli` 层提供磁盘实现，两层通过 `ApprovalPersistence` 这个「窄接口」对接——**`coding` 永远不知道白名单存在 JSON 里、分三层、写在哪**，它只认那两个函数。这正是 [第 1 节](./01-overview.md) 强调的「单向依赖 + 依赖倒置」在持久化上的落地。至于这两个实现**如何被注入进 Agent**，就是下面 1.8 装配现场的最后一块拼图。

### 1.8 回到 `cli/index.tsx`：命运线 B 的完整装配（全书零件的合流现场）

> **两条线在这里合流。** 我们回到 1.2 那个岔路口的 `else` 分支（`args.length === 0`）——这是**整套教程所有零件的最终装配现场**。前 17 节造的每一个零件，都在这几十行里被拼起来。

命运线 B 的代码从头到尾就是一条**装配流水线**，我们按顺序走一遍，每一步都标出它「用的是前面哪一节的产物」：

**第 ① 步：完整性检查（用 1.6 的 `validateIntegrity`）**

```ts
console.info();
await validateIntegrity();          // ← 没配置就跑首次运行向导，配完落盘 config.yaml
```

启动第一件事，先过 1.6 那道「能不能跑起来」的关。跑完这一行，磁盘上**保证**有至少一个可用模型。

**第 ② 步：读配置、选出要用的模型（用 1.3/1.4 的持久化①）**

```ts
const config = loadConfig();
const defaultModelName = config.defaultModel ?? config.models[0]?.name;
const entry = defaultModelName ? config.models.find((m) => m.name === defaultModelName) : undefined;
if (!entry) {
  throw new Error("No models configured. Run `helixent config model add` to add one.");
}
```

`loadConfig()` 读出并校验 `config.yaml`；然后按「`defaultModel` 优先，否则取第一个」选出要用的那条 `ModelEntry`。**这个 `entry`，就是第 17 节结尾反复追问的「`entry.baseURL` / `entry.APIKey` 从哪来」的答案**——它来自 1.3 的 schema、经 1.4 的 `loadConfig` 从 `config.yaml` 读出。

**第 ③ 步：按 `provider` 分流实例化 Provider（兑现第 16/17 节的伏笔）**

```ts
let provider: ModelProvider;
if (entry.provider === "anthropic") {
  provider = new AnthropicModelProvider({ baseURL: entry.baseURL, apiKey: entry.APIKey });
} else {
  provider = new OpenAIModelProvider({ baseURL: entry.baseURL, apiKey: entry.APIKey });
}
```

**这就是第 17 节结尾点名的那段 `if (entry.provider === "anthropic")` 分流代码！** 一条 `ModelEntry` 的 `provider` 字段（1.3 定义、1.6 向导写入）在这里决定了实例化第 16 节的 `OpenAIModelProvider` 还是第 17 节的 `AnthropicModelProvider`。`baseURL` / `apiKey` 原样喂进去——**这正是第 16/17 节两个 provider 的 `constructor({ baseURL, apiKey })` 等着接的参数**。至此，「配置 → Provider」这条线完全闭合。

**第 ④ 步：包一层 `Model`（用第 3 节的编排壳）**

```ts
const model = new Model(entry.name, provider, {
  max_tokens: 16 * 1024,
  thinking: { type: "enabled" },
});
```

把 provider 包进 [第 3 节](./03-model.md) 的 `Model` 编排壳，并带上运行选项（`max_tokens`、开启 thinking）。回忆第 3/16/17 节：`Model` 负责拼 system prompt、透传 `options` 给 provider，上层完全不感知底下是哪家厂商。

**第 ⑤ 步：造两套持久化的「写手」（用 1.7 的持久化②）**

```ts
const settingsLoader = new SettingsLoader();
const settingsWriter = new SettingsWriter(settingsLoader);
```

实例化 1.7 的加载器和写入器——它们马上要作为 `ApprovalPersistence` 的真实实现注入 Agent。

**第 ⑥ 步：`createCodingAgent` 总装（合流第 11 节的工厂 + 第 15 节的两个 Manager + 1.7 的持久化②）**

```ts
const agent = await createCodingAgent({
  model,
  skillsDirs,
  askUser: globalApprovalManager.askUser,                       // ← 第 15 节：审批 Manager
  askUserQuestion: globalAskUserQuestionManager.askUserQuestion, // ← 第 15 节：提问 Manager
  approvalPersistence: {                                         // ← 1.7：落地第 15 节契约
    loadAllowList: (cwd) => settingsLoader.loadAllowList(cwd),
    persistAllowedTool: (cwd, toolName) => settingsWriter.appendAllowedTool(cwd, toolName),
  },
});
```

**这是全书最密集的一次「合流」**，一行行看它把谁接了进来：

- `model`：第 ④ 步的编排壳（承第 3/16/17 节）。
- `skillsDirs`：技能搜索目录（第 9 节的 Skills 系统），这里列了项目级、`.agents`、Helixent 家目录等多个来源。
- `askUser` / `askUserQuestion`：**第 15 节那两个「等着 UI 来 subscribe」的 Manager 的 `askUser` 方法**！`createCodingAgent`（第 11 节的工厂）拿到它们，装进审批中间件和 `ask_user_question` 工具。**注意此刻它们还在「等 UI」——谁来 subscribe？就是第 ⑦ 步 `render(<App/>)` 之后、第 19 节的两个 `use*Manager` Hook。**
- `approvalPersistence`：**这里就是 1.7 三个文件的「注入点」**——把 `settingsLoader.loadAllowList` 和 `settingsWriter.appendAllowedTool` 包成第 15 节的 `ApprovalPersistence` 契约对象，交给 `createCodingAgent`。**第 15 节甩出来的那对签名，在这一行拿到了真实实现。** 从此审批中间件 `loadAllowList` / `persistAllowedTool` 时，读写的就是 1.7 那三层 JSON 文件了。

**第 ⑦ 步：`render(<App/>)`，把舞台交给 TUI（启下第 19 节）**

```ts
const commands: SlashCommand[] = await loadAvailableCommands(skillsDirs);

render(
  <AgentLoopProvider agent={agent} commands={commands}>
    <App commands={commands} supportProjectWideAllow />
  </AgentLoopProvider>,
  { patchConsole: false },
);
```

装配完成的 `agent` 被交给 `AgentLoopProvider`（第 19 节的 Context 分发器），`render` 把整个 Ink 应用挂到终端上。**本节到此为止**——从这一行往后，是 React/Ink 的世界（第 19～20 节）：`App` 里的 `useApprovalManager` / `useAskUserQuestionManager` 会去 `subscribe` 第 ⑥ 步那两个 Manager，把它们「等待的响应」变成屏幕上弹出的表单；`AgentLoopProvider` 会驱动 [第 5 节](./05-react-loop.md) 的 `agent.stream()`，把流式事件刷成界面。

> 注意 `supportProjectWideAllow`（对应第 15 节审批弹窗里的「永久允许本项目」选项）和 `{ patchConsole: false }`（不让 Ink 劫持 `console.*`，因为向导阶段还要用 `console.info` 打印）这两个小开关——细节留给第 19 节。

**一张「装配总图」收束全节**：

```
                 config.yaml (持久化①)              settings.json ×3 (持久化②)
                       │                                     │
                 ② loadConfig                       ⑤ SettingsLoader/Writer
                       │                                     │
                 ② 选出 entry                                │
                       │                                     │
   ③ if entry.provider === "anthropic"                       │
        ├─ AnthropicModelProvider (§17)                      │
        └─ OpenAIModelProvider (§16)                         │
                       │                                     │
                 ④ new Model(§3)                             │
                       │                                     │
                       └──────────► ⑥ createCodingAgent(§11) ◄──── approvalPersistence
                                          ├─ model                  (落地 §15 契约)
                                          ├─ skillsDirs (§9)
                                          ├─ askUser/askUserQuestion (§15 两个 Manager)
                                          └─ tools + middlewares (§7/§12-15)
                                                    │
                                          ⑦ render(<App/>) ──► 舞台交给 TUI（§19-20）
```

**看懂这张图，你就看懂了「敲下 `helixent` 之后到底发生了什么」的全部**：读两套持久化 → 按配置选模型、分流 provider → 包 Model → 总装 Agent（把第 15 节的 Manager 和 1.7 的落盘实现一并注入）→ render 交给 TUI。**这也是整套教程「自底向上」造零件、终于在此「合流成品」的高光时刻。**

---

## 2. 亮点与关键设计

回顾全节，把散落的「妙笔」和「关键决策」拎出来，明确标注哪些是**关键决策**（架构层面、影响深远）、哪些是**妙笔**（局部精巧、值得抄作业）：

1. **【关键决策】两套持久化物理隔离**：模型配置（`config.yaml`，YAML，单一全局）与审批白名单（`settings.json`，JSON，三层）分开，因为二者的本质不同——**「账户信息（全局唯一）」vs「信任策略（可分层叠加）」**。这是本节最该带走的架构直觉：**不要因为「都是配置」就把性质不同的东西塞进一个文件**。
2. **【关键决策】依赖倒置落地第 15 节契约**：`coding` 层只定义 `ApprovalPersistence` 两个函数签名、绝不碰磁盘；`cli` 层的 `SettingsLoader/Writer` 提供真实实现，在 `cli/index.tsx` 第 ⑥ 步注入。**上层（coding）定义抽象、下层（cli）提供实现**——这让 `coding` 可以脱离文件系统被单测（喂个假的 `ApprovalPersistence` 即可），也让持久化方式将来能整体替换（换成数据库？只改 cli 层）。
3. **【关键决策】`args.length` 一刀切分两条命运线**：有参跑子命令（纯配置 CLI，不碰 TUI/模型），无参进 TUI（完整装配）。把最高频的「对话」放在零参数最短路径上。
4. **【妙笔】读写两端都过同一个 Zod schema**：`loadConfig` 和 `saveConfig` 都调 `helixentConfigSchema.parse`——schema 成为读写双向的唯一「关卡」，磁盘上永远不会存在不合法的配置。schema 还用 `z.infer` 反向导出 TS 类型，杜绝「类型与校验漂移」。
5. **【妙笔】临时文件 + `rename` 的原子写**：`saveConfig` 先写 `.tmp` 再 `renameSync`，`pid`+时间戳后缀防并发踩踏——彻底杜绝「写一半崩溃留下半个 YAML」。
6. **【妙笔】`provider` 字段 `.optional().default("openai")` 的向后兼容**：老配置文件没有这个字段也能读、默认当 OpenAI——加入 Anthropic 支持后，用户升级无需改任何配置。
7. **【妙笔】allow 用「并集」、其余字段用「后层覆盖」的合并分野**：白名单是「信任的叠加」（三层求并），普通字段是「越本地越优先」（last-wins）。同一个合并函数里两种语义各得其所。
8. **【妙笔】「读三层、只写最本地一层」的不对称**：`load` 合并用户/项目/本地三层，`appendAllowedTool` 却只写 `settings.local.json`——精准匹配 `allow_always_project` 的语义（我这台机器信任这个项目），既不污染全局也不影响队友。
9. **【妙笔】`appendToolToAllowList` 抽成纯函数**：把「合并逻辑」和「磁盘 IO」解耦，前者能被大量用例脱离文件系统单测，后者只是薄薄一层 `Bun.write`。
10. **【妙笔】`/dev/tty` 兜底交互**：`promptSelectModelName` 在 stdin 被管道占用时回退到 `/dev/tty`，让「管道 + 交互」共存——命令行工具的老练细节。
11. **【妙笔】三处「不信任磁盘脏状态」的防御**：`add` 读失败当空、`validateIntegrity` 特判 `models:[]`、`loadLayer` 一层坏了不牵连其他层——处处假设「磁盘上的文件可能是脏的」，绝不因单点脏数据全盘崩溃。

---

## 3. 工业对比

把 Helixent 本节的做法，与业界主流 CLI / Agent 工具对照，看它的取舍落在哪。

### 3.1 配置分层：Helixent 三层 settings vs Claude Code / VS Code

Helixent 的「用户级 / 项目级 / 项目本地级」三层 settings，几乎是**照着 Claude Code 与 VS Code 的分层模型来的**：

| 工具                  | 分层                                                                                                | `.local` 不入库约定                   | 合并语义                   |
| --------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------- |
| **Helixent**    | 用户(`~/.helixent`) / 项目(`.helixent/settings.json`) / 本地(`.helixent/settings.local.json`) | 是（`.local` 由 `.gitignore` 排除） | allow 并集、其余 last-wins |
| **Claude Code** | 用户(`~/.claude`) / 项目(`.claude/settings.json`) / 本地(`.claude/settings.local.json`)       | 是                                      | 类似（permissions 累加）   |
| **VS Code**     | User / Workspace / Folder                                                                           | 部分（`.vscode/` 常提交）             | 后层覆盖前层               |

**Helixent 的取舍**：它选了「Claude Code 式」的三层 + `.local` 不入库，且**对 permissions.allow 特意用并集而非覆盖**——这比 VS Code 的「一律后层覆盖」更贴合「信任只增不减」的安全语义。代价是合并逻辑更复杂（要区分 allow 和其他字段），但换来了「团队共享的项目级信任 + 个人本地信任能叠加生效」的正确行为。

### 3.2 模型配置：Helixent `config.yaml` vs Aider / Codex / Continue

| 工具                       | 模型配置位置                   | 格式 | 多模型                   |
| -------------------------- | ------------------------------ | ---- | ------------------------ |
| **Helixent**         | `~/.helixent/config.yaml`    | YAML | 支持，带`defaultModel` |
| **Aider**            | `.aider.conf.yml` + 环境变量 | YAML | 通过`--model` 切换     |
| **OpenAI Codex CLI** | `~/.codex/config.toml`       | TOML | 支持 profile             |
| **Continue**         | `~/.continue/config.json`    | JSON | 支持 models 数组         |

**共性**：都把「模型 + key + baseURL」这类账户信息放在**用户家目录的单一文件**里，与「项目级行为配置」分开。**Helixent 的特点**：用 YAML（比 JSON 可读、比 TOML 通用），用 Zod 在读写两端强校验（很多工具只在读时松散解析），且 `provider` 字段驱动的「一个字段决定用哪个 SDK」设计，让「11 家厂商共用 2 个 Provider 实现」（呼应第 16/17 节）。

### 3.3 密钥存储：Helixent 明文 YAML vs 系统钥匙串

**Helixent 把 API Key 明文存进 `config.yaml`**（仅在 `list` 时打码显示后四位）。这是一个**务实但有安全权衡**的选择：

- **业界更安全的做法**：GitHub CLI、AWS CLI 等会把凭证存进操作系统的钥匙串（macOS Keychain / Windows Credential Manager / Linux Secret Service），或至少放在权限 `600` 的独立文件里。
- **Helixent 的取舍**：明文 YAML 简单、跨平台、易调试、无原生依赖（符合它「代码量小、零重型依赖」的定位）。它靠「文件在用户家目录 `~/.helixent`（默认权限受 umask 保护）+ 显示时打码」来降低风险，但**没有加密**。
- **给读者的提醒**：这是一个「教学项目 / 个人工具」可接受、但「企业级产品」需要加强的点。如果你要把这套设计用到生产，应考虑钥匙串或环境变量注入。

### 3.4 CLI 框架：Commander vs yargs / oclif / Cobra

Helixent 用 [Commander](https://github.com/tj/commander.js) 组织子命令。对比：

- **Commander（Helixent 选择）**：轻量、API 直观、`command().action()` 链式声明，适合中小型 CLI。Helixent 的「逐层 `register*` 函数 + 每命令一文件」把 Commander 的声明式风格和自己的「小文件」约定结合得很干净。
- **yargs**：功能更全（内置校验、中间件），但 API 更重。
- **oclif（Salesforce）/ Cobra（Go）**：面向大型 CLI（几十上百条命令、插件体系），Helixent 这种「一棵 `config model *` 小树」用它们是杀鸡用牛刀。

**结论**：对 Helixent 「配置管理是辅助、对话才是主业」的定位，Commander 是恰当的轻量选择。

---

## 4. 深度解释：为什么这样设计？不这样会怎样？

用五个「Q&A」把本节最容易产生疑问、也最见设计功力的点讲透。

### Q1：为什么模型配置用 YAML、审批白名单用 JSON？同一个项目里用两种格式，不是不统一吗？

**这不是随意，而是「谁来读写」决定的**：

- **`config.yaml`（YAML）**：主要由**人**手动查看、偶尔手改（「我配的 baseURL 对不对」）。YAML 对人**更友好**——有注释、无引号噪声、层级靠缩进一目了然。所以给「人常看」的配置用 YAML。
- **`settings.json`（JSON）**：主要由**程序**读写（审批中间件自动追加、加载器自动合并），人几乎不手动编辑。JSON 是**机器交换的通用格式**、`JSON.parse/stringify` 零依赖、且**这是 Claude Code / VS Code 的既定约定**——沿用它能让熟悉那些工具的用户无缝迁移。

**如果强行统一成一种会怎样？** 全用 JSON：`config.yaml` 失去注释和可读性，用户手改 baseURL 时体验变差。全用 YAML：`settings.json` 偏离了 Claude Code/VS Code 生态约定，且 YAML 解析比 JSON 重。**「按读者选格式」比「强求统一」更工程**——这也是本节「两套持久化」哲学的延伸。

### Q2：`saveConfig` 为什么要「临时文件 + rename」这么麻烦？直接 `writeFileSync(target, content)` 不行吗？

**直接写会有「撕裂写（torn write）」风险**。设想 `writeFileSync` 写到一半——磁盘满了、进程被 `kill -9`、机器断电——`config.yaml` 就变成一个**残缺的半截 YAML**。下次启动 `loadConfig` 一读，Zod 解析失败，**用户所有模型配置瞬间「丢失」**（其实是文件坏了），体验灾难。

**「临时文件 + rename」为什么能避免？** 因为 POSIX 保证：**同一文件系统内的 `rename` 是原子的**——它只是把目录项从旧 inode 指向新 inode，这个切换要么完成要么没发生，**不存在中间态**。所以即便写 `.tmp` 时崩溃，崩的是那个没人读的临时文件，`config.yaml` 还是完好的旧版本。加 `pid`+时间戳后缀，则防止两个进程同时 `saveConfig` 时临时文件互相覆盖。

**代价**：多一次写和一次 rename、可能留下孤儿 `.tmp`（崩溃时）。但对「配置这种绝不能损坏的数据」，这点代价完全值得。这是「关键数据落盘」的行业标准手法。

### Q3：`ApprovalPersistence` 这层抽象是不是过度设计？`cli` 层直接在审批中间件里写文件不就完了吗？

**看似绕，实则是「分层架构」的刚需**。回忆 [第 1 节](./01-overview.md) 的单向依赖约束：`foundation ← agent/coding ← cli`。`coding` 层**不允许**依赖 `cli` 层，也**不应该**知道「配置存在哪、什么格式」这种 `cli` 层的细节。

**如果让 `coding` 的审批中间件直接写文件会怎样？**

- `coding` 就得 `import` `settings-writer`、知道 `settings.local.json` 的路径规则、JSON 格式——**它被焊死在了「文件系统 + 这套 settings 布局」上**。
- `coding` 的单测就必须准备真实文件、临时目录——**测试变慢、变脆**。
- 将来想把白名单换成数据库 / 远程配置？得改 `coding` 核心——**违反「对修改关闭」**。

**用 `ApprovalPersistence` 窄接口隔开后**：`coding` 只认「给我一个 `loadAllowList` 和 `persistAllowedTool`」，谁实现、怎么实现，与它无关。单测喂个内存版假实现即可；换存储后端只改 `cli` 层的注入。**这就是「依赖倒置原则」——高层模块（coding）不依赖低层模块（cli 的磁盘操作），二者都依赖抽象（`ApprovalPersistence`）。** 这层抽象不是过度设计，而是让 `coding` 保持「纯逻辑、可移植、可测」的关键。

### Q4：`.passthrough()` 到底解决了什么？为什么 settings 要用它、而 `config.yaml` 的 schema 却没用？

**`.passthrough()` 解决的是「多版本 / 多来源共写一个文件时，别把对方的字段弄丢」**。

- **settings 为什么需要它**：`settings.json` 可能被**多方写入**——Helixent 程序、用户手动、甚至将来的其他工具（它对标 Claude Code 生态，可能共存别的字段）。如果 schema 不 `passthrough`，`SettingsWriter` 读进来时会把「不认识的字段」丢掉，写回时就**抹掉了别人的数据**。`.passthrough()` 让「只读你懂的 `permissions.allow`，其余原样保留」，是多方协作写同一文件的**安全前提**。它体现的是「**前向兼容**」——旧代码遇到新字段不报错、不丢弃。
- **`config.yaml` 为什么不用**：`config.yaml` 由 Helixent **独占读写**（用户偶尔手改，但没有「多工具共写」场景），且它的结构（models/defaultModel）是**封闭、完整**的——多出来的字段就是错误，应该被 Zod 严格拒绝，而不是放行。所以它用严格 schema（甚至 `superRefine` 加跨字段校验）。

**一句话**：`passthrough` 用在「开放、多方、需前向兼容」的 `settings.json`；严格校验用在「封闭、独占、需强一致」的 `config.yaml`。**schema 的严格程度，应匹配这份数据的「开放性」。**

### Q5：本节讲的启动装配（`cli/index.tsx`），和前 17 节的关系到底是什么？如果我要给 Helixent 接一个「第三种界面」（比如 Web），要改哪、不用改哪？

**这个问题能检验你有没有真正理解「装配 vs 零件」的分离**。

- **本节的 `cli/index.tsx` 是「装配脚本」，前 17 节是「零件」**。零件（Message、Model、Provider、Tool、Agent、中间件、Manager）本身**不知道自己会被谁装配、装配成什么形态**——它们只暴露构造参数和接口。`cli/index.tsx` 干的活，就是「读配置 → 选零件 → 按顺序拼起来 → 挂到 Ink 界面上」。
- **接一个 Web 界面要改什么？** 你要写一个新的「装配脚本」（比如 `web/server.ts`），它同样会：`loadConfig` → 按 `provider` 实例化 Provider → `new Model` → `createCodingAgent`（注入 `askUser`/`approvalPersistence`）。**这一大段几乎可以照抄**——因为它拼的零件完全一样。
- **不用改什么？** 前 17 节的**所有零件一行都不用动**：Provider 照样连模型、Agent 照样跑循环、审批中间件照样调 `ApprovalPersistence`。
- **要重写什么？** 只有**两处「界面适配」**：① 把 `askUser`/`askUserQuestion` 从「Ink 弹窗」换成「Web 端的 HTTP/WebSocket 交互」（第 15 节的 Manager 是「队列 + 订阅」模型，正是为「任意 UI 都能 subscribe」而设计的——Web 端也能 subscribe）；② 把 `render(<App/>)` 换成「起一个 Web server、把 `agent.stream()` 的事件推给前端」。持久化两套（config + settings）**完全复用**，甚至审批白名单还能沿用同一套三层 settings。

**这就是本节装配现场的深层价值**：它证明了「前 17 节的分层」是真的解耦了——**换界面 = 换一个装配脚本 + 两处界面适配，核心零件零改动**。第 15 节的「Manager 队列/订阅」和本节的「`ApprovalPersistence` 契约」，就是为这种「界面可替换」预留的两个接缝。

---

## 5. 参考资料

**本节精讲的源码（建议对照阅读）**：

- **入口分流**：[cli/index.tsx](../../src/cli/index.tsx)（92 行）——`Commander` 建 program、`registerCommands`、`args.length` 三岔路口、命运线 B 的完整装配（②–⑦ 步）。
- **config 持久化（持久化①）**：
  - [config/schema.ts](../../src/cli/config/schema.ts)（25 行）——`modelEntrySchema` / `helixentConfigSchema`、`superRefine` 跨字段校验、`z.infer` 导出类型
  - [config/index.ts](../../src/cli/config/index.ts)（73 行）——`getHelixentHomePath`/`getConfigFilePath`、`loadConfig`/`saveConfig`（原子写）、`isHelixentSetupComplete`/`ensureHelixentHome*`
- **Commander 子命令**：
  - [commands/index.ts](../../src/cli/commands/index.ts)、[config/index.ts](../../src/cli/commands/config/index.ts)、[config/model/index.ts](../../src/cli/commands/config/model/index.ts)——逐层 `register*` 命令树
  - [add.ts](../../src/cli/commands/config/model/add.ts)（读旧→追加→写回）、[list.ts](../../src/cli/commands/config/model/list.ts)（打码显示 key）、[remove.ts](../../src/cli/commands/config/model/remove.ts)（不许删空、默认重指）、[set-default.ts](../../src/cli/commands/config/model/set-default.ts)、[prompt-select-model.ts](../../src/cli/commands/config/model/prompt-select-model.ts)（`/dev/tty` 兜底）
- **厂商注册表 + 向导**：[model-providers.ts](../../src/cli/model-providers.ts)（11 家厂商、`providerType`）、[bootstrap/integrity.ts](../../src/cli/bootstrap/integrity.ts)（完整性检查）、[bootstrap/first-run-wizard.tsx](../../src/cli/bootstrap/first-run-wizard.tsx)、[bootstrap/model-wizard.tsx](../../src/cli/bootstrap/model-wizard.tsx)（5 步状态机）
- **settings 持久化（持久化②，落地第 15 节契约）**：[settings/settings.ts](../../src/cli/settings/settings.ts)（`appendToolToAllowList` 纯函数 + `.passthrough()` schema）、[settings-loader.ts](../../src/cli/settings/settings-loader.ts)（三层合并、allow 并集）、[settings-writer.ts](../../src/cli/settings/settings-writer.ts)（只写 local 层）
- **version**：[version.ts](../../src/cli/version.ts)（从 `package.json` 取 name/version 的单一真相源）

**co-located 测试（[第 21 节](./00-roadmap.md) 会讲这套约定）**：

- [config/__tests__/schema.test.ts](../../src/cli/config/__tests__/schema.test.ts)——`ModelEntry` 必填/默认 provider/非法枚举、`superRefine` 悬空默认模型
- [settings/__tests__/settings.test.ts](../../src/cli/settings/__tests__/settings.test.ts)——`appendToolToAllowList` 去重/降级/过滤脏值/保留其他字段、`.passthrough()`
- [settings/__tests__/settings-loader.test.ts](../../src/cli/settings/__tests__/settings-loader.test.ts)——三层 allow 求并集、坏层跳过、非 allow 键 last-wins、`appendAllowedTool` 只写 local

**上游依赖章节**：

- [第 15 节 · Human-in-the-Loop](./15-human-in-the-loop.md)：本节兑现它的 `ApprovalPersistence` 契约（`loadAllowList`/`persistAllowedTool`），并把它的 `globalApprovalManager` / `globalAskUserQuestionManager` 装进 `createCodingAgent`
- [第 16 节 · OpenAI Provider](./16-openai-provider.md) / [第 17 节 · Anthropic Provider](./17-anthropic-provider.md)：本节的 `entry.provider` 分流决定实例化哪个，`{baseURL, apiKey}` 从 `config.yaml` 读入喂给它们的 `constructor`
- [第 11 节 · Lead Agent](./11-lead-agent.md)：本节 ⑥ 步调用的 `createCodingAgent` 工厂
- [第 3 节 · Model](./03-model.md)：本节 ④ 步 `new Model(name, provider, options)` 的编排壳
- [第 1 节 · 项目全景](./01-overview.md)：本节是「单向依赖 + 依赖倒置」在持久化与装配上的落地印证

**下游承接章节（本节埋的接口）**：

- [第 19 节 · TUI 架构与状态编排](./00-roadmap.md)：本节 ⑦ 步 `render(<App/>)` 之后——`AgentLoopProvider` 如何驱动 `agent.stream()`、两个 `use*Manager` Hook 如何 `subscribe` 本节注入的 Manager
- [第 20 节 · TUI 输入与渲染](./00-roadmap.md)：本节一带而过的 `loadAvailableCommands` / `SlashCommand`（斜杠命令）、first-run 向导用到的 Ink 输入组件
- [第 21 节 · 工程实践](./00-roadmap.md)：本节 `version.ts` 引出的 `package.json`、`bin` 字段与 `bun build --compile` 打包成单文件二进制

**关联源码（本节引用但不精讲）**：

- 契约定义：[approval-persistence.ts](../../src/coding/permissions/approval-persistence.ts)（第 15 节定义、本节实现）、[coding-approval-middleware.ts](../../src/coding/permissions/coding-approval-middleware.ts)（消费方）
- 装配目标：[tui/app.tsx](../../src/cli/tui/app.tsx)、[tui/hooks/use-agent-loop.ts](../../src/cli/tui/hooks/use-agent-loop.ts)（`AgentLoopProvider`）——留给第 19 节

**外部资料**：

- Commander.js（子命令、`command`/`action`/`version`）：[https://github.com/tj/commander.js](https://github.com/tj/commander.js)
- Zod（`z.enum`、`.optional().default()`、`superRefine`、`.passthrough()`、`z.infer`）：[https://zod.dev](https://zod.dev)
- YAML for JavaScript（`yaml` 包的 `parse`/`stringify`）：[https://eemeli.org/yaml/](https://eemeli.org/yaml/)
- POSIX `rename(2)` 的原子性保证：[https://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html](https://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html)
- Claude Code settings 分层（`settings.json` / `settings.local.json` / 用户级）：[https://docs.anthropic.com/en/docs/claude-code/settings](https://docs.anthropic.com/en/docs/claude-code/settings)
- VS Code settings 层级（User / Workspace / Folder）：[https://code.visualstudio.com/docs/getstarted/settings](https://code.visualstudio.com/docs/getstarted/settings)
- Bun 文件 API（`Bun.file` / `Bun.write` / `Bun.env`）：[https://bun.sh/docs/api/file-io](https://bun.sh/docs/api/file-io)

---

## 6. 小结与下一节预告

本节我们拆透了 Helixent 的「命令行外壳 + 磁盘落盘」这半边，核心是**「一次启动的两条命运线」+「磁盘上的两套持久化」**：

- **入口分流**（1.2）：`cli/index.tsx` 用 `args.length` 把一次启动劈成两条命运线——**有参**跑 `config model *` 子命令（纯配置 CLI，不碰模型/TUI），**无参**进入完整装配 + TUI。
- **持久化①·模型配置**（1.3–1.6）：`config.yaml`（YAML、单一全局文件）。`schema.ts` 用 Zod 立法（`superRefine` 保证默认模型存在、`provider` 字段向后兼容）；`config/index.ts` 负责 `HELIXENT_HOME` 解析、读写两端校验、**临时文件+rename 原子写**、setup 检测；`commands/*` 四条子命令都是「`ensure*` → 读改内存 → `saveConfig`」的变奏；`model-providers.ts` + `bootstrap/*` 是它的输入端——11 家厂商注册表（只 2 个 Provider 实现）、首次运行向导、5 步加模型向导。
- **持久化②·审批白名单**（1.7）：`settings.json`（JSON、用户/项目/本地**三层**）。它**落地了第 15 节的 `ApprovalPersistence` 契约**——`settings.ts` 的纯函数 `appendToolToAllowList` + `.passthrough()` 前向兼容 schema；`settings-loader.ts` 三层并发加载、**allow 求并集、其余 last-wins**；`settings-writer.ts` **只写最本地的 `settings.local.json`**，精准匹配「永久允许本项目」的语义。
- **装配合流**（1.8）：回到命运线 B，`cli/index.tsx` 把前 17 节所有零件拼成成品——`loadConfig` 选模型 → 按 `provider` 分流实例化第 16/17 节的 Provider → 包第 3 节的 `Model` → `createCodingAgent`（第 11 节工厂）注入第 15 节两个 Manager 和 1.7 的落盘实现 → `render(<App/>)` 交给 TUI。

**一条主线**：**本节是「零件」到「成品」的转折点**。前 17 节造的每一个零件（Message/Model/Provider/Tool/Agent/中间件/Manager），在 `cli/index.tsx` 里被一次装配成一个能配置、能连模型、能审批的真实程序；而两套持久化则回答了「配置和信任究竟存在哪、怎么读写」——其中审批白名单**兑现了第 15 节那句「具体落盘留到第 18 节」的承诺**。至此，一个能**独立运行**的 CLI 程序已经成型，只差「界面本身如何工作」这最后一块。

**承上启下（启下）**：本节在 1.8 第 ⑦ 步 `render(<App/>)` 处**戛然而止**——我们把装配好的 `agent`、注入好的两个 Manager、加载好的斜杠命令，一股脑交给了 `AgentLoopProvider` 和 `App`，然后就「把舞台让给了 TUI」。但一连串问题仍悬而未决：**终端界面为什么能用 React 写？** [第 5 节](./05-react-loop.md) 那个 `agent.stream()` 吐出的流式事件，如何被接进 React 的状态、驱动界面刷新？[第 15 节](./15-human-in-the-loop.md) 那两个「还在等 UI 来 `subscribe`」的 Manager，究竟是**谁**、**怎么**去订阅它们、把「一个待响应的请求」变成屏幕上弹出的审批/提问表单？

**所以下一步，是走进 `render(<App/>)` 之后的世界**——看 Ink（「用 React 渲染到终端」）如何把 Agent 的流式事件、两个 Manager 的「等待响应」，编织成一个会实时刷新、会弹窗交互的终端界面。这正是 [第 19 节](./00-roadmap.md) 的「TUI 架构与状态编排 —— Ink + React 的 Agent Loop Hook」：你会看到 `AgentLoopProvider` 如何用 Context 分发状态、`enqueueMessage` + 50ms 批量刷新的节流渲染、以及两个 `use*Manager` Hook 如何 `subscribe` 本节注入的那两个 Manager。

👉 下一节 **第 19 节：TUI 架构与状态编排 —— Ink + React 的 Agent Loop Hook**。

准备好后，对我说「**生成第 19 节**」即可。
