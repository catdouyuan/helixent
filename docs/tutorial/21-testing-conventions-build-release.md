# 第 21 节：测试、代码规范、构建与发布

> 本节属于 **第七部分 · 工程实践（把它当一个「作品」来欣赏）**，是这一部分**唯一的一节**，也是整套「源码精读」教程的**终章**。[第 20 节](./20-tui-input-command-render.md) 在结尾把这个悬念交代得清清楚楚——它讲完「用户输入 + 消息渲染」两个子系统、宣告「从『用户按下一个键』到『Agent 的回应浮现在屏幕上』的完整人机界面全部走通」之后，特意留下最后一问：**「跳出『读代码』，站在『作品』视角审视它——这个项目如何用工程手段保证每一层的质量约束？那些贯穿全书、被反复提及的 co-located 测试（`__tests__/*`）是怎么组织的？它如何被 `bun build --compile` 打包成一个单文件二进制？pre-commit hook + CI 的 `bun run check` 双保险，又是如何守住第 1 节立下的那些规矩的？为什么整个项目选 Bun 而不是 Node / Deno？」**
>
> 对应 roadmap 为本节设定的**核心问题**：
>
> > 这个项目如何保证质量？如何被打包成一个单文件可执行程序？
>
> **一句边界声明**：本节不再精讲任何**业务源码**（前 20 节已把 `src/**` 的每一个关键文件精讲完毕、不重不漏），而是把镜头拉远，精讲**「包裹在业务代码之外的那层工程外壳」**——它们不参与 Agent 运行，却决定这个项目**能不能被信任、能不能被分发**。本节精讲的对象清单如下，可分为**四大主题**：
>
> - **测试（质量的地基）**：`src/**/__tests__/*.test.ts`（34 个文件、223 个用例）、Bun 内置测试运行器（`bun:test`）、co-located 组织约定。
> - **代码规范（一致性的护栏）**：[code-convention.md](../code-convention.md)、[eslint.config.js](../../eslint.config.js)、[.prettierrc](../../.prettierrc)、[tsconfig.json](../../tsconfig.json)、[.markdownlint.json](../../.markdownlint.json)。
> - **质量关卡（把规矩变成强制）**：[package.json](../../package.json) 的 `check` 脚本、[pre-commit](../../pre-commit) 钩子、[.github/workflows/check.yml](../../.github/workflows/check.yml) CI。
> - **构建与发布（从源码到用户手里）**：`bun build --compile` 单文件二进制、`build:js` 库产物、`prepublishOnly` / `release:*` 的 npm 发布链路、[bun.md](../bun.md) 里「为什么选 Bun」。
>
> **本节最大的「啊哈时刻」**：**「质量不是靠『自觉』守住的，而是靠一条『所有人（包括 AI）都绕不过去的关卡』守住的。」**——Helixent 把 [第 1 节](./01-overview.md) 到 [第 20 节](./20-tui-input-command-render.md) 立下的所有规矩（分层依赖、命名约定、casing 分界、无默认导出……）最终收敛成**一行命令 `bun run check`**（= `tsc --noEmit && eslint . --ext .ts && bun test`），再用 **pre-commit 钩子 + GitHub Actions 双保险**把这一行命令**焊死在提交和推送的必经之路上**。看懂这条「规矩 → 命令 → 关卡」的收敛链，你就理解了为什么前 20 节反复强调的那些「约定」不是一纸空文——它们每一条都有一道自动化关卡在背后撑腰。
>
> ⚠️ **一处「诚实标注」**：本节会对照项目文档描述与**仓库当前的真实状态**，指出一处**值得注意的偏差**——[AGENTS.md](../../AGENTS.md) 与 [README](../../README.md) 都声称 pre-commit 钩子位于 `.githooks/pre-commit`、用 `bun run hooks:install`（即 `git config core.hooksPath .githooks`）安装，但仓库里 `.githooks/` 目录**当前是空的**，真正的钩子脚本躺在**仓库根目录的 [pre-commit](../../pre-commit)**，且 `core.hooksPath` **尚未被设置**。这不是要挑刺，而是本节「工程视角」的一部分：**文档、脚本、真实状态三者的一致性，本身就是工程质量的一个维度**——1.11 会专门剖析这处偏差的成因与修复。

***

## 0. 承上启下

[第 20 节](./20-tui-input-command-render.md) 在它的「6. 小结与全书回望」里，几乎是逐字点名了本节。它的原话是这样的：

> 最后一步，是跳出「读代码」，站在「作品」视角审视它：这个项目如何用**测试**保证每一层的质量约束？那些贯穿全书、被反复提及的 **co-located 测试**（`__tests__/*`）是怎么组织的？它如何被 `bun build --compile` 打包成**一个单文件二进制**分发出去？pre-commit hook + CI 的 `bun run check` 双保险，又是如何守住 [第 1 节·code-convention](./01-overview.md) 立下的那些规矩的？**为什么整个项目选 Bun 而不是 Node / Deno？**

本节就来一次性兑现这处伏笔。但在动手之前，请先把**四条贯穿全书的「未结账目」**摆到台面上——它们是本节存在的理由，也是本节每一处内容的「回扣对象」：

1. **前 20 节反复出现「co-located 测试」这个词，却从没系统讲过它。** [第 4 节](./04-tool.md) 讲 `defineTool` 时提过「每个工具都有一个 `__tests__/<name>.test.ts`」；[第 12 节](./12-tool-foundation-file-io.md) 讲文件工具时反复说「用 `mkdtemp` + `afterEach` 清理」；[第 20 节](./20-tui-input-command-render.md) 结尾还专门列出三个「纯函数才好测」的测试文件、并注明「第 21 节会讲这套约定」。**这些散落各处的「测试碎片」，本节要把它们收拢成一张完整的测试地图**（1.2–1.8）。

2. **[第 1 节](./01-overview.md) 立下的「规矩」到底怎么被强制执行？** 第 1 节讲四层架构时，反复强调「严格单向依赖」「无默认导出」「kebab-case 文件名」「camelCase 内部 / snake_case wire」……[code-convention.md](../code-convention.md) 更是把这些规矩写成了 100 行的「法典」。**但『写下规矩』和『强制执行规矩』是两码事**——本节的 [eslint.config.js](../../eslint.config.js) + `tsc --noEmit` 就是把这些规矩**变成会报错的关卡**的地方（1.9–1.11）。

3. **[第 16 节](./16-openai-provider.md) / [第 17 节](./17-anthropic-provider.md) 讲 Provider 时，`temperature: 0` 这类「确定性」决策为什么重要？** 当时说「确定性利于测试」，但没展开。**本节会揭示：正是因为模型被设成确定性输出、且 Provider 层被抽象干净，`StreamAccumulator` 这类核心逻辑才能被 223 个用例中的一大批『无需真实网络、无需真实模型』地单测**（1.6）。

4. **整个项目从头到尾都在用 `Bun.file`、`Bun.spawn`、`bun test`、`bun build`——为什么是 Bun？** [第 13 节](./13-search-system-tools.md) 讲 `bash` 工具时用了 `Bun.spawn`；[bun.md](../bun.md) 开篇就写「Default to using Bun instead of Node.js」。**这个贯穿全书的技术选型，到本节才到了该算总账的时候**（1.14 + 3）。

准备好了。我们同样**先不看任何一个具体文件**，而是先建立一张**「四道质量关卡」的总图**——因为本节涉及的配置文件、脚本、钩子看似零散，但只要抓住「**它们全都服务于同一个目标：把『规矩』收敛成一条『绕不过去的关卡』**」这一条主线，就不会在一堆 `.json` / `.js` / `.yml` 里迷失方向。

***

## 1. 主题内容

### 1.1 先建立地图：四道关卡，把「规矩」焊死在必经之路上

本节的所有内容，最终都服务于一件事：**让 [第 1 节](./01-overview.md) 到 [第 20 节](./20-tui-input-command-render.md) 立下的每一条约定，都有一道『自动、强制、不可绕过』的关卡在背后守着**。先把这张「从规矩到关卡」的收敛图刻进脑子：

```
┌─────────────────────── 规矩的来源（前 20 节立下的约定）────────────────────────┐
│                                                                                │
│  分层单向依赖（§1）  无默认导出（§1）  casing 分界（§2）  结构化结果（§4）      │
│  纯函数可测（§20）   Provider 确定性（§16/17）  ……                             │
│                                    │                                            │
│                                    ▼ 收敛成三类可执行的检查                       │
│                                                                                │
│   ┌─────────────┐    ┌──────────────────┐    ┌──────────────────┐              │
│   │ tsc --noEmit│    │ eslint . --ext.ts│    │     bun test     │              │
│   │  类型正确？  │    │  规范 / 依赖方向？│    │   行为正确？      │              │
│   │  (tsconfig) │    │ (eslint.config)  │    │ (__tests__/*.ts) │              │
│   └──────┬──────┘    └────────┬─────────┘    └────────┬─────────┘              │
│          └────────────────────┴────────────────────────┘                       │
│                                    │                                            │
│                                    ▼ 合并成一条命令                              │
│                          ┌───────────────────┐                                  │
│                          │  bun run check    │  ← package.json scripts.check    │
│                          └─────────┬─────────┘                                  │
└────────────────────────────────────┼───────────────────────────────────────────┘
                                     │ 被两道关卡「焊死」在必经之路上
              ┌──────────────────────┴──────────────────────┐
              ▼                                              ▼
    ┌───────────────────┐                        ┌────────────────────────┐
    │  pre-commit 钩子   │                        │  GitHub Actions (CI)   │
    │  本地提交前拦截     │                        │  push / PR 时云端拦截   │
    │  (pre-commit)     │                        │  (.github/workflows/   │
    │                   │                        │       check.yml)       │
    └───────────────────┘                        └────────────────────────┘
              「本地」第一道                              「远端」第二道
                        ＝ 双保险：本地漏了，CI 兜底

┌─────────────────────── 通过关卡之后：交付 ───────────────────────┐
│   bun build --compile  →  dist/bin/helixent（单文件二进制）        │
│   prepublishOnly / release:*  →  发布到 npm（helixent 包）         │
└──────────────────────────────────────────────────────────────────┘
```

**这张图的三个「记忆锚点」**：

1. **规矩 → 命令：三合一的 `check`**。前 20 节那些抽象的「约定」，最终被压缩成三个具体、可执行的检查——`tsc --noEmit`（类型对不对）、`eslint`（规范和依赖方向对不对）、`bun test`（行为对不对）。这三者用 `&&` 串成 [package.json](../../package.json#L40) 里的一行 `check` 脚本。**一行命令，覆盖「类型 / 规范 / 行为」三个正交维度**——这是本节的第一根主线。

2. **命令 → 关卡：本地 + 远端双保险**。光有 `bun run check` 这条命令还不够，得让它**绕不过去**。Helixent 用两道关卡夹击：**本地** pre-commit 钩子（提交前先跑一遍，不过就不让 commit）+ **远端** GitHub Actions（push / PR 时云端再跑一遍，不过就是红叉）。**「本地兜住大多数、CI 兜住漏网的」——这就是『双保险』的含义**（1.10–1.11 详解，含那处「诚实标注」的偏差）。

3. **关卡 → 交付：两种产物**。通过关卡的代码，走向两个方向：`bun build --compile` 产出**给终端用户的单文件二进制**（`dist/bin/helixent`，`npm i -g` 后直接跑），`prepublishOnly` + `release:*` 把包**发布到 npm**（`helixent`，供 `import` 或 `npx`）。**「一份源码，两种交付形态」**（1.12–1.13）。

**本节的推进顺序**：先啃**最厚的一块——测试**（1.2 测试哲学 → 1.3 三段式套路 → 1.4–1.8 五类测试范式），因为它是「行为正确」这一维度的全部内容、也是前 20 节欠账最多的地方；再讲**代码规范**（1.9 三件套：TS / ESLint / Prettier）如何守住「类型 + 规范」两维度；然后把三者合流讲**质量关卡**（1.10 `check` + 1.11 钩子/CI/那处偏差）；最后讲**交付**（1.12 构建 → 1.13 发布 → 1.14 为什么 Bun）。**每讲一块，我都会回扣它守的是前 20 节的哪一条规矩**，让你看清「工程外壳」和「业务内核」是怎么咬合的。

### 1.2 测试哲学：co-located + `bun:test`——「测试就住在被测代码隔壁」

> **这是「行为正确」这一维度的地基。** 打开仓库里任何一个源码目录，你都会在它旁边看到一个 `__tests__/` 文件夹——这就是 Helixent 的第一条、也是最显眼的测试约定：**co-located（就近放置）**。

先看这套约定的**全貌**。运行 `find src -path "*__tests__*" -name "*.test.ts"`，会得到 **34 个测试文件**，它们**严格贴着被测源码分布**在五个层里：

```
src/
├── foundation/__tests__/           1 个：tools.test.ts
├── agent/__tests__/                5 个：skills / todos / tool-result-{policy,runtime,summary}
├── coding/
│   ├── tools/__tests__/           15 个：每个工具一个（read-file / write-file / bash / apply-patch …）
│   └── permissions/__tests__/      3 个：approval-manager / coding-approval-middleware / requires-approval
├── community/
│   ├── openai/__tests__/           2 个：utils / stream-utils
│   └── anthropic/__tests__/        2 个：utils / stream-utils
└── cli/
    ├── config/__tests__/           1 个：schema
    ├── settings/__tests__/         2 个：settings / settings-loader
    └── tui/__tests__/              3 个：input-editor / command-registry / token-usage
```

跑一遍 `bun test`，输出是这样的（这就是本节要讲的「行为正确」关卡的实测结果）：

```
 223 pass
 0 fail
 351 expect() calls
Ran 223 tests across 34 files. [959.00ms]
```

**223 个用例、351 次断言、34 个文件、不到 1 秒跑完**——这几个数字本身就说明了很多问题，我们逐条拆解它背后的**四条哲学**：

**哲学一：co-located——测试住在被测代码隔壁，而非集中到顶层 `tests/`。**

[code-convention.md](../code-convention.md) 第 16 行把这条写成了硬约定：

> Tests: co-located `__tests__/<name>.test.ts` beside the source. Imports from `bun:test`.

也就是说，`src/coding/tools/read-file.ts` 的测试，就放在**紧挨着它的** `src/coding/tools/__tests__/read-file.test.ts`，而**不是**放到一个远在天边的 `/tests/coding/tools/read-file.test.ts`。**为什么这样安排？**

- **导航成本趋近于零**：改 `read-file.ts` 时，测试就在同目录的 `__tests__/` 里，一眼可见、随手可开。集中式 `tests/` 树则要求你在两棵平行目录树之间来回跳。
- **「模块 + 测试」是一个内聚单元**：[第 12 节](./12-tool-foundation-file-io.md) 讲过每个工具是一个自包含单元；把测试放在隔壁，等于宣告「这个测试是这个模块的一部分，一起改、一起 review、一起搬家」。
- **删除即同步**：如果哪天删掉 `read-file.ts`，它的测试就在旁边，不会变成 `tests/` 树里一个「指向已删文件的孤儿」。

> **[第 20 节](./20-tui-input-command-render.md) 的回扣**：第 20 节结尾特意列出 `input-editor.test.ts` / `command-registry.test.ts` / `token-usage.test.ts` 三个测试，并强调「它们对应的都是纯函数——正是『逻辑沉成纯函数 → 可单测』的直接受益」。现在你能在上面的地图里找到它们：全在 `src/cli/tui/__tests__/` 下，紧贴着 `input-editor.ts` / `command-registry.ts` / `token-usage.ts`。**co-located 不只是「放得近」，更是在暗示「这个文件是被设计成可测的」**——1.8 会展开这个「可测性」话题。

**哲学二：用 Bun 内置的 `bun:test`——零配置、零依赖、极快。**

打开任何一个测试文件，第一行 import 永远是从 `bun:test` 来的：

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
```

注意这里的 `bun:test` 是 **Bun 运行时内置的模块**（就像 `node:fs` 之于 Node），**不是** `jest`、不是 `vitest`、不是 `mocha`。[bun.md](../bun.md) 第 10 行把这条立成了铁律：「Use `bun test` instead of `jest` or `vitest`」。这带来三个直接好处：

- **零配置**：没有 `jest.config.js`、没有 `vitest.config.ts`、没有 `babel` / `ts-jest` transformer。Bun 原生跑 TypeScript，`bun test` 开箱即用。
- **零额外依赖**：翻一遍 [package.json](../../package.json) 的 `devDependencies`——**没有任何测试框架**。测试能力是运行时白送的。这跟「为什么选 Bun」（1.14）直接相关：**测试运行器是 batteries-included 的一部分**。
- **极快**：223 个用例 959ms 跑完。Bun 的测试运行器用原生代码实现、并行执行文件，冷启动几乎为零。**「快」不是虚荣指标——它决定了 pre-commit 钩子（1.11）能不能被接受**：如果每次 commit 要等 30 秒测试，开发者迟早会 `--no-verify` 绕过它；跑得快，钩子才焊得住。

**哲学三：`describe` / `test` / `expect` 的经典三元组，断言语义化。**

Bun 的测试 API 刻意做成了 Jest 兼容风格，所以你看到的是最主流的那套：`describe("被测单元", () => { test("某个行为", () => { expect(实际).toBe(预期) }) })`。全项目 34 个文件里有 60 个 `describe` 块、223 个 `test`，用的断言也是清一色的语义化匹配器——`toBe` / `toEqual` / `toMatchObject` / `toContain` / `toThrow` / `rejects.toThrow`。**没有自造断言库、没有花哨 DSL**，任何写过 Jest / Vitest 的人都能零成本读懂。

**哲学四：测试发现靠「命名约定」而非「目录约定」。**

[AGENTS.md](../../AGENTS.md) 第 118 行解释了 Bun 的发现规则：Bun 从当前目录向下遍历，运行**文件名匹配** `*.test.*` / `*_test.*` / `*.spec.*` / `*_spec.*` 的文件（扩展名 `js/jsx/ts/tsx`），自动跳过 `node_modules` 和隐藏目录。**关键在于：Bun 不要求测试放在某个特定文件夹**——是**文件名的 `.test.ts` 后缀**让它被发现的，`__tests__/` 目录只是团队自己加的「组织约定」。这解释了为什么 Helixent 能自由选择 co-located：**运行器不关心布局，只认命名**，于是团队可以把「放哪」这个决策留给「可读性 / 内聚性」而非「工具限制」。

> **一处「诚实标注」**：仓库根目录有一个 [test.log](../../test.log) 文件，是某次 `bun test` 输出的**留存快照**（`git ls-files` 显示它被跟踪了）。它**不是**测试基础设施的一部分（跑测试不读它、不写它），更像是一次手动记录。严格说，把一次性输出日志提交进仓库不算最佳实践（1.9 会讲 `.gitignore` 已经忽略了 `*.log` 之外的诸多产物）。本节把它标出来，是为了让你在探索仓库时不被它误导——**它不是「测试怎么组织」的答案，`__tests__/*.test.ts` 才是**。

**小结这一节**：Helixent 的测试哲学可以浓缩成一句话——**「测试就近住在被测代码隔壁（co-located），用运行时白送的 `bun:test` 零配置驱动，靠命名约定被发现，快到可以塞进每一次 commit」**。这四条哲学是接下来 1.3–1.8「具体怎么写测试」的地基。下一小节，我们钻进这 34 个文件，看看它们内部反复出现的那个「三段式套路」。

### 1.3 三段式套路：happy path + 结构化错误 + 边界

> **这是「一个工具该怎么被测」的标准答卷。** [code-convention.md](../code-convention.md) 第 60 行为工具测试立了一条明确的三点式要求：

> Every tool gets a co-located `__tests__/<name>.test.ts` covering: happy path, structured error cases (by `code`), and boundary/range validation.

翻译过来就是每个工具测试至少要覆盖**三类用例**：**① 正常路径（happy path）、② 按错误码分的结构化错误（structured error cases by `code`）、③ 边界 / 范围校验（boundary/range validation）**。我们用最典型的 [read-file.test.ts](../../src/coding/tools/__tests__/read-file.test.ts) 逐条对照——它是这套三段式的教科书范例：

```ts
describe("readFileTool", () => {
  test("returns raw content for whole-file reads", async () => {            // ① happy path：整文件读
    const filePath = join(tempDir, "demo.txt");
    await writeFile(filePath, "a\nb\n");
    const result = await readFileTool.invoke({ description: "Read the whole file", path: filePath });
    expect(result).toBe("a\nb\n");
  });

  test("returns numbered lines for ranged reads", async () => {            // ① happy path 变体：带行号范围读
    const filePath = join(tempDir, "demo.txt");
    await writeFile(filePath, "first\nsecond\nthird\n");
    const result = await readFileTool.invoke({ description: "Read a range", path: filePath, startLine: 2, endLine: 3 });
    expect(result).toContain("2: second");
    expect(result).toContain("3: third");
  });

  test("returns structured error for invalid range", async () => {        // ③ 边界：startLine > endLine
    const result = await readFileTool.invoke({ description: "Bad range", path: filePath, startLine: 3, endLine: 1 });
    expect(result).toMatchObject({ ok: false, code: "INVALID_RANGE" });   // ← 按 code 断言，不是按 message
  });

  test("returns structured error when file is missing", async () => {     // ② 结构化错误：文件不存在
    const result = await readFileTool.invoke({ description: "Missing file", path: join(tempDir, "missing.txt") });
    expect(result).toMatchObject({ ok: false, code: "FILE_NOT_FOUND" });
  });
});
```

**这段测试完美映射了三段式**，而且藏着三个**跟前面章节强呼应的关键手法**：

1. **错误断言用 `code`、不用 `message`**（回扣 [第 4 节](./04-tool.md) / [第 12 节](./12-tool-foundation-file-io.md)）。看 `toMatchObject({ ok: false, code: "INVALID_RANGE" })`——它断言的是**结构化结果里的错误码**，而**不是**去匹配人类可读的 `error` 文案。这正是 [第 4 节](./04-tool.md) 那个 `{ ok, summary, data | error, code }` 契约设计的**回报兑现时刻**：`code` 是 `SCREAMING_SNAKE` 的**稳定机器标识**，文案可以随便改、翻译、润色，测试都不会碎；而如果当初把错误设计成「只有一句 message」，测试就只能脆弱地 `toContain("invalid")`，改一个字就红。**「按 code 断言」是结构化错误契约在测试层的最大红利**——[第 8 节](./08-tool-result-pipeline.md) 的 `inferToolErrorKind` 从错误码前后缀推断类别，也是同一份红利的另一种花法。

2. **`toMatchObject` 而非 `toEqual`**：只断言「我关心的那几个字段」（`ok` + `code`），不锁死整个对象。这样即便结果里多带了 `summary` / `details` 等字段，测试也不碎——**断言「必要条件」而非「全等」，是让测试抗改动的关键**。

3. **`description` 作为第一参数被显式传入**（回扣 [第 4 节](./04-tool.md) / [code-convention.md](../code-convention.md)）。每个 `invoke({ description: "...", ... })` 都老老实实带上了 `description`——这正是 [第 4 节](./04-tool.md) 强调的「`description` 永远是工具参数的第一个字段（模型调用工具的 rationale）」在测试里的体现。测试**忠实模拟了模型的调用形态**，而非走捷径省掉这个「看似无关」的字段。

**为什么「三段式」是好品味？** 因为它对应了一个工具**最容易出问题的三个方向**：正常输入下**结果对不对**（happy path）、异常输入下**是否优雅地返回结构化错误而非崩溃**（error cases）、临界输入下**边界判断有没有差一位**（boundary）。[第 14 节](./14-apply-patch.md) 的 `apply_patch` 那种「逐行比对防漂移」的复杂逻辑，[str-replace.test.ts](../../src/coding/tools/__tests__/str-replace.test.ts)（7 个用例）测的「唯一匹配 / 多匹配报错」的边界，全都是这三段式的展开。**记住这个三分法，你自己给任何工具补测试都不会漏。**

### 1.4 文件系统测试：`mkdtemp` + `afterEach` 的「用完即焚」

> **这是「涉及真实文件 I/O 的测试」的标准姿势。** [code-convention.md](../code-convention.md) 第 60 行的后半句要求：「Use `mkdtemp` + `afterEach` cleanup for filesystem tests.」

再看 [read-file.test.ts](../../src/coding/tools/__tests__/read-file.test.ts) 的开头，这套「建临时目录 → 测 → 拆临时目录」的骨架，在所有文件类工具测试里**一字不差地重复**：

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "helixent-read-file-"));   // 每个用例前：在系统临时区建一个唯一目录
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });             // 每个用例后：递归强删，不留痕迹
});
```

**这套「用完即焚」的骨架，解决的是文件系统测试最大的三个痛点**：

1. **隔离性（用例之间不串味）**：`mkdtemp` 在系统临时目录（`os.tmpdir()`）下创建一个**带随机后缀的唯一目录**（前缀带上工具名 `helixent-read-file-` 便于识别）。每个 `beforeEach` 都建一个新的，所以用例 A 写的文件绝不会污染用例 B。**测试的顺序无关性、可并行性，全靠这个隔离**。

2. **幂等性（跑一百遍结果一样）**：`afterEach` 里 `rm(tempDir, { recursive: true, force: true })` 把整个临时目录连根拔起。`force: true` 保证「即使目录已经不在也不报错」，`recursive: true` 保证「连里面的文件一起删」。**跑完不留任何垃圾，明天再跑还是干净的**——这对 CI（1.11）尤其重要，CI 环境要能被反复复用。

3. **不碰真实工作区**：所有文件操作都发生在 `tmpdir()` 里，**绝不在项目目录里创建测试文件**。这避免了「测试跑一半留下一堆 `demo.txt` 被误提交」的尴尬。

> **`node:fs` vs `Bun.file` 的取舍（回扣 [第 12 节](./12-tool-foundation-file-io.md)）**：注意这里 import 的是 `node:fs/promises` 的 `mkdtemp` / `rm` / `writeFile`，而**不是** `Bun.file`。这看似违反了 [bun.md](../bun.md)「Prefer `Bun.file` over `node:fs`」的建议，其实完全一致——[code-convention.md](../code-convention.md) 第 59 行早有豁免：「File I/O: use `Bun.file(path)` (not `node:fs` unless you need `mkdtemp`/`rm` in tests)」。**`Bun.file` 擅长「读写单个文件」，但「创建临时目录 / 递归删除」这类目录级操作，`node:fs` 的 `mkdtemp` / `rm` 才是趁手工具**。业务代码用 `Bun.file`，测试脚手架用 `node:fs`——各用所长，不是矛盾。

**这套骨架有多普遍？** 凡是碰真实文件的工具测试——`read-file` / `write-file` / `str-replace` / `apply-patch` / `list-files` / `glob-search` / `grep-search` / `file-info` / `mkdir` / `move-path`——**全都是这个 `mkdtemp` + `afterEach` 开头**。看懂一个，就看懂了 `coding/tools/__tests__/` 下的一整批。

### 1.5 异步 Manager 测试：不启动 UI，直接验证「订阅 + 队列 + 单活跃」

> **这是「测一个为 UI 服务、但又不该依赖 UI 的异步组件」的经典难题的解法。** 回忆 [第 15 节](./15-human-in-the-loop.md)：`ApprovalManager` 用「队列 + 单活跃请求 + 订阅」模型桥接「异步 Promise」与「（当时还没登场的）React UI」。**问题来了：这个 Manager 天生是为 TUI 服务的，怎么在没有终端、没有 React 的单测里验证它？**

答案藏在 [approval-manager.test.ts](../../src/coding/permissions/__tests__/approval-manager.test.ts) 里，它**根本不启动任何 UI**，而是**直接扮演「订阅者」和「响应者」两个角色**，用纯异步逻辑验证 Manager 的核心契约：

```ts
test("askUser queues a request and subscriber receives it", async () => {
  const manager = new ApprovalManager();
  const toolUse = makeToolUse("bash");

  const received: ToolUseContent[] = [];
  manager.subscribe((req) => {                    // ← 扮演「UI 订阅者」：把收到的请求记下来
    if (req) received.push(req.toolUse);
  });

  const promise = manager.askUser(toolUse);       // ← Agent 侧发起询问（返回一个悬而未决的 Promise）
  expect(received).toHaveLength(1);               // 断言：订阅者立刻收到了这个请求
  expect(received[0]!.name).toBe("bash");

  manager.respond("allow_once");                  // ← 扮演「用户点了『允许』」
  const decision = await promise;                 // ← Agent 侧的 Promise 现在 resolve 了
  expect(decision).toBe("allow_once");
});
```

**这段测试是「测试异步桥接组件」的范本**，它精准复刻了 [第 15 节](./15-human-in-the-loop.md) 的三个核心行为，且每一个都对应一个用例：

1. **订阅收到请求**（上面这个）：`subscribe` 的回调在 `askUser` 后立即被触发——验证「Agent 一发起询问，UI 就该被通知」。
2. **队列串行处理**（`processes queued requests sequentially`）：连发两个 `askUser`，断言「只有第一个是活跃的；第一个 `respond` 后第二个才变活跃」，最终 `decisions` 数组严格等于 `["allow_once", "deny"]`——验证 [第 15 节](./15-human-in-the-loop.md) 的「单活跃请求 + 队列」不会让两个审批弹窗同时冒出来。
3. **队列空了通知 null**（`subscriber receives null when queue empties`）：最后一个请求被响应后，订阅者会收到一个 `null`——这正是 [第 19 节](./19-tui-architecture.md) 里 `useApprovalManager` 用来「关闭审批弹窗」的信号。
4. **退订后不再回调**（`subscribe returns unsubscribe function`）：调用 `subscribe` 返回的 `unsubscribe()` 后，新请求不再触发回调——验证 React 组件卸载时能干净地解绑（防内存泄漏）。

**这套测试最妙的地方，是它证明了 [第 15 节](./15-human-in-the-loop.md) 那个「用 Manager 解耦 Agent 与 UI」的设计是对的**：正因为 `ApprovalManager` 只依赖「订阅回调」这个抽象接口、而不依赖任何具体的 React 组件，测试才能**用一个普通函数 `(req) => received.push(...)` 冒充 UI**，把整个「Agent 发问 → UI 显示 → 用户响应 → Agent 继续」的回路**在内存里、毫秒级地**跑完。**「可测性」和「解耦」在这里是同一枚硬币的两面**——一个组件如果好测，往往正因为它依赖的是抽象而非具体；反之，一个难测的组件（比如硬编码了 `console.log` 或直接 `new SomeReactComponent()`），往往正是耦合太紧的信号。1.8 会把这条「可测性 ↔ 好设计」的观察升华成本节的一个核心论点。

> **同款范式的另一个例子**：[ask-user-question-manager.test.ts](../../src/coding/tools/__tests__/ask-user-question-manager.test.ts) 用的是**完全一样**的套路——因为 [第 15 节](./15-human-in-the-loop.md) 说过这两个 Manager「共享同一套队列 + 单活跃 + 订阅模型」。测试的「相似」，恰恰印证了源码设计的「共享」。

### 1.6 流式累积器测试：喂假 chunk，验证「拼回完整快照」

> **这是「测 Provider 层核心逻辑而无需真实网络 / 真实模型」的关键技巧。** 回忆 [第 16 节](./16-openai-provider.md)：`StreamAccumulator` 负责把厂商吐出的一个个流式碎片（chunk）增量拼接成完整的 `AssistantMessage`，其中最烧脑的是「未完成的 tool-call JSON 要攒着、直到能解析成功才吐出 tool_use」。**这段逻辑怎么测？总不能每次都真的调 OpenAI 吧？**

[stream-utils.test.ts](../../src/community/openai/__tests__/stream-utils.test.ts) 给出的答案是：**手工构造假的 chunk 对象，一个个 `push` 进去，然后断言 `snapshot()` 的结果**。看它测「跨多个 chunk 拼接 tool call」的用例：

```ts
test("accumulates tool calls across multiple chunks", () => {
  const acc = new StreamAccumulator();
  acc.push({ /* chunk 1 */ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: "" } }] } }] });
  acc.push({ /* chunk 2 */ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command"' } }] } }] });
  acc.push({ /* chunk 3 */ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] } }] });

  const snapshot = acc.snapshot();
  expect(snapshot.content).toHaveLength(1);
  expect(snapshot.content[0]).toMatchObject({ type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } });
});
```

看到了吗？`arguments` 的 JSON 被**故意拆成三段**喂进去（`""` → `'{"command"'` → `':"ls"}'`），最后断言累积器把它们拼回了完整的 `{ command: "ls" }`。这套「喂假碎片、验证拼装」的手法，把 [第 16 节](./16-openai-provider.md) 最精妙的两个设计**钉死成了可回归的测试**：

1. **「参数没解析成功前不吐出 tool_use」**（`withholds incomplete tool_use during streaming`）：只 push 一个「JSON 残缺」的 chunk（`arguments: '{"command'`），断言 `snapshot().content` 长度为 **0**——验证 [第 16 节](./16-openai-provider.md) 那个「宁可暂时不吐，也不吐一个半成品 tool_use」的严谨。

2. **「最终快照即使 JSON 仍残缺也要吐出（带空 input）」**（`includes tool_use with empty input on final snapshot even if JSON is incomplete`）：先 push 残缺 chunk，再 push 一个带 `usage` 的**收尾 chunk**，断言这次 `content` 长度为 **1**、`input` 是 `{}`、且 `streaming` 变成 `undefined`——验证「流结束了就必须交代结果，哪怕参数没拼全也给个空对象兜底」。

**这套测试的方法论价值，是它示范了「怎么把一个依赖外部服务的组件，变成纯逻辑单测」**：

- **依赖被「数据化」了**：`StreamAccumulator` 不自己发网络请求、不自己连模型，它只接受「一串 chunk 对象」。于是测试只要**手工造出这串对象**，就能覆盖任何场景——正常拼接、残缺 JSON、多个并行 tool call、空 chunk、只有 usage 的收尾 chunk……**全部离线、确定、毫秒级**。
- **这正是 [第 3 节](./03-model.md) / [第 16 节](./16-openai-provider.md)「Model 编排壳 vs Provider 适配」分层的红利**：因为 `StreamAccumulator` 被切成了一个「纯函数式的碎片拼装器」（输入 chunk、输出 snapshot，无副作用），它才能这么好测。**如果当初把「拼装逻辑」和「网络请求」揉在一起，就永远只能靠 mock `fetch` 或真连 API 来测了**——那种测试又慢又脆。
- **确定性的另一个来源（回扣 1.2 哲学 & [第 16 节](./16-openai-provider.md)）**：[第 16 节](./16-openai-provider.md) 讲过 Provider 默认 `temperature: 0`。虽然这些累积器单测根本不调模型（所以 temperature 影响不到它们），但它体现的是**同一种「追求确定性」的工程价值观**——无论是「累积器输入确定的 chunk 就输出确定的 snapshot」，还是「模型 temperature=0 尽量输出确定结果」，都是为了让系统**可预测、可测试、可复现**。

> **[第 17 节](./17-anthropic-provider.md) 的对照**：[anthropic/__tests__/stream-utils.test.ts](../../src/community/anthropic/__tests__/stream-utils.test.ts)（9 个用例）用的是同一套「喂假 chunk」手法，但喂的是 Anthropic 格式的事件（`content_block_start` / `content_block_delta` / …）。**两个 Provider 的累积器测试『形似而神同』**——正好印证了 [第 17 节](./17-anthropic-provider.md) 那个「同名不同实现的 `StreamAccumulator`」的对比主题。

### 1.7 环境相关测试：`test.skipIf` 的「优雅跳过」

> **这是「测试依赖了某个不一定存在的外部程序」时的正确姿势。** 有些工具（比如 [第 13 节](./13-search-system-tools.md) 的 `bash`）天生依赖运行环境里的外部程序。如果测试机上没装那个程序，测试该怎么办？直接失败（红叉）显然不公平——那不是代码的错。

[bash.test.ts](../../src/coding/tools/__tests__/bash.test.ts) 给出的答案是 `test.skipIf`：

```ts
function zshOnPath(): boolean {
  return ["/bin/zsh", "/usr/bin/zsh"].some((p) => existsSync(p));
}

describe("bashTool", () => {
  test.skipIf(!zshOnPath())("returns stdout for a successful command", async () => {
    const result = await bashTool.invoke({ description: "Echo greeting", command: "printf 'hi\\n'" });
    expect(result).toBe("hi\n");
  });

  test.skipIf(!zshOnPath())("returns an error string when the command fails", async () => {
    const result = await bashTool.invoke({ description: "Force non-zero exit", command: "exit 42" });
    expect(result).toMatch(/^Error: Command exit 42 failed with exit code 42:/);
  });
});
```

**`test.skipIf(condition)` 的含义是「当 condition 为真时，跳过这个用例（标记为 skipped 而非 failed）」**。这里的条件是「系统里找不到 zsh」——因为 [第 13 节](./13-search-system-tools.md) 讲过 `bash` 工具是用 zsh 执行命令的。这套设计体现了两个成熟的测试价值观：

1. **区分「失败」和「不适用」**：测试机没装 zsh，不是代码错了，而是「这个用例在此环境不适用」。`skipIf` 让它显示为 **skipped**（灰色），而不是 **failed**（红色）——**CI 的红叉应该只留给『真正的 bug』**，环境缺失不该污染这个信号。

2. **测试要能在异构环境跑**：开发者的 Mac、CI 的 Ubuntu、别人的机器……环境千差万别。`skipIf` 让测试套件**足够健壮、能在任何环境跑而不假阳性**。这跟 1.4 的 `mkdtemp`（不依赖固定路径）是同一种「让测试与环境解耦」的思路。

> **注意第二个用例的错误断言**：`expect(result).toMatch(/^Error: Command exit 42 failed with exit code 42:/)`——它验证的是 [第 6 节](./06-parallel-tools.md) / [code-convention.md](../code-convention.md) 那条「工具错误就地捕获成 `Error:` 文本、绝不抛出」的容错哲学。`bash` 命令失败时**不 throw**，而是返回一个 `"Error: ..."` 开头的字符串——测试忠实地验证了这一点。**又一次，测试成了源码设计约定的『活文档』。**

### 1.8 该测什么、不该测什么：「可测性」是设计质量的镜子

> **这是本节测试部分的「价值观总纲」，也是回答「为什么有些文件有测试、有些没有」的关键。** 看过 1.3–1.7 五类范式后，你可能会问：**34 个测试文件覆盖了哪些代码？没被测的（比如 `agent.ts` 主循环、整个 `cli/tui/` 的 React 组件）为什么不测？**

先看 [AGENTS.md](../../AGENTS.md) 第 122 行那段极其克制、极其诚实的表态：

> **What must be tested: Not everything.** Unit tests are encouraged for pure logic, non-trivial algorithms, and regressions, but they are **not** a blanket requirement for every change. Thin glue, obvious pass-throughs, or exploratory edits may ship without new tests when the cost outweighs the benefit—use judgment.

翻译过来：**「不是所有东西都要测。纯逻辑、非平凡算法、回归 bug 值得测；薄胶水、显而易见的透传、探索性改动，当测试成本大于收益时可以不测——用判断力。」** 这条「反教条」的测试观，配上前面 34 个文件的实际分布，能读出一条清晰的**「测 / 不测」分界线**：

**倾向于「测」的（对照实际测试文件）**：

- **纯函数 / 纯逻辑**：`input-editor`（光标增删移）、`command-registry`（命令解析）、`token-usage`（用量累加）、`tool-utils`（路径校验）——[第 20 节](./20-tui-input-command-render.md) 反复强调的「逻辑沉成纯函数」，这里全都对应着测试文件。**纯函数 = 输入确定则输出确定 = 最好测**。
- **非平凡算法**：`apply-patch`（[第 14 节](./14-apply-patch.md) 的 diff 解析）、`StreamAccumulator`（[第 16/17 节](./16-openai-provider.md) 的流式拼装）、`tool-result-*`（[第 8 节](./08-tool-result-pipeline.md) 的归一化 / 截断 / 摘要）——**逻辑越绕、越容易出 bug 的地方，测试越密**。
- **契约边界**：`schema`（[第 18 节](./18-cli-config-persistence.md) 的 Zod 配置校验）、`settings-loader`（多层白名单合并）、`requires-approval`（[第 15 节](./15-human-in-the-loop.md) 的审批判定）——**「什么该放行、什么该拦截」这类判定，一旦错就是安全 / 数据问题，必须测**。
- **异步协调**：`approval-manager` / `ask-user-question-manager`（1.5 讲的队列 + 订阅）——**并发时序容易出错，值得钉死**。

**倾向于「不测」的**：

- **薄胶水 / 装配代码**：`lead-agent.ts`（[第 11 节](./11-lead-agent.md) 的「把零件拼起来」）——它主要是「调用工厂 + 传参」，逻辑几乎都在被它组装的、已被单独测过的零件里。
- **React 组件 / TUI 渲染**：整个 `cli/tui/components/*.tsx`——它们是「把状态画到终端」的展示层，测试成本高（要模拟 Ink 渲染）、收益低（视觉正确性靠人眼比靠断言更靠谱）。**注意：`cli/tui/` 里被测的三个文件全是纯函数（`input-editor` / `command-registry` / `token-usage`），组件本身不测**——这个分布本身就是「测纯逻辑、不测展示」的铁证。
- **主循环编排**：`agent.ts` 的 `stream` / `_think` / `_act`（[第 5/6 节](./05-react-loop.md)）——它是「编排已被测过的零件」的胶水，且要测它得 mock 掉模型、工具、中间件一大堆东西，成本极高。

**这条分界线背后，是本节最重要的一个论点**：**「一段代码好不好测，是它设计好不好的镜子。」**

- 回看 1.5：`ApprovalManager` 好测，**因为**它依赖「订阅回调」这个抽象、而非具体的 React 组件——**可测性证明了它的解耦**。
- 回看 1.6：`StreamAccumulator` 好测，**因为**它被切成了「输入 chunk、输出 snapshot」的纯逻辑、不掺网络——**可测性证明了它的单一职责**。
- 回看 1.3：工具好测，**因为**它们返回结构化的 `{ ok, code, ... }`、而非抛异常或打印日志——**可测性证明了 [第 4 节](./04-tool.md) 契约设计的价值**。

**反过来**，`agent.ts` 和 TUI 组件难测，**恰恰因为它们的职责就是「编排」和「呈现」——本质是集成点，天生依赖一堆协作者**。对它们，「集成测试 / 手动验证 / 类型检查兜底」比「硬凑单元测试」更划算。**Helixent 没有为了『覆盖率数字好看』而给它们硬写脆弱的 mock 测试**——这份克制，本身就是工程成熟度的体现。

> **一句话总结这条分界**：**「往下沉成纯函数的逻辑，用单测钉死；往上做编排 / 呈现的胶水，用类型检查 + 集成 + 判断力兜底。」** 这也解释了为什么全项目 223 个用例高度集中在 `foundation` / `agent` / `coding/tools` / `community` 这些「逻辑密集层」，而 `cli` 层只测了三个纯函数文件。**测试的分布，精准地画出了这个项目『逻辑重心』的地形图。**

至此，「行为正确」这一维度讲完了。接下来转向另外两个维度——**「类型正确」和「规范正确」**，看代码规范三件套（TS / ESLint / Prettier）如何把 [第 1 节](./01-overview.md) 立下的那些约定变成会报错的关卡。

### 1.9 规范三件套：TypeScript / ESLint / Prettier，各管一段

> **这是「类型正确 + 规范正确」两个维度的实现。** [第 1 节](./01-overview.md) 引用的 [code-convention.md](../code-convention.md) 立下了 100 行规矩，但「写下规矩」不等于「强制规矩」。真正把规矩变成**会报错的关卡**的，是三个配置文件——它们**分工明确、互不重叠**：

| 工具 | 配置文件 | 管什么 | 对应 `check` 里的哪一段 |
|---|---|---|---|
| **TypeScript** | [tsconfig.json](../../tsconfig.json) | 类型对不对（含 `strict` 全家桶） | `tsc --noEmit` |
| **ESLint** | [eslint.config.js](../../eslint.config.js) | 代码规范、import 顺序、依赖方向 | `eslint . --ext .ts` |
| **Prettier** | [.prettierrc](../../.prettierrc) | 纯格式（缩进、引号、分号、行宽） | （被 ESLint 集成，不冲突） |

**逐个看它们守的是前 20 节的哪条规矩。**

**① TypeScript（`tsconfig.json`）——「类型正确」的地基。**

打开 [tsconfig.json](../../tsconfig.json)，最关键的是这几个开关：

```jsonc
{
  "compilerOptions": {
    "strict": true,                        // ← 严格模式全家桶（null 检查、隐式 any 等）
    "noFallthroughCasesInSwitch": true,    // switch 漏 break 报错
    "noUncheckedIndexedAccess": true,      // ← arr[i] 的类型自动带 undefined，逼你处理越界
    "noImplicitOverride": true,            // 覆写父类方法必须写 override
    "verbatimModuleSyntax": true,          // ← 逼你区分 import type 和 import
    "moduleResolution": "bundler",         // 配合 Bun 的打包式解析
    "allowImportingTsExtensions": true,    // 允许 import "./foo.ts" 带扩展名
    "paths": { "@/*": ["./src/*"] }        // ← 第 1 节讲的 @/* 路径别名
  }
}
```

其中三个开关**直接呼应前 20 节的设计**：

- **`noUncheckedIndexedAccess`**：让 `arr[i]` 的类型自动变成 `T | undefined`。回看 1.5 的测试里那个 `received[0]!.name`——那个 `!` 非空断言，正是因为这个开关让 `received[0]` 带上了 `undefined`，测试作者必须显式断言「我确定它不是 undefined」。**这个开关逼着全项目正视「数组越界 / Map 取不到」这类最常见的运行时崩溃源**。
- **`verbatimModuleSyntax`**：强制区分 `import type { X }`（只导入类型，编译后消失）和 `import { x }`（导入值）。这正是 [code-convention.md](../code-convention.md) 第 84 行「Use `import type { ... }` for type-only imports」的**编译器级强制**——配合下面 ESLint 的 `consistent-type-imports` 双重保险。
- **`paths: { "@/*": ["./src/*"] }`**：[第 1 节](./01-overview.md) 讲的跨层导入用 `@/foundation` 这种别名，就落地在这里。

`tsc --noEmit` 里的 `--noEmit` 意味着**「只检查类型、不产出 JS 文件」**——因为真正的编译 / 打包交给 Bun（1.12），`tsc` 在这里的唯一职责就是当**类型检查器**。

**② ESLint（`eslint.config.js`）——「规范正确」的执法者，还兼管依赖方向。**

[eslint.config.js](../../eslint.config.js) 用的是新版 flat config，最值得注意的是它启用了 **`languageOptions.parserOptions.project: true`**（类型感知的 lint，能读类型信息做更强的检查），以及这几条**直接执行 code-convention 的规则**：

```js
rules: {
  "@typescript-eslint/consistent-type-imports": "error",   // ← 强制 import type（呼应 verbatimModuleSyntax）
  "@typescript-eslint/no-floating-promises": "error",      // ← 未 await 的 Promise 报错（呼应第 5/6 节的异步纪律）
  "@typescript-eslint/no-explicit-any": "warn",            // 用 any 警告（不禁止，留活口）
  "import-x/order": ["error", { /* 三组导入 + 字母序 */ }], // ← 强制第 1 节的 import 分组顺序
  "no-console": ["warn", { allow: ["info", "warn", "error"] }],  // 只准 console.info/warn/error
}
```

- **`import-x/order`** 是最能体现「把约定变成关卡」的一条。[code-convention.md](../code-convention.md) 第 78-84 行规定 import 分三组（`node:*/bun:*/三方` → `@/*` 别名 → 相对路径），组间空行、组内字母序。这条 ESLint 规则**把这套排版规矩变成了 `error` 级别的关卡**——顺序错了直接红。配置里的 `pathGroups` 还专门把 `@/**` 归到 `internal` 组，正是为了实现「别名单独成组」。
- **`no-floating-promises: error`**：任何「创建了却没 `await`、没 `.catch()`、没 `void`」的 Promise 都报错。这守的是 [第 5/6 节](./05-react-loop.md) 那套「AbortController 贯穿、异步严谨」的纪律——**漏掉一个 await 在 Agent 循环里可能就是一个悄悄吞掉的错误**。
- **`no-console` 只放行 `info/warn/error`**：禁止 `console.log`（调试残留），但放行有语义的三个。回看 [README](../../README.md) 那个「How to Build a Coding Agent from Scratch」示例里全用 `console.info`——正是这条规则的产物。
- **顶部的 `ignores`**：`["dist/**", "node_modules/**", "web/**", "user-home/**"]`——lint 不检查产物目录和第三方。

**③ Prettier（`.prettierrc`）——只管「长相」，且和 ESLint 划清界限。**

[.prettierrc](../../.prettierrc) 只有 4 行，管的是**纯格式**：

```json
{ "printWidth": 120, "singleQuote": false, "semi": true, "trailingComma": "all" }
```

行宽 120、用双引号、带分号、多行结构尾逗号全加。**关键在于它和 ESLint 的关系**：[eslint.config.js](../../eslint.config.js) 最后一行 `prettier`（即 `eslint-config-prettier`）的作用是**「关掉所有和 Prettier 冲突的 ESLint 格式规则」**。这实现了一条清晰的分工——**「代码长什么样（缩进 / 引号 / 换行）交给 Prettier，代码对不对（逻辑 / 规范 / 类型）交给 ESLint」**，两者井水不犯河水。这是现代 TS 项目的标准最佳实践，避免了「ESLint 和 Prettier 互相打架、改了这个红那个」的经典陷阱。

> **[第 4 附加] Markdown 也有 linter**：[.markdownlint.json](../../.markdownlint.json) 给文档（就是你正在读的这些 `.md`）配了 markdownlint，关掉了一批对教程不友好的规则（`line-length: false` 允许长行、`no-inline-html: false` 允许内嵌 HTML、`single-h1: false` 允许多个一级标题）。**连文档都上了 linter**——这从侧面说明这个项目对「一致性」的追求延伸到了代码之外。

**小结三件套**：**TypeScript 管「类型对不对」、ESLint 管「规范对不对 + 依赖方向对不对」、Prettier 管「长相齐不齐」**，三者各守一段、互不重叠，共同把 [code-convention.md](../code-convention.md) 那 100 行「人读的规矩」翻译成了「机器执行的关卡」。下一节，看这三者 + 测试如何被合并成一条命令。

### 1.10 `bun run check`：把四项检查合并成一条命令

> **这是本节的「收敛点」——1.2–1.9 讲的所有检查，在这里汇成一条命令。** 翻开 [package.json](../../package.json#L40) 的 `scripts`：

```jsonc
"scripts": {
  "check": "tsc --noEmit && eslint . --ext .ts && bun test",   // ← 三合一质量关卡
  "check:types": "tsc --noEmit",                               // 只查类型（快速迭代用）
  "dev": "bun run index.ts",                                   // 开发模式直接跑
  "lint": "eslint . --ext .ts",
  "lint:fix": "eslint . --ext .ts --fix",                      // 自动修可修的规范问题
  "build:bin": "rm -rf dist/bin && bun build index.ts --compile --outfile dist/bin/helixent",
  "build:js":  "rm -rf dist/js && bun build ./index.ts --outdir ./dist/js --splitting --target bun",
  "prepublishOnly": "bun run build:bin",
  "release:patch": "npm version patch && npm publish",
  "release:minor": "npm version minor && npm publish",
  "hooks:install": "git config core.hooksPath .githooks"
}
```

**`check` 这一行是整节的核心**：`tsc --noEmit && eslint . --ext .ts && bun test`。三个命令用 `&&` 串联——**任何一个失败（非零退出码），整条链立刻中断、`check` 返回失败**。它精准覆盖了三个正交维度：

1. `tsc --noEmit` → **类型对不对**（1.9 的 TypeScript）
2. `eslint . --ext .ts` → **规范 / 依赖方向对不对**（1.9 的 ESLint）
3. `bun test` → **行为对不对**（1.2–1.8 的 223 个用例）

**这条命令的设计有三个值得玩味的取舍**：

- **顺序即「性价比排序」**：`tsc`（几秒）→ `eslint`（几秒）→ `bun test`（约 1 秒）。虽然测试最快，但把最可能挂、且反馈最直接的类型检查放前面，符合「fail fast」——类型都不过，跑测试没意义。
- **`&&` 而非 `;`**：用 `&&` 保证「前一个过了才跑下一个」，任何一环红就立刻停，不浪费时间。
- **提供了「轻量版」`check:types`**：迭代类型时不想等 lint + test，可以只跑 `bun run check:types`。**这体现了「关卡要严，但日常要快」的平衡**——完整关卡留给提交时，日常给你快速反馈的小工具。

[code-convention.md](../code-convention.md) 第 7 行把这条命令称为 **「Gate」（关卡）**，[AGENTS.md](../../AGENTS.md) 结尾也专门有「Quality gate」一节强调：「Run `bun run check` as the main gate」。**「一条命令 = 一道关卡」——这个极简设计，是让下一节的『钩子 + CI 双保险』能够成立的前提**：钩子和 CI 都只需要记住「跑 `bun run check`」这一件事，不用各自维护一串检查步骤。

### 1.11 双保险：pre-commit 钩子（本地）+ GitHub Actions（远端）——附一处「诚实标注」

> **这是「让关卡绕不过去」的最后一环。** 光有 `bun run check` 这条命令还不够——得有机制**强制它在关键节点被执行**。Helixent 用两道关卡夹击。

**远端关卡：GitHub Actions（`.github/workflows/check.yml`）。**

这个文件短得可以全文引用：

```yaml
name: Check
on:
  push:
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
      - name: Install dependencies
        run: bun install --frozen-lockfile
      - name: Run check
        run: bun run check          # ← 就是 1.10 那条命令
```

读它的四个关键点：

- **触发时机 `on: push / pull_request`**：**每一次推送、每一个 PR** 都会触发。这是「远端兜底」——哪怕本地钩子被绕过（`git commit --no-verify`），代码推上 GitHub 后 CI 还会拦一道。
- **`runs-on: ubuntu-latest`**：在**干净的 Ubuntu 环境**跑。这跟 1.4 的 `mkdtemp`（不依赖固定路径）、1.7 的 `skipIf`（不依赖特定程序）呼应上了——**正因为测试写得「环境无关」，才能在和开发者 Mac 完全不同的 Ubuntu 上绿灯**。（`bash.test.ts` 在 Ubuntu 上若没 zsh 会 skip，不会假红。）
- **`bun install --frozen-lockfile`**：用 `--frozen-lockfile` 强制严格按 [bun.lock](../../bun.lock) 安装，**任何 lockfile 与 package.json 的不一致都会让 CI 失败**——保证「CI 装的依赖和你本地一模一样」，杜绝「我这能跑」的经典甩锅。
- **核心就一句 `bun run check`**：CI 不重新发明检查逻辑，直接复用 1.10 那条命令。**「本地跑什么，CI 就跑什么」——单一事实来源，绝不会出现「本地过了 CI 挂了因为两边检查不一样」的情况**。[README](../../README.md) 里那个 `[![Check]]` 徽章，绿的就是这个 workflow。

**本地关卡：pre-commit 钩子——这里有一处「诚实标注」。**

按 [AGENTS.md](../../AGENTS.md) 和 [README](../../README.md) 的描述，本地这道关卡应该是这样工作的：仓库带一个 pre-commit 钩子脚本，开发者跑 `bun run hooks:install`（即 `git config core.hooksPath .githooks`）把 Git 的钩子目录指向 `.githooks/`，此后**每次 `git commit` 都会先自动跑 `bun run check`，不过就拒绝提交**。钩子脚本本身很简单：

```sh
#!/usr/bin/env sh
set -eu
echo "Running bun run check..."
bun run check
```

**但仓库当前的真实状态与文档描述有偏差，值得如实指出**（这本身就是「工程视角」的一课）：

1. **钩子脚本的位置对不上**：文档说钩子在 `.githooks/pre-commit`，但仓库里 **`.githooks/` 目录当前是空的**，真正的 [pre-commit](../../pre-commit) 脚本躺在**仓库根目录**。
2. **`hooks:install` 指向的目录是空的**：`hooks:install` 脚本执行 `git config core.hooksPath .githooks`，可 `.githooks/` 里并没有钩子——所以即便跑了这条命令，也不会有钩子生效。
3. **`core.hooksPath` 当前未设置**：实测 `git config --get core.hooksPath` 返回空，说明这套本地钩子**当前并未激活**。

**这处偏差怎么理解、怎么修？**

- **成因推测**：很可能是钩子脚本一开始放在根目录，后来文档 / `hooks:install` 脚本按「规范做法」改成了 `.githooks/`，但**脚本文件本身忘了跟着挪进去**。这是一个典型的「文档先行、实现掉队」的小疏漏——恰恰印证了本节的一个观点：**「文档、脚本、真实状态三者的一致性，本身就是工程质量的一个维度」**，而且是最容易被忽视、需要靠「对照真实状态」才能发现的维度。
- **修复方式**：把根目录的 `pre-commit` 移动到 `.githooks/pre-commit`（`mkdir -p .githooks && git mv pre-commit .githooks/pre-commit`），确保脚本有可执行权限，然后 `bun run hooks:install` 就能名副其实了。或者反过来，如果坚持放根目录，就把 `hooks:install` 改成 `git config core.hooksPath .`。**两种都行，关键是让「文档说的位置」「脚本的实际位置」「`hooks:install` 指向的位置」三者一致**。

> **为什么本地钩子和 CI 要「双保险」，而不是只留一个？**
>
> - **只留 CI**：反馈太晚——代码推上去、等 CI 跑完（几分钟）才发现类型错了，来回折腾。且「脏提交」已经进了 git 历史。
> - **只留本地钩子**：不可靠——钩子是「可选安装」的（要手动 `hooks:install`），新贡献者可能没装；而且 `git commit --no-verify` 一句就能绕过。
> - **两个都留**：本地钩子给**快速反馈**（提交前几秒就拦下 90% 的问题），CI 给**强制底线**（不管本地怎么样，进主干前必过）。**「本地图快、远端图稳」——这就是双保险的分工**。[README](../../README.md) 第 188 行那句话说得很实在：「这会让提交过程慢一点，但我们认为值得。毕竟在 AI 主导的 GitHub 世界里，我们应该守住代码质量的最后一公里。」

至此，「规矩 → 命令 → 关卡」这条收敛链讲完了。通过关卡的代码，接下来要走向用户——先看它怎么被打包成一个二进制。

### 1.12 构建：`bun build --compile` 产出单文件二进制

> **这是「从源码到可执行程序」的一步，也是选 Bun 最直接的红利之一。** 回看 [package.json](../../package.json) 的两个 build 脚本，它们产出**两种截然不同的东西**：

```jsonc
"build:bin": "rm -rf dist/bin && bun build index.ts --compile --outfile dist/bin/helixent",
"build:js":  "rm -rf dist/js && bun build ./index.ts --outdir ./dist/js --splitting --target bun",
```

**① `build:bin`——给终端用户的「单文件可执行程序」。**

`bun build index.ts --compile --outfile dist/bin/helixent` 的核心是 **`--compile`**：它把「你的代码 + 所有依赖 + Bun 运行时本身」**全部塞进一个自包含的原生可执行文件** `dist/bin/helixent`。这个文件的特点是：

- **不需要目标机器装 Bun、装 Node、装任何东西**——运行时被打包进去了。用户拿到这一个文件就能跑。
- **入口是 [index.ts](../../index.ts)**，内容只有一行 `import "./src/cli";`——[第 18 节](./18-cli-config-persistence.md) 讲过，这就是 CLI 的启动入口。
- **产物路径 `dist/bin/helixent`**，正好对应 [package.json](../../package.json#L26) 的 `"bin": { "helixent": "dist/bin/helixent" }`——所以 `npm i -g helixent` 后，`helixent` 命令直接指向这个二进制。

这就是 [README](../../README.md) 里「Standalone executables」那句话的落地：**「`bun build --compile` 输出一个自包含的二进制，分发 CLI 就是把一个文件交给用户——无需单独装运行时」**。对比 Node 生态：Node 没有官方的「编译成单文件」能力，分发 CLI 通常要么要求用户先装 Node + `npm i -g`（拉一堆 `node_modules`），要么用 `pkg` / `nexe` 这类第三方工具（各有坑）。**Bun 把这件事变成了一个内置 flag**。

**② `build:js`——给「把 Helixent 当库用」的开发者。**

`bun build ./index.ts --outdir ./dist/js --splitting --target bun` 产出的是**普通的 JS 模块**（不是可执行文件），用 `--splitting`（代码分割，共享 chunk 去重）、`--target bun`（针对 Bun 运行时优化）。这是为 [README](../../README.md) 那个 `import { createCodingAgent } from "helixent/coding"` 的用法服务的——**Helixent 既是一个 CLI 工具，也是一个可被 `import` 的库**（[src/index.ts](../../src/index.ts) 那三行 `export *` 就是库的公开 API 面）。

> **两个 build 的分工，对应 [package.json](../../package.json) 里两个字段**：`"bin"` 指向编译后的二进制（CLI 用户），`"module": "index.ts"` 指向源码入口（库用户）。**一份源码，两种交付形态**——这是 1.1 图里「关卡 → 交付」那一格的展开。

**`rm -rf dist/xxx` 前缀**：每个 build 脚本都先删掉旧产物再重建，保证「产物目录干净、不残留上次的旧文件」。而 [.gitignore](../../.gitignore) 里 `dist` 赫然在列——**产物不进版本库**（实测 `git ls-files dist/` 为空，印证了这一点），符合「源码进库、产物按需生成」的铁律。

### 1.13 发布：`prepublishOnly` 兜底 + `release:*` 一键上架 npm

> **这是「从二进制到 npm 包」的最后一跳。** Helixent 已经发布在 [npm](https://www.npmjs.com/package/helixent) 上（当前版本见 [package.json](../../package.json#L3) 的 `1.3.1`）。发布链路由三个脚本 + 几个字段协同：

**① `prepublishOnly`——npm 生命周期钩子，发布前的「安全带」。**

```jsonc
"prepublishOnly": "bun run build:bin",
```

`prepublishOnly` 是 **npm 的内置生命周期脚本**——它在 `npm publish` **真正上传之前自动执行**。这里让它跑 `build:bin`，意味着**「每次发布前，都强制重新编译一次二进制」**。为什么重要？因为 [package.json](../../package.json#L28) 的 `"files": ["dist/bin/helixent"]` 声明了「发布时只打包这一个文件进 npm 包」——如果发布前不重新 build，就可能把**过时的 / 根本不存在的**二进制发出去。`prepublishOnly` 把「发布前必须 build」这件事**焊死进 npm 流程**，让人「想漏都漏不掉」。**这和 1.11 的钩子是同一种思路——把『容易忘的必要步骤』变成『自动、强制』**。

**② `release:patch` / `release:minor`——一键版本号 + 发布。**

```jsonc
"release:patch": "npm version patch && npm publish",
"release:minor": "npm version minor && npm publish",
```

- `npm version patch` → 把版本号的补丁位 +1（`1.3.1` → `1.3.2`），并**自动打一个 git tag**。
- `npm version minor` → 次版本位 +1（`1.3.1` → `1.4.0`）。
- 紧接着 `npm publish` → 触发上面的 `prepublishOnly`（重新 build）→ 按 `files` 打包 → 上传到 npm。

**一条 `bun run release:patch` 就走完「升版本号 → 打 tag → 重编译 → 发布」全流程**——把易错的手动多步操作收敛成一键，且 [package.json](../../package.json#L4-L7) 的 `"publishConfig": { "access": "public" }` 保证发布为公开包。

**③ 元数据字段——包的「身份证」。**

[package.json](../../package.json) 顶部那堆字段（`name` / `version` / `description` / `author` / `license: MIT` / `repository` / `homepage` / `bugs` / `keywords`）就是 npm 包页面上展示的信息。**规整的元数据也是「作品完成度」的一部分**——它决定了别人在 npm 上搜到这个包时，看到的是不是一个「认真维护、信息齐全」的项目。

> **发布链路总结**：`release:*`（升版本 + tag + publish）→ `prepublishOnly`（发布前强制 build）→ `files`（只打包二进制）→ npm 包页面（靠元数据字段）。**每一环都在贯彻本节的核心思想：把『必要但易忘的步骤』自动化、强制化**——从 `check` 关卡到 `prepublishOnly`，都是同一种「不靠自觉、靠机制」的工程哲学。

### 1.14 为什么是 Bun，而不是 Node / Deno？

> **这是本节、也是全书的一个「技术选型总账」。** 从 [第 13 节](./13-search-system-tools.md) 的 `Bun.spawn`、到本节的 `bun:test` / `bun build --compile`，整个项目从头到尾押注 Bun。[bun.md](../bun.md) 第 7 行的态度斩钉截铁：「Default to using Bun instead of Node.js」。[README](../../README.md) 的「Why Bun?」一节给出了完整理由，我们把它和本节前面的内容串起来看——**你会发现前面每一小节都在为「选 Bun」提供论据**：

1. **异步是 Agent 的天性，而 JS/TS 的 async/await 是母语**。Agent loop 本质是异步的——模型思考、工具执行、结果流式回传，还经常并行（[第 6 节](./06-parallel-tools.md) 的 `Promise.race` 并发调度）。JS/TS 把 `async/await` 焊进了语言和运行时，写并发编排不需要 Python 那种 `asyncio` 样板或回调地狱。**这是选「JS 系」而非 Python 的理由**。

2. **和 Claude Code 同款运行时**。[README](../../README.md) 明说「Bun powers Claude Code」——选一个被头部 Coding Agent 验证过的运行时，生态和踩坑经验都有借鉴。

3. **性能**：HTTP、文件 I/O、冷启动都比 Node 快一截。**当一次 Agent run 要发几十个工具调用（每个都碰文件系统 / 子进程），这点差距会累积成明显的体感差异**——回扣本节 1.2：223 个测试 959ms 跑完，也是这份性能的直接体现（跑得快，钩子才焊得住）。

4. **单文件可执行程序**（`bun build --compile`）：1.12 已详述——一个自包含二进制，分发 CLI 只需交一个文件。**这是选 Bun 而非 Node 的最硬核理由之一**（Node 没有官方的等价能力）。

5. **Batteries included**（自带电池）：测试运行器（`bun:test`，1.2）、打包器（`bun build`，1.12）、原生 TS 支持——全部内置，**不用额外拼装 jest + webpack + ts-node 那套工具链**。回扣 1.2：正因为 `bun:test` 是白送的，`devDependencies` 里才干干净净没有任何测试框架。

**那为什么不是 Deno？** [README](../../README.md) 没有直接对比 Deno，但从项目的选择能反推出几点：Deno 虽然也自带 TS / 测试 / 打包，但**它的「和 Claude Code 同款」「和 npm 生态无缝」两点不如 Bun**——Helixent 重度依赖 npm 上的 `openai` / `@anthropic-ai/sdk` / `ink` / `react` / `commander` / `zod`（[package.json](../../package.json) 的 `dependencies`），Bun 对 npm 包的兼容性和安装速度是它的强项；而且 Bun 的 `--compile` 单文件产物、以及「被 Claude Code 采用」的背书，都让它在「做一个要分发的 Coding Agent CLI」这个具体场景里更契合。**技术选型没有绝对最优，只有「对这个项目最合适」——对一个『要像 Claude Code 一样分发、重度用 npm 生态、追求异步性能和单文件交付』的 Coding Agent 来说，Bun 是那个甜点。**

> **一句话收束技术选型**：**Bun 之于 Helixent，不是「赶时髦」，而是「每一个工程需求（异步 / 性能 / 单文件分发 / 内置工具链 / npm 兼容）都恰好被它命中」的结果**。本节前面讲的测试、构建、发布，几乎每一环都在无声地复用 Bun 的某项内置能力——**这个项目从骨子里就是「Bun-native」的**。

***

## 2. 亮点与关键设计

回望本节，Helixent 的「工程外壳」有六处设计称得上「妙笔」或「关键决策」，逐一点评：

### 亮点 1：「规矩 → 一条命令 → 两道关卡」的收敛（关键决策）

**最值得学的一处**。前 20 节立下的一大堆抽象约定，被收敛成 `bun run check` 这**一条命令**，再被 pre-commit + CI **两道关卡**焊死。这个「收敛」的价值在于：**约定不再依赖『人的自觉』，而是变成『机器绕不过去的门』**。任何团队都该问自己一句：「我们那些写在 wiki 里的规范，有几条真的有自动化关卡撑腰？」——没有关卡的规范，迟早沦为一纸空文。**Helixent 的答案是：能自动化的（类型 / 规范 / 行为）全部自动化，一条命令搞定，两道关卡强制。**

### 亮点 2：co-located 测试 + 「命名驱动发现」（妙笔）

测试住在被测代码隔壁（`__tests__/<name>.test.ts`），而非集中到远方的 `tests/` 树。这让「模块 + 测试」成为一个可一起移动、一起 review、一起删除的内聚单元。**而这套自由布局能成立，全靠 Bun「认文件名后缀、不认目录结构」的发现机制**——工具的灵活性，反过来赋能了组织的合理性。

### 亮点 3：错误断言按 `code` 而非 `message`（关键决策）

`toMatchObject({ ok: false, code: "INVALID_RANGE" })`——测试锁的是**稳定的机器码**，不锁易变的人类文案。这是 [第 4 节](./04-tool.md) 结构化结果契约 `{ ok, code, ... }` 在测试层兑现的最大红利：**文案随便改，测试永不碎**。一个小小的断言选择，背后是「机器标识与人类展示分离」的深刻设计哲学。

### 亮点 4：把「依赖外部服务的逻辑」切成「纯数据变换」（妙笔）

`StreamAccumulator` 只接受「一串 chunk 对象」、只输出 snapshot，不碰网络。于是测试能**手工造 chunk、离线毫秒级验证**所有边界（残缺 JSON、并行 tool call……）。**「可测性是设计的镜子」——好测，正因为它被切成了无副作用的纯逻辑**。这条经验可迁移到任何「依赖外部 I/O 的组件」：把「拿数据」和「处理数据」切开，后者就能纯逻辑单测。

### 亮点 5：`prepublishOnly` / `--frozen-lockfile` —— 把「易忘的必要步骤」自动化（关键决策）

发布前必须重新 build？交给 `prepublishOnly` 自动做。CI 依赖必须和本地一致？用 `--frozen-lockfile` 强制。**这两处都是同一种思路：不指望人记得，而是让机制替人记得**。这跟 pre-commit 钩子是一脉相承的工程价值观——**「靠机制，不靠自觉」贯穿了从提交到发布的每一环**。

### 亮点 6：ESLint / Prettier 划清界限（妙笔）

`eslint-config-prettier` 关掉所有和 Prettier 冲突的格式规则，实现「Prettier 管长相、ESLint 管对错」的清晰分工。**这避免了 TS 项目最常见的一个内耗——两个工具互相打架**。看似一行配置，实则是「让每个工具只做它最擅长的事」的边界智慧。

***

## 3. 工业对比

把 Helixent 的工程实践放到业界坐标系里，能看清它的取舍。

### 3.1 测试运行器：`bun:test` vs Jest / Vitest / Node test runner

| 维度 | `bun:test`（Helixent 选择） | Jest | Vitest | `node:test` |
|---|---|---|---|---|
| 配置 | **零配置**，运行时内置 | 需 `jest.config` + `ts-jest`/`babel` | 需 `vitest.config` | 零配置但功能少 |
| TS 支持 | **原生** | 需 transformer | 原生（靠 esbuild） | 需 `--loader` |
| 速度 | **极快**（原生实现） | 慢（尤其大项目） | 快 | 中 |
| API 风格 | Jest 兼容 | Jest 原生 | Jest 兼容 | 自成一派 |
| 额外依赖 | **0** | 一堆 | 几个 | 0 |

**Helixent 的取舍**：选 `bun:test` = 选「零配置 + 零依赖 + 原生速度」。**代价**是绑定 Bun 运行时（换 Node 就得换测试框架）。但对一个「本来就 all-in Bun」的项目，这个绑定不是成本而是红利——**运行时和测试框架同源，永远不会有版本 / transformer 兼容问题**。相比之下，Node 项目用 Jest 常年要维护 `ts-jest` 的配置和升级痛点。

### 3.2 单文件分发：`bun --compile` vs Node `pkg`/`nexe`/SEA vs Deno `compile`

- **Node 生态**：官方长期没有「编译单文件」能力。社区方案 `pkg`（已归档）、`nexe` 各有坑；Node 20+ 的 SEA（Single Executable Applications）仍是实验性、体验粗糙。
- **Deno**：`deno compile` 能力成熟，和 Bun 旗鼓相当。
- **Bun（Helixent 选择）**：`bun build --compile` 一个 flag 搞定，产物是自包含原生二进制。

**Helixent 的取舍**：在「单文件分发」这个需求上，Bun 和 Deno 都远胜 Node。Helixent 选 Bun 而非 Deno，主要因为 **npm 生态兼容性**（重度依赖 `openai`/`ink`/`react`）和 **「Claude Code 同款」的背书**——见 1.14。

### 3.3 质量关卡：pre-commit 钩子直跑 vs Husky + lint-staged

- **业界主流**：很多 JS 项目用 **Husky**（管理 git 钩子）+ **lint-staged**（只检查暂存的文件，加速）。
- **Helixent**：一个朴素的 shell 脚本直接跑 `bun run check`（全量检查），用 `git config core.hooksPath` 安装（无需 Husky 这个依赖）。

**Helixent 的取舍**：**用「原生 git 钩子 + 全量检查」换掉「Husky + lint-staged 的增量检查」**。优点是**零额外依赖、逻辑极简**（就一句 `bun run check`）、且「本地跑的和 CI 完全一致」；代价是**全量检查比增量慢**。但因为 `bun test` 本身快到 1 秒、`tsc`/`eslint` 也就几秒，全量的代价可以接受——**这个取舍只有在「测试足够快」的前提下才成立，又一次印证了 1.2「快」的战略价值**。（当然，1.11 那处「钩子没真正装上」的偏差，说明这套极简方案在「确保被正确安装」上还差一口气——这正是 Husky 那类工具存在的理由：它们把「安装」也自动化了。）

### 3.4 「不追求 100% 覆盖率」：Helixent vs 覆盖率教条主义

很多团队把「测试覆盖率 ≥ 80%」写进 CI 红线。**Helixent 明确反对这种教条**（[AGENTS.md](../../AGENTS.md)：「Not everything」需要测），只测「纯逻辑 / 非平凡算法 / 契约边界 / 回归」，放过「薄胶水 / 展示层 / 编排」。

**Helixent 的取舍**：**用「判断力」替代「覆盖率数字」**。这与 Google / Kent Beck 等的现代测试观一致——覆盖率是「有没有测到」的粗略代理，但高覆盖率不等于高质量（可以写一堆断言无意义的测试刷满覆盖率）。**Helixent 赌的是「团队有判断力去测该测的」，而非「用数字逼所有人测所有东西」**。这对开源小团队是对的；对大型组织，覆盖率红线有时是「防止摆烂」的无奈之举——**取舍取决于团队信任度**。

***

## 4. 深度解释：为什么这样设计？不这样会怎样？

### 4.1 为什么把「类型 / 规范 / 行为」三个检查合并成一条 `check`，而不是让 CI 分三步跑？

**这样做**：`check = tsc && eslint && bun test` 是**单一事实来源**。本地、pre-commit、CI 全都只调这一条命令。

**不这样会怎样**：假设 CI 里把三个检查写成三个独立 step，本地钩子又单独维护一套——**三处的检查内容迟早会漂移**。比如有人给 CI 加了个新 lint 规则，忘了同步到本地钩子，于是「本地过了、CI 挂了」，开发者一头雾水。**合并成一条命令，从根本上消灭了『多处检查不一致』这个 bug 类别**。这是「DRY 用在正确地方」的范例——**这里该 DRY 的是「检查的定义」，它是一份稳定的知识，就该只有一处**（对比 [第 20 节](./20-tui-input-command-render.md) Q4 那个「两个渲染器不该 DRY」的反例：那里重复的是「表现」，会朝不同方向演化，所以不该合并）。**同一个 DRY 原则，用在「知识」上（合并 check）对、用在「表现」上（合并渲染器）错——关键是分清什么是「知识」什么是「表现」。**

### 4.2 为什么测试要「co-located」而不是集中到顶层 `tests/`？集中式不是更清爽吗？

**这样做**（co-located）：测试贴着源码，改一个模块时测试就在隔壁。

**不这样会怎样**（集中式 `tests/`）：会得到**两棵平行的目录树**（`src/coding/tools/read-file.ts` ↔ `tests/coding/tools/read-file.test.ts`）。改一个文件要在两棵树间来回跳；重构挪动文件时，测试常被忘在原地变成「孤儿」；新人想知道「这个模块有没有测试」得去另一棵树里翻。**集中式的『清爽』是给『旁观者』的错觉，co-located 的『就近』才是给『改代码的人』的真便利**。

**但集中式也有它对的场景**：[AGENTS.md](../../AGENTS.md) 第 120 行说得很平衡——「顶层 `tests/` 适合集成测试、大型 fixture、或任何你想和 `src/` 物理隔离的东西」。**单元测试跟着代码走（co-located）、集成测试可以独立成树——这不是二选一，而是各按其用**。Helixent 目前全是单元测试，所以全部 co-located。

### 4.3 为什么 `agent.ts` 主循环没有单元测试？这不是最核心的代码吗？越核心越该测才对？

**这是本节最反直觉、也最能体现工程判断力的一处**。`agent.ts`（[第 5/6 节](./05-react-loop.md)）确实是全项目的心脏，但它**恰恰是最不该硬写单元测试的地方**。原因：

- **它的职责是「编排」，不是「计算」**。`stream`/`_think`/`_act` 本身几乎没有独立逻辑——它们只是「调模型 → 拿工具调用 → 并发执行 → 喂回」的胶水。**真正的逻辑都在被它编排的零件里**（模型、工具、中间件、累积器），而这些零件**已经被单独测过了**（1.3–1.6）。
- **给它写单元测试的成本极高、收益极低**：要测 `_act` 的并发调度，你得 mock 一个假模型（吐假的 tool_use）、mock 一堆假工具（有的快有的慢有的抛错）、mock 中间件……**搭这套 mock 脚手架的代码量可能比 `agent.ts` 本身还多，而且极其脆弱**——`agent.ts` 内部实现稍变，一堆 mock 就得跟着改。这种测试「测的是 mock，不是真实行为」。
- **它更适合『集成测试 / 手动验证 / 类型兜底』**：`agent.ts` 是否正确，最好的验证是「真的跑一遍 `bun run dev`，看 Agent 会不会读文件、改代码」——这是**集成层面**的事。而 `tsc` 的类型检查也兜住了一大批「接错了参数」的低级错误。

**不这样会怎样**（硬给 `agent.ts` 写单测）：你会得到一堆「又长又脆、测的是 mock 而非真实、每次重构都要大改」的测试——**它们非但不保护代码，反而成了重构的枷锁**（改一点实现就一片红，让人不敢动）。**这正是「为覆盖率而测试」的典型恶果**。Helixent 不写它，是清醒，不是偷懒（回扣 1.8 的核心论点）。

### 4.4 为什么本地要 pre-commit 钩子？CI 不是已经拦了吗？多此一举？

**这样做**（本地 + 远端双保险）：本地钩子在提交前几秒就反馈，CI 在进主干前强制兜底。

**不这样会怎样**（只留 CI）：

- **反馈延迟**：你 commit、push，然后干别的去了；几分钟后 CI 红了，回来一看是个 `eslint` 顺序错——一个本可以在提交前 3 秒发现的问题，绕了一大圈。
- **脏历史**：那个「类型错误」的 commit 已经永久留在 git 历史里了（除非 rebase）。
- **CI 资源浪费**：每次小错都要占用一次完整的 CI run（拉环境、装依赖、跑全套）。

**只留本地钩子会怎样**：钩子是「可选安装 + 可 `--no-verify` 绕过」的，**不可靠**——总有人没装或绕过。

**所以「双保险」的本质是『快反馈』和『强底线』的分工**：本地图快（拦下 90% 的问题、秒级反馈），CI 图稳（剩下 10% 和「绕过钩子」的情况，进主干前必过）。**任何一个单独用都有明显短板，合起来才严丝合缝**。（讽刺的是，本节 1.11 发现本地钩子当前没真正装上——这恰好演示了「只留一道关卡」的风险：如果没有 CI 兜底，这个疏漏可能已经放进去一堆不合规的提交了。**CI 这道「强底线」，此刻正在替「失效的本地关卡」默默兜底**。）

### 4.5 为什么选 Bun 值得单独论证？技术选型不就是「用团队熟的」吗？

**这样做**（认真论证选型）：1.14 把「为什么 Bun」拆成了五条具体理由，每条都对应一个真实工程需求。

**不这样会怎样**（凭感觉选）：很多项目的运行时选型是「历史惯性」或「个人偏好」，说不出所以然。等到踩坑时（比如「想分发单文件却发现 Node 做不到」「想跑测试却要配半天 jest」），才发现选型和需求错配，积重难返。

**Helixent 的选型之所以值得学，是它『需求驱动』而非『偏好驱动』**：先明确「这是一个要分发的、异步密集的、重度用 npm 生态的 Coding Agent CLI」，再逐条核对哪个运行时命中了这些需求。**结论是 Bun 恰好五条全中**——这不是运气，是「先想清楚要什么，再选工具」的必然。**这条方法论比「选 Bun」这个结论本身更值钱**：你的项目需求不同，最优解可能是 Node 或 Deno，但「需求驱动选型」的思路是通用的。

***

## 5. 参考资料

**本节精讲 / 涉及的仓库文件（建议对照阅读）**：

- **测试（34 个 co-located 文件的代表）**：
  - [read-file.test.ts](../../src/coding/tools/__tests__/read-file.test.ts)——三段式（happy / error by code / boundary）+ `mkdtemp` 清理的教科书范例
  - [approval-manager.test.ts](../../src/coding/permissions/__tests__/approval-manager.test.ts)——异步 Manager 的「订阅 + 队列 + 单活跃」测试
  - [stream-utils.test.ts (openai)](../../src/community/openai/__tests__/stream-utils.test.ts)——喂假 chunk 验证流式拼装
  - [bash.test.ts](../../src/coding/tools/__tests__/bash.test.ts)——`test.skipIf` 环境相关跳过
  - [input-editor.test.ts](../../src/cli/tui/__tests__/input-editor.test.ts)——纯函数的密集边界测试
  - [tools.test.ts](../../src/foundation/__tests__/tools.test.ts)——`defineTool` 与结构化结果的类型契约测试
- **代码规范三件套**：
  - [tsconfig.json](../../tsconfig.json)（`strict` / `noUncheckedIndexedAccess` / `verbatimModuleSyntax` / `paths`）
  - [eslint.config.js](../../eslint.config.js)（`consistent-type-imports` / `no-floating-promises` / `import-x/order` / `no-console`）
  - [.prettierrc](../../.prettierrc)（`printWidth: 120` / 双引号 / 分号 / 尾逗号）
  - [.markdownlint.json](../../.markdownlint.json)（文档 lint）
  - [code-convention.md](../code-convention.md)（100 行「法典」，本节反复回扣）
- **质量关卡**：
  - [package.json](../../package.json)（`check` / `check:types` / `build:*` / `release:*` / `prepublishOnly` / `hooks:install`）
  - [pre-commit](../../pre-commit)（本地钩子脚本，当前在根目录——见 1.11 的诚实标注）
  - [.github/workflows/check.yml](../../.github/workflows/check.yml)（CI，`--frozen-lockfile` + `bun run check`）
- **构建 / 运行时**：
  - [index.ts](../../index.ts)（`import "./src/cli"` 入口）、[src/index.ts](../../src/index.ts)（库的公开 API 面）
  - [bun.md](../bun.md)（「Default to using Bun」的项目铁律）
  - [.gitignore](../../.gitignore)（`dist` / `*.log` 等产物忽略）、[bun.lock](../../bun.lock)（锁定依赖）
- **项目说明**：[README](../../README.md)（「Why Bun?」「Develop & Build」「How to Contribute」）、[AGENTS.md](../../AGENTS.md)（「Testing」「Quality gate」两节）

**上游依赖章节（本节回扣了它们的哪条设计）**：

- [第 1 节 · 项目全景与四层架构](./01-overview.md)：本节所有关卡守的都是它立下的规矩（分层单向依赖、命名、casing、无默认导出）——**本节是它的「执行层」**
- [第 4 节 · Tool 工具系统](./04-tool.md)：结构化结果 `{ ok, code, ... }` 契约 → 1.3「按 code 断言」的红利来源
- [第 5/6 节 · ReAct 主循环 / 并行调度](./05-react-loop.md)：4.3「为什么 `agent.ts` 不单测」的对象；`no-floating-promises` 守的异步纪律
- [第 8 节 · 工具结果处理管线](./08-tool-result-pipeline.md)：`tool-result-*` 是「非平凡算法值得测」的典型（agent 层 41 个用例的主力）
- [第 12 节 · 工具地基与文件读写](./12-tool-foundation-file-io.md)：1.4 `mkdtemp` 清理 + `Bun.file` vs `node:fs` 豁免的来源
- [第 15 节 · Human-in-the-Loop](./15-human-in-the-loop.md)：1.5 Manager 测试验证的「队列 + 单活跃 + 订阅」正是它的设计
- [第 16/17 节 · OpenAI / Anthropic Provider](./16-openai-provider.md)：1.6 `StreamAccumulator` 测试 + `temperature: 0` 确定性的来源
- [第 18 节 · CLI 入口与持久化](./18-cli-config-persistence.md)：`schema` / `settings-loader` 测试（配置校验）的对象；`index.ts` 入口
- [第 20 节 · TUI 输入与渲染](./20-tui-input-command-render.md)：本节的「直接上游」，它点名把「工程实践」留给本节；Q4 的「DRY 边界」被 4.1 再次引用

**外部资料**：

- Bun 测试运行器（`bun:test`、`describe`/`test`/`expect`、发现规则）：<https://bun.sh/docs/cli/test>
- Bun 单文件编译（`bun build --compile`）：<https://bun.sh/docs/bundler/executables>
- Bun 打包器（`bun build`、`--splitting`、`--target`）：<https://bun.sh/docs/bundler>
- TypeScript `tsconfig` 严格选项（`strict`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`）：<https://www.typescriptlang.org/tsconfig>
- ESLint flat config：<https://eslint.org/docs/latest/use/configure/configuration-files>
- typescript-eslint（`no-floating-promises`、`consistent-type-imports`）：<https://typescript-eslint.io/rules/>
- `eslint-config-prettier`（关掉冲突的格式规则）：<https://github.com/prettier/eslint-config-prettier>
- Prettier：<https://prettier.io/>
- Git 钩子与 `core.hooksPath`：<https://git-scm.com/docs/githooks>
- GitHub Actions（`on: push/pull_request`、`setup-bun`）：<https://docs.github.com/actions>
- npm `prepublishOnly` 生命周期脚本：<https://docs.npmjs.com/cli/using-npm/scripts>
- npm `files` 字段（控制打包内容）：<https://docs.npmjs.com/cli/configuring-npm/package-json#files>
- 「测试覆盖率不是目标」（现代测试观，呼应 1.8 / 3.4）：<https://martinfowler.com/bliki/TestCoverage.html>

***

## 6. 小结与全书回望

本节我们跳出「读业务代码」，站在「作品」视角，拆开了包裹在 Helixent 业务内核之外的那层**工程外壳**——**测试、代码规范、质量关卡、构建与发布**，核心是**一条贯穿始终的主线：把前 20 节立下的所有『规矩』，收敛成一条『绕不过去的关卡』**：

- **测试（行为正确，1.2–1.8）**：**co-located + `bun:test` + 命名驱动发现**的哲学；**三段式（happy / error by code / boundary）**、**`mkdtemp` 用完即焚**、**异步 Manager 的订阅测试**、**喂假 chunk 的流式测试**、**`skipIf` 优雅跳过**五类范式；以及最重要的价值观——**「可测性是设计质量的镜子」**，逻辑往下沉成纯函数就好测、往上做编排 / 呈现就该用别的手段兜底。223 个用例 959ms 跑完，快到能塞进每次提交。
- **代码规范（类型 + 规范正确，1.9）**：**TypeScript / ESLint / Prettier 三件套各管一段**——`tsc` 管类型（`strict` 全家桶）、`eslint` 管规范和依赖方向（`import-x/order`、`no-floating-promises`）、`prettier` 管长相，`eslint-config-prettier` 让两者划清界限、互不打架。它们把 [code-convention.md](../code-convention.md) 那 100 行「人读的规矩」翻译成了「机器执行的关卡」。
- **质量关卡（把规矩变强制，1.10–1.11）**：三项检查合并成 **`bun run check`** 一条命令（单一事实来源），再用 **pre-commit 钩子（本地图快）+ GitHub Actions（远端图稳）双保险**焊死。本节还如实标注了一处「文档说钩子在 `.githooks/`、实际却在根目录且未激活」的偏差——**这本身就是「文档 / 脚本 / 真实状态一致性」这个工程维度的一堂课**。
- **构建与发布（送到用户手里，1.12–1.14）**：`bun build --compile` 产出**单文件二进制**（给 CLI 用户）、`build:js` 产出**库模块**（给 `import` 用户），`prepublishOnly` + `release:*` 把「升版本 → 打 tag → 重编译 → 发布」收敛成一键；最后论证了**为什么是 Bun**——异步母语、Claude Code 同款、性能、单文件分发、自带电池，五条需求全中。

**一条主线**：**「靠机制，不靠自觉」**。从 `check` 关卡、pre-commit 钩子、CI 兜底，到 `prepublishOnly` 的发布前 build、`--frozen-lockfile` 的依赖锁定——**Helixent 反复在做同一件事：把『必要但容易忘 / 容易偷懒』的步骤，变成『自动、强制、绕不过去』的机制**。这份工程纪律，正是让一个「代码量小」的项目能同时做到「质量高、可信任、可分发」的根本原因。

***

**全书回望**：还记得 [第 1 节](./01-overview.md) 那句承诺吗——「读完本节，建议回到第 1 节重读全景图，你会有全新的理解」。现在正是时候。

我们从 [第 2 节·Message](./02-message.md) 那份「贯穿始终的单一数据源」出发，一层层往上垒：[第 3 节·Model](./03-model.md) 让它能被模型生产、[第 4 节·Tool](./04-tool.md) 给它配上工具、[第 5–10 节] 把这些零件串成一个会「思考 → 行动 → 观察」并可被中间件扩展的**通用 Agent 大脑**、[第 11–15 节] 把大脑特化成会读写代码、会打补丁、会请人类审批的**Coding Agent**、[第 16–17 节] 接上 OpenAI / Anthropic 两家**真实模型厂商**、[第 18–20 节] 把它交到用户手里、变成一个能配置、能对话、能审批、能好看地渲染的**终端程序**。

**而本节（第 21 节），是给这座架构盖上的「质量封顶」**——它回答的不是「Helixent 由什么组成」，而是「凭什么相信 Helixent 的每一层都靠得住、能被分发出去给人用」。**回看 [第 1 节](./01-overview.md) 那张四层架构图和它旁边的 code-convention，你现在应该能看出一层新的含义**：那张图上的每一条边（严格单向依赖）、每一个命名约定、每一处 casing 分界，**都不只是「作者的品味」，而是背后有 `tsc` + `eslint` + `bun test` 三道检查、pre-commit + CI 两道关卡在默默守护的『可执行的承诺』**。第 1 节你看到的是「规矩」，读完第 21 节你才看到「规矩是怎么被守住的」——**这就是那句「回到起点会有全新理解」的含义：起点的『地图』，在终点被赋予了『为什么可信』的答案**。

至此，从「一份 `Message` 数据结构」到「一个能分发给全世界的 `helixent` 命令」，中间经过的每一层设计、每一个数据结构、每一次转换、以及**每一道守护质量的关卡**，你都能说出它在哪一节、为什么那样设计。**这，就是这套「源码精读」教程想带你抵达的终点——不仅看懂了每一行关键代码，更理解了『一个现代 Coding Agent 由哪些零件组成、为什么这样组装、又凭什么值得信任』。**

🎉 **全书完。** 感谢你一路读到这里。现在，去打开 `src/`，用你新获得的这双「能看懂设计意图」的眼睛，把这个项目再「读」一遍吧——你会发现，它比第一次打开时，清晰了太多。
