# 第 15 节：Human-in-the-Loop —— 审批与提问共享的「队列 + 单活跃 + 订阅」模式

> 本节属于 **第四部分 · Coding 层（面向编程的专用 Agent）**，是这一部分的**收官之作**。[第 12～14 节](./12-tool-foundation-file-io.md) 造出了一批能「改动真实世界」的危险工具——`write_file` 整写、`str_replace` 局部替换、`bash` 跑任意命令、`apply_patch` 外科手术式打补丁。它们让 Agent 从「只会说话」变成「能动手」。但「能动手」的另一面是「可能闯祸」：删错文件、跑错命令、把生产配置改坏。**在这些危险操作真正落地之前，如何插入一个「人类过目、点头才放行」的环节？** 这就是本节要补齐的最后一块拼图——**人机协作（Human-in-the-Loop）基础设施**。
>
> 对应 roadmap 为本节设定的**核心问题**：
>
> > 危险操作（跑命令、改文件）如何在执行前弹给人类确认？Agent 主动向人提问又是怎么实现的？两者为什么能共用一套基础设施？
>
> **一句边界声明**：本节精讲**两组、共七个小文件**，它们分属两个看似不同、实则同构的功能——
>
> - **审批（Approval）**：[requires-approval.ts](../../src/coding/permissions/requires-approval.ts)（9 行，「谁需要审批」的名单）、[approval-types.ts](../../src/coding/permissions/approval-types.ts)（1 行，三种决定）、[approval-persistence.ts](../../src/coding/permissions/approval-persistence.ts)（6 行，白名单读写**契约**）、[coding-approval-middleware.ts](../../src/coding/permissions/coding-approval-middleware.ts)（44 行，拦截逻辑）、[approval-manager.ts](../../src/coding/permissions/approval-manager.ts)（60 行，**共享内核**）。
> - **提问（Ask）**：[ask-user-question.ts](../../src/coding/tools/ask-user-question.ts)（126 行，一个「阻塞式工具」）、[ask-user-question-manager.ts](../../src/coding/tools/ask-user-question-manager.ts)（58 行，**共享内核的孪生**）。
>
> **本节最大的「啊哈时刻」**：审批和提问，一个是「拦下模型没主动要的危险操作」，一个是「模型主动发起的提问」——**接入方式截然相反**（审批是 [第 7 节](./07-middleware.md) 的**中间件 + `beforeToolUse` 短路**，提问是 [第 4 节](./04-tool.md) 的**一个普通工具**），**但两个 `Manager` 的代码几乎逐行同构**——它们共享同一套「**队列（queue）+ 单活跃请求（single active）+ 订阅（subscribe）**」模型，用来把「一个在 `await` 的异步 Promise」桥接到「一个一次只能弹一个框的（尚未登场的）React UI」。看懂这套共享内核「为什么长这样」，就理解了 Helixent 处理「一切需要等人类响应的异步交互」的统一手法。
>
> ⚠️ **两处「留到后面」的诚实标注**：（1）`approval-persistence` 在本节**只定义契约**（两个函数类型），真正「落盘到 `~/.helixent`」的实现留到 [第 18 节](./00-roadmap.md)；（2）两个 `Manager` 都在「等一个 UI 来 `subscribe` 并 `respond`」，那个 React UI（`use-approval-manager` Hook、`approval-prompt` 组件等）是 [第 19 节](./00-roadmap.md) 的主角。本节聚焦「**Agent 侧如何产生请求、如何桥接、如何排队**」，把「UI 侧如何消费」留到第六部分。

***

## 0. 承上启下

[第 14 节](./14-apply-patch.md) 在结尾把伏笔收得非常紧，几乎是「点名」本节。它的原话是这样的：

> 可你一定注意到了一个反复出现却始终没展开的词——**审批**。本节 Q2/Q6 反复提到「`bash rm` 会弹审批框」「`apply_patch` 在必审批名单里」「工具自校验保证『打得对』，审批保证『该不该打』」……**这些危险操作在真正执行前，到底是怎么被『拦下来、弹给人类过目』的？** 而且不只是「拦截确认」——Agent 有时还需要**主动向人提问**……**这两件事（审批拦截、主动提问）看起来不同，为什么能共用同一套基础设施？**

它还埋了一个更具体的预告：

> 你会在第 15 节看到，审批和提问这两个功能，为什么都要设计成「**单活跃请求 + 队列**」——因为终端 UI 一次只能弹一个框问一件事，而 Agent 可能同时（第 6 节的并行工具！）触发多个需要人类响应的请求。如何把「并发的请求」排成「一个接一个的弹窗」，正是那套共享基础设施要解决的核心问题。

本节就来兑现这两个悬念。而在动手前，请先把**四条上游结论**装进脑子——它们是本节每一处设计的直接前提：

1. **[第 14 节](./14-apply-patch.md) 的「两层安全模型」结论。** 第 14 节 Q6 已经点破了分层：**第一层·工具自校验**（`apply_patch` 逐行硬比对，保证「打得对」）；**第二层·人机审批**（保证「该不该打」）。本节就是把「第二层」从一句预告变成可运行的代码——它专治「模型技术上正确地做错事」。
2. **[第 7 节](./07-middleware.md) 的 `beforeToolUse` 与 `__skip` 短路协议。** 中间件的 `beforeToolUse` 钩子若返回 `{ __skip: true, result }`，Agent 会**跳过真正的工具执行**、直接把 `result` 当作工具结果（[agent.ts L227-L230](../../src/agent/agent.ts#L227-L230) / [L337-L349](../../src/agent/agent.ts#L337-L349)）。**审批的「拒绝」正是靠这个短路实现的**——这是本节与第 7 节最直接的接口。
3. **[第 6 节](./06-parallel-tools.md) 的并行工具调度。** 一步里模型可能同时调多个工具（`Promise.race` 循环并发执行）。若其中好几个都需要审批，就会**同时**冒出多个「等人类响应」的请求——但终端一次只能弹一个框。**「并发请求 → 串行弹窗」的矛盾，正是本节两个 `Manager` 要解决的核心问题**（也是它们必须有「队列」的根本原因）。
4. **[第 4 节](./04-tool.md) 的 `defineTool` 与 [第 5 节](./05-react-loop.md) 的 `AbortController`。** `ask_user_question` 是一个用 `defineTool` 定义的**普通工具**，它的 `invoke` 会 `await` 一个「等人类回答」的 Promise，并在前后两次检查 `signal.aborted`（呼应第 5 节贯穿式取消）。

准备好了。我们先不看任何一个具体文件，而是先建立「**两个功能、两套接入、一套内核**」的全局地图——因为本节最容易让人迷路的地方，恰恰是「文件多而碎」。有了地图，再逐个击破。

***

## 1. 主题内容

### 1.1 先建立地图：两个功能、两套接入、一套共享内核

本节七个文件，可以先按「三个层次」归位。**一张图看清它们的关系：**

```
                     ┌─────────────────────────────────────────────┐
                     │           Agent 主循环（第 5/6 节）           │
                     │   模型发出 tool_use → _act 并发执行工具        │
                     └───────────────┬───────────────┬─────────────┘
                                     │               │
         【接入方式 A：中间件拦截】    │               │  【接入方式 B：普通工具】
         审批——模型「没主动要」的     │               │  提问——模型「主动发起」的
         危险操作，被透明拦下          │               │  一次交互
                                     ▼               ▼
        ┌────────────────────────────────┐   ┌──────────────────────────────┐
        │ coding-approval-middleware.ts   │   │ ask-user-question.ts          │
        │  beforeToolUse 钩子（第 7 节）  │   │  defineTool 的一个工具（第4节）│
        │  · 查 requires-approval 名单    │   │  · Zod 校验参数               │
        │  · 查 approval-persistence 白名单│  │  · await callback(...)        │
        │  · await askUser(toolUse) ──────┼───┼──> · 阻塞等待人类回答          │
        │  · deny → __skip 短路           │   │  · 校验答案、返回 JSON        │
        └───────────────┬─────────────────┘   └───────────────┬──────────────┘
                        │ askUser 回调                          │ callback 回调
                        ▼                                       ▼
        ┌────────────────────────────────┐   ┌──────────────────────────────┐
        │      ApprovalManager            │   │    AskUserQuestionManager      │
        │  ┌──【共享内核·几乎逐行同构】──┐  │   │  ┌──────────────────────────┐ │
        │  │ _queue[]     排队           │  │   │  │ _queue[]                 │ │
        │  │ _currentRequest 单活跃      │  │   │  │ _currentRequest          │ │
        │  │ _subscriber  订阅（给 UI）  │  │   │  │ _subscriber              │ │
        │  │ askUser()→Promise（桥接）   │  │   │  │ askUserQuestion()→Promise│ │
        │  │ _processQueue() 取下一个     │  │   │  │ _processQueue()          │ │
        │  │ respond() 兑现 Promise      │  │   │  │ respondWithAnswers()     │ │
        │  └────────────────────────────┘  │   │  └──────────────────────────┘ │
        └───────────────┬─────────────────┘   └───────────────┬──────────────┘
                        │ subscribe / respond                   │ subscribe / respondWithAnswers
                        ▼                                       ▼
        ┌───────────────────────────────────────────────────────────────────┐
        │        （尚未登场的）React TUI —— 第 19 节                            │
        │  use-approval-manager / use-ask-user-question-manager Hook          │
        │  一次只渲染一个弹窗，用户点选后调 respond* 兑现上面的 Promise         │
        └───────────────────────────────────────────────────────────────────┘
```

**这张图有三个层次，从上到下读：**

- **接入层（最上，两条路各异）**：审批走**中间件**（[coding-approval-middleware.ts](../../src/coding/permissions/coding-approval-middleware.ts)），提问走**工具**（[ask-user-question.ts](../../src/coding/tools/ask-user-question.ts)）。它们和 Agent 主循环的接口完全不同——一个是「钩子」，一个是「工具」。**这是本节的第一个反直觉点：功能相似，接入却相反。**（1.4 和 1.6 分别细讲，Q1 专门解释「为什么这样分」。）
- **内核层（中间，两条路合流）**：两个 `Manager`（[approval-manager.ts](../../src/coding/permissions/approval-manager.ts) / [ask-user-question-manager.ts](../../src/coding/tools/ask-user-question-manager.ts)）**几乎逐行同构**——同样的 `_queue`/`_currentRequest`/`_subscriber` 三件套，同样的「入队→处理→兑现」流程。**这是本节的第二个反直觉点：接入相反，内核却几乎复制粘贴。**（1.5 精讲这套内核。）
- **消费层（最下，第 19 节）**：React UI 通过 `subscribe` 拿到「当前该弹的框」，渲染出来，用户点选后调 `respond*` 把结果送回。本节只到「Manager 暴露 subscribe/respond」为止，UI 实现留给第 19 节。

**还有三个「配角」小文件**属于审批一侧的「契约与配置」，1.3 一次性讲完：[requires-approval.ts](../../src/coding/permissions/requires-approval.ts)（哪些工具要审批）、[approval-types.ts](../../src/coding/permissions/approval-types.ts)（人类能做哪三种决定）、[approval-persistence.ts](../../src/coding/permissions/approval-persistence.ts)（白名单怎么存的**契约**，实现留到第 18 节）。

**本节的讲解顺序**：先讲「桥接」这个最核心的思想（1.2），再走「审批」这条完整链路（1.3 契约 → 1.4 中间件 → 1.5 Manager 内核），然后走「提问」这条链路（1.6 工具 → 1.7 Manager 孪生），最后看装配与全景（1.8）。**因为两个 Manager 同构，1.5 把内核讲透后，1.7 就能「一图对照」快速带过。**

### 1.2 关键思想：用「捕获 resolve」把异步 Promise 桥接到「未来某刻的人类响应」

在读任何一个 Manager 之前，必须先想清楚一件事——这是理解本节的**总钥匙**：

> **问题**：中间件里写的是 `const decision = await options.askUser(toolUse)`，工具里写的是 `const result = await callback(params)`。这两个 `await` 要**一直挂起**，直到**人类在终端上点了某个按钮**才继续。可是「人类点按钮」这件事，发生在**遥远的未来**、在**完全不同的调用栈**里（React 的事件回调）。**一个 `await` 怎么能等一个「未来某刻、别处发生」的事件？**

答案是 JavaScript 里一个经典而优雅的模式——**「捕获（defer）`resolve`」**。看 `ApprovalManager.askUser` 的实现（[approval-manager.ts L19-L29](../../src/coding/permissions/approval-manager.ts#L19-L29)）：

```ts
askUser = (toolUse: ToolUseContent): Promise<ApprovalDecision> => {
  return new Promise((resolve) => {
    if (this._queue.length >= MAX_QUEUE_SIZE) {
      console.warn(`[ApprovalManager] Queue overflow. Denying tool ${toolUse.name}.`);
      resolve("deny");
      return;
    }
    this._queue.push({ toolUse, resolve });   // ← 关键：把 resolve 存进队列，而不是立刻调用
    this._processQueue();
  });
};
```

**逐句品这个「魔法」：**

1. `new Promise((resolve) => {...})` 创建一个 Promise 并立即返回给调用方（中间件），于是中间件的 `await options.askUser(...)` 开始**挂起**。
2. **但 `resolve` 并没有在这里被调用**——它被 `this._queue.push({ toolUse, resolve })` **存进了队列**。这就是所谓「捕获 resolve」：把「让那个 await 继续下去的开关」保存起来，留待将来。
3. 将来某一刻，UI 拿到这个请求、用户点了「允许」，会调用 `manager.respond("allow_once")`——`respond` 内部（[L43-L48](../../src/coding/permissions/approval-manager.ts#L43-L48)）会取出之前存的 `resolve` 并调用 `this._currentRequest.resolve(decision)`。**这一刻，那个挂起已久的 `await` 才终于拿到值、继续执行。**

**这就是「桥接异步 Promise 与人类响应」的全部秘密**——把 `resolve` 当成一个「存起来的开关」，在人类响应的那一刻按下它。roadmap 里说的「把异步 Promise 桥接到 React UI」，本质就是这个「捕获 resolve → 稍后 resolve」的 deferred 模式。

> 💡 **为什么这个模式如此关键？** 因为它让「等人类」这件本质上**事件驱动、跨调用栈**的事，在中间件/工具里表现为一句朴素的 `await`——上层代码完全感受不到「跨栈、跨时间」的复杂性，它只是在「等一个 Promise」。**复杂性被封装进了 Manager**：Manager 负责保管 `resolve`、排队、在正确的时机兑现。这是「用一个中心化的协调者，把混乱的异步交互收拢成整齐的 Promise」的典范。

理解了这把总钥匙，两个 Manager 的其余部分（队列、单活跃、订阅）都只是围绕它的「调度逻辑」。我们先把审批这条链路走完，再回头精讲这套调度。

### 1.3 审批的三个「契约」小文件：名单、决定、持久化

审批一侧有三个极小但职责清晰的文件，先一次性看完——它们是后面中间件（1.4）和 Manager（1.5）的「配置与契约」。

**① [requires-approval.ts](../../src/coding/permissions/requires-approval.ts)（9 行）——「谁需要审批」的名单：**

```ts
/** Tool names that require interactive approval (unless allowed in project settings). */
export const CODING_TOOLS_REQUIRING_APPROVAL: string[] = [
  "bash",
  "write_file",
  "str_replace",
  "apply_patch",
  "mkdir",
  "move_path",
];
```

**这就是一份「危险工具清单」。** 注意它列的**全是「会改动世界」的工具**（[第 12～14 节](./12-tool-foundation-file-io.md) 讲的那些）——跑命令、写文件、替换、打补丁、建目录、移动路径。而**只读工具**（`read_file`/`glob_search`/`grep_search`/`list_files`/`file_info`）**不在名单里**——它们不改动任何东西，没必要打扰人类。**「读操作免审批、写操作必审批」是这份名单的隐含判据**，干净利落。它在 [第 11 节](./11-lead-agent.md) 被 `createCodingAgent` 传给中间件（1.8 详解装配）。

**② [approval-types.ts](../../src/coding/permissions/approval-types.ts)（1 行）——人类能做的三种「决定」：**

```ts
export type ApprovalDecision = "deny" | "allow_once" | "allow_always_project";
```

**这三个字面量值，是人机审批的「词汇表」，一个不多一个不少：**

| 决定 | 含义 | 后果 |
| --- | --- | --- |
| `"deny"` | 拒绝这次执行 | 工具被短路跳过，返回一句「用户拒绝了」给模型（1.4） |
| `"allow_once"` | 只允许这一次 | 本次放行，但下次同样的工具还会再问 |
| `"allow_always_project"` | 本项目内永远允许 | 本次放行，且**持久化**进白名单，此后本项目内该工具免审批（1.4 的 persist） |

**`allow_always_project` 是「记住我的选择」的 UX 落地**——它把「每次都问」降级成「问一次，此后放行」，是长时间使用时避免「审批疲劳」的关键。而它的「记住」需要一个地方存——这就引出第三个文件。

**③ [approval-persistence.ts](../../src/coding/permissions/approval-persistence.ts)（6 行）——白名单读写的「契约」，而非实现：**

```ts
export type ApprovalPersistence = {
  // eslint-disable-next-line no-unused-vars
  loadAllowList: (cwd: string) => Promise<Set<string>>;
  // eslint-disable-next-line no-unused-vars
  persistAllowedTool: (cwd: string, toolName: string) => Promise<void>;
};
```

**注意：这个文件里没有任何「怎么存」的代码——它只定义了两个函数的形状（type）。** 一个「读」（给定项目目录 `cwd`，返回「已被永久允许的工具名集合」），一个「写」（给定 `cwd` 和工具名，把它记进白名单）。**这是典型的「定义契约、延迟实现」**——`coding` 层只关心「有这么两个能力」，至于它们是写文件、写数据库、还是写注册表，`coding` 层**一概不管**。

**为什么这么设计？** 因为 `coding` 层**不应该知道**「配置文件在哪、什么格式」——那是 CLI 层的知识（呼应 [第 1 节](./01-overview.md) 的分层：`coding` 不依赖 `cli`）。真正的落盘实现（读写 `~/.helixent` 下的 YAML）是 [第 18 节](./00-roadmap.md) 的 `SettingsLoader`/`SettingsWriter` + `appendToolToAllowList`。在 [cli/index.tsx L79-L82](../../src/cli/index.tsx#L79-L82) 里，CLI 把这两个实现「注入」给 `coding`：

```ts
approvalPersistence: {
  loadAllowList: (cwd) => settingsLoader.loadAllowList(cwd),
  persistAllowedTool: (cwd, toolName) => settingsWriter.appendAllowedTool(cwd, toolName),
},
```

**这正是「依赖倒置」**：高层的 `coding` 定义契约（接口），低层的 `cli` 提供实现，运行时注入。`coding` 依赖的是**抽象**（`ApprovalPersistence` 类型），而非**具体**（`SettingsWriter`）。**这让 `coding` 层可测试**（测试里塞个 `async () => new Set(["bash"])` 就行，见 [coding-approval-middleware.test.ts L60-L64](../../src/coding/permissions/__tests__/coding-approval-middleware.test.ts#L60-L64)）、**可复用**（换个宿主环境，换个持久化实现即可）。

> 📌 **小结这三个契约文件**：`requires-approval` 定义「**谁**要审批」、`approval-types` 定义「人类能给**什么**答复」、`approval-persistence` 定义「答复怎么**记住**（契约层）」。三者都极小、都无副作用、都是纯粹的「配置 / 类型 / 接口」——**把「策略」和「机制」彻底分离**，机制（下一节的中间件和 Manager）才能保持通用。

### 1.4 `createCodingApprovalMiddleware` —— 用 `beforeToolUse` 短路把危险操作拦下

现在看审批的「拦截逻辑」——[coding-approval-middleware.ts](../../src/coding/permissions/coding-approval-middleware.ts)（44 行）。它是一个**工厂函数**，返回一个 [第 7 节](./07-middleware.md) 定义的 `AgentMiddleware`，只实现了一个钩子：`beforeToolUse`。**这是审批与 Agent 核心的唯一接口**：

```ts
export function createCodingApprovalMiddleware(options: {
  cwd: string;
  requiresApproval: string[];
  approvalPersistence?: ApprovalPersistence;
  askUser: (toolUse: ToolUseContent) => Promise<ApprovalDecision>;   // ← 关键回调，1.5 由 Manager 提供
}): AgentMiddleware {
  const loadAllowList = options.approvalPersistence?.loadAllowList ?? emptyAllowList;
  const persistAllowedTool = options.approvalPersistence?.persistAllowedTool;

  return {
    beforeToolUse: async ({ toolUse }) => {
      // ①「不在名单」→ 放行（返回 undefined = 无操作）
      if (!options.requiresApproval.includes(toolUse.name)) {
        return;
      }
      // ②「已在白名单」→ 放行
      const allowed = await loadAllowList(options.cwd);
      if (allowed.has(toolUse.name)) {
        return;
      }
      // ③ 否则，阻塞等人类决定
      const decision = await options.askUser(toolUse);
      // ④ 拒绝 → __skip 短路（第 7 节协议）
      if (decision === "deny") {
        return {
          __skip: true,
          result: `User denied execution of tool: ${toolUse.name}. You must either find an alternative approach or ask the user for clarification.`,
        };
      }
      // ⑤ 永久允许 → 持久化（失败不致命）
      if (decision === "allow_always_project" && persistAllowedTool) {
        try {
          await persistAllowedTool(options.cwd, toolUse.name);
        } catch (e) {
          console.warn(`[helixent] Could not persist allow for ${toolUse.name}:`, e);
        }
      }
      // （allow_once / allow_always_project 都走到这里 → 隐式 return undefined = 放行）
    },
  };
}
```

**这 30 行是审批的「决策树」，逐个分支看它如何呼应第 7 节的协议：**

**① 快速放行（不在名单）**：`if (!requiresApproval.includes(toolUse.name)) return`——`read_file` 之类的只读工具，名字不在 `CODING_TOOLS_REQUIRING_APPROVAL` 里，`beforeToolUse` 立刻返回 `undefined`。**第 7 节说过：返回空值 = 「无操作」，Agent 照常执行工具。** 这条分支保证「免审批工具」零开销通过。（测试 [L16-L29](../../src/coding/permissions/__tests__/coding-approval-middleware.test.ts#L16-L29) 验证了这点。）

**② 白名单放行**：`const allowed = await loadAllowList(cwd); if (allowed.has(toolUse.name)) return`——即使工具在「必审批名单」里，只要它曾被 `allow_always_project` 记进白名单，就直接放行。**注意 `loadAllowList` 兜底成 `emptyAllowList`**（[L7](../../src/coding/permissions/coding-approval-middleware.ts#L7) 的 `async () => new Set()`）——当宿主没提供 `approvalPersistence` 时（比如某些测试或无持久化环境），白名单恒为空，退化成「每次都问」。**这是「持久化是可选增强，不是必需」的优雅降级。**

**③ 阻塞等人类**：`const decision = await options.askUser(toolUse)`——**这一句就是 1.2 讲的「桥接」的调用点**。`askUser` 由 `ApprovalManager` 提供（1.5），这个 `await` 会一直挂起，直到人类在 UI 上点选。**中间件本身完全不知道「UI 长什么样、人类怎么点」**——它只是在等一个 Promise。这就是 1.2 说的「复杂性被封装进 Manager」。

**④ 拒绝 → `__skip` 短路**：`decision === "deny"` 时，返回 `{ __skip: true, result: "User denied..." }`。**这正是 [第 7 节](./07-middleware.md) 的短路协议**——回看 [agent.ts L227-L230](../../src/agent/agent.ts#L227-L230)：

```ts
const beforeResult = await this._beforeToolUse(toolUse);
if (beforeResult.skip) {
  return { index, toolUseId: toolUse.id, toolName: toolUse.name, result: beforeResult.result };
}
const result = await tool.invoke(toolUse.input, signal);   // ← 被跳过了！
```

**看到没？一旦 `beforeToolUse` 返回 `__skip`，`tool.invoke` 那行根本不执行**——危险操作被**彻底拦下、从未发生**。而 `result` 里那句 `"User denied execution of tool: bash. You must either find an alternative approach or ask the user for clarification."` 会作为「工具结果」回喂给模型。**这句话的措辞很讲究**：它不只是说「被拒了」，还**指导模型下一步**（「找替代方案，或向用户澄清」）——防止模型傻乎乎地把同一个被拒的调用又发一遍。（测试 [L75-L91](../../src/coding/permissions/__tests__/coding-approval-middleware.test.ts#L75-L91) 断言了 `__skip: true` 且 result 含这句话。）

**⑤ 永久允许 → 持久化（失败不致命）**：`decision === "allow_always_project"` 且宿主提供了 `persistAllowedTool` 时，调用它写白名单。**关键是那个 `try/catch`**——持久化失败（磁盘满、权限不足）**只 `console.warn`，绝不 throw**。为什么？因为**「记住选择」是锦上添花，失败了大不了「下次再问一遍」，绝不能因为「写配置失败」就让整个工具执行崩溃**。这是「非核心功能优雅降级」的又一处体现（测试 [L115-L135](../../src/coding/permissions/__tests__/coding-approval-middleware.test.ts#L115-L135) 专门验证「持久化抛错时中间件不抛」）。注意：**无论 `allow_once` 还是 `allow_always_project`，走完都隐式 `return undefined`**——即「放行」，Agent 照常 `tool.invoke`。

> 💡 **审批链路的「妙」在哪？** 它把「审批」这个横切关注点（cross-cutting concern）**完全塞进一个中间件**，Agent 核心（`agent.ts`）**一行都不用改**——`_beforeToolUse` 只认识「返回 `__skip` 就跳过」这个通用协议，根本不知道「审批」的存在。**换句话说，审批是「插」在插座（第 7 节中间件系统）上的一个「插件」，可插可拔。** 想关掉审批？`createCodingAgent` 时不传 `askUser` 即可（[lead-agent.ts L67-L76](../../src/coding/agents/lead-agent.ts#L67-L76)：`if (askUser) middlewares.push(...)`），中间件根本不会被装上。**这就是第 7 节「一切扩展的插座」在本节的兑现。**

### 1.5 `ApprovalManager` —— 共享内核精讲：队列 + 单活跃 + 订阅

中间件里那句 `await options.askUser(toolUse)` 的 `askUser`，就来自 [approval-manager.ts](../../src/coding/permissions/approval-manager.ts)（60 行）。**这是本节的绝对核心**——它就是 roadmap 标题里「队列 + 单活跃 + 订阅」那套模式的实现。我们逐块拆透，因为 1.7 的孪生 Manager 会直接对照它。

先看类的「状态三件套」（[L13-L17](../../src/coding/permissions/approval-manager.ts#L13-L17)）：

```ts
export type ApprovalRequest = {
  toolUse: ToolUseContent;
  resolve: (decision: ApprovalDecision) => void;   // ← 1.2 讲的「捕获的开关」
};

const MAX_QUEUE_SIZE = 20;

export class ApprovalManager {
  private _queue: ApprovalRequest[] = [];                        // ① 队列：排队等待的请求
  private _currentRequest?: ApprovalRequest;                     // ② 单活跃：当前正在问的那一个
  private _subscriber?: (req: ApprovalRequest | null) => void;   // ③ 订阅：通知 UI「该弹哪个框」
  // ...
}
```

**这三个字段就是「队列 + 单活跃 + 订阅」模式的骨架，各司其职：**

- **`_queue`（队列）**：一个数组，存放**所有还没处理的请求**。每个请求都打包了 `{ toolUse, resolve }`——即「要审批的工具」+「1.2 说的那个捕获的 resolve 开关」。
- **`_currentRequest`（单活跃）**：**至多一个**「当前正在等人类响应」的请求。它是「一次只弹一个框」的代码化身——只要它非空，就说明「有个框正开着，别再弹新的」。
- **`_subscriber`（订阅）**：一个回调函数，**由 UI 注册**（第 19 节的 Hook 会 `subscribe`）。Manager 通过调用它，告诉 UI「现在该显示这个请求了」（传 `ApprovalRequest`）或「没有请求了，收起弹窗」（传 `null`）。

**再看四个方法如何围绕这三个字段协作。核心是 `_processQueue`（[L31-L41](../../src/coding/permissions/approval-manager.ts#L31-L41)）——整套调度的心脏：**

```ts
private _processQueue() {
  if (this._currentRequest || this._queue.length === 0) {
    if (this._queue.length === 0 && !this._currentRequest) {
      this._subscriber?.(null);   // ← 队列空且无活跃 → 通知 UI「收起弹窗」
    }
    return;
  }
  this._currentRequest = this._queue.shift()!;   // ← 取队首成为「活跃请求」
  this._subscriber?.(this._currentRequest);       // ← 通知 UI「弹这个框」
}
```

**这 8 行浓缩了「单活跃」的全部逻辑，分三种情况：**

1. **已有活跃请求（`_currentRequest` 非空）**：`return`，什么都不做。**这就是「一次只弹一个」的守卫**——当前框还开着，新来的请求只能在 `_queue` 里等着。
2. **队列空且无活跃**：`_subscriber?.(null)`——通知 UI「没有待办了，把弹窗收起来」。这让 UI 能在所有请求处理完后回到「正常对话」状态。
3. **无活跃但队列有货**：`_currentRequest = _queue.shift()`（取出队首）+ `_subscriber?.(_currentRequest)`（通知 UI 弹这个框）。**「从队列取一个、提升为活跃、通知 UI」——这是「让下一个排队者上场」的动作。**

**然后是 `askUser`（1.2 已讲过，这里补「入队 + 溢出保护」）：**

```ts
askUser = (toolUse: ToolUseContent): Promise<ApprovalDecision> => {
  return new Promise((resolve) => {
    if (this._queue.length >= MAX_QUEUE_SIZE) {   // ← 溢出保护
      console.warn(`[ApprovalManager] Queue overflow. Denying tool ${toolUse.name}.`);
      resolve("deny");   // ← 队列爆了，直接拒绝（安全默认）
      return;
    }
    this._queue.push({ toolUse, resolve });   // ← 入队（捕获 resolve）
    this._processQueue();                      // ← 尝试处理
  });
};
```

**注意那个 `MAX_QUEUE_SIZE = 20` 的溢出保护**：如果队列已经堆了 20 个待审批请求（说明模型疯狂并发、或人类长时间没响应），新来的**直接 `resolve("deny")`**——不排队、直接拒。**「溢出即拒绝」是一个「安全优先」的默认**：与其让队列无限膨胀、内存爆掉、或让模型无限等待，不如果断拒绝这个操作（拒绝是安全的——大不了模型换个方案）。这是「fail-safe」（失败时倒向安全一侧）的设计。

**最后是 `respond`（[L43-L48](../../src/coding/permissions/approval-manager.ts#L43-L48)）——兑现 Promise、推进队列：**

```ts
respond = (decision: ApprovalDecision) => {
  if (!this._currentRequest) return;           // ← 没有活跃请求，忽略（防御性）
  this._currentRequest.resolve(decision);      // ← 1.2 的「按下开关」：那个 await 拿到值了！
  this._currentRequest = undefined;            // ← 清空活跃槽
  this._processQueue();                        // ← 让队列里下一个上场
};
```

**这就是 1.2「捕获 resolve」的收尾**：UI 拿到人类的点选后调 `respond(decision)`，它取出 `_currentRequest.resolve` 并调用——**那个在中间件里挂起已久的 `await options.askUser(...)` 此刻终于继续**，拿到 `decision`。然后清空 `_currentRequest`、调 `_processQueue()` 让下一个排队请求上场。**「兑现当前 + 推进下一个」的接力，就这样把整个队列一个接一个地消费掉。**

**订阅 `subscribe`（[L51-L57](../../src/coding/permissions/approval-manager.ts#L51-L57)）——UI 注册入口：**

```ts
subscribe(callback: (req: ApprovalRequest | null) => void) {
  this._subscriber = callback;
  this._processQueue();   // ← 订阅时立刻处理一次（可能已经有排队请求了）
  return () => {
    this._subscriber = undefined;   // ← 返回「取消订阅」函数
  };
}
```

两个细节：**（a）订阅时立刻 `_processQueue()` 一次**——万一 UI 挂载前就已经有请求排队了（时序问题），订阅的瞬间就能把它「补推」给 UI。**（b）返回一个 unsubscribe 函数**——这是 React `useEffect` 的标准清理模式（第 19 节的 Hook 会 `return manager.subscribe(...)`，React 卸载时自动调用它清空 `_subscriber`）。测试 [L82-L105](../../src/coding/permissions/__tests__/approval-manager.test.ts#L82-L105) 验证了 unsubscribe 后不再收到通知。

**把这套「队列 + 单活跃 + 订阅」串成一个完整时序，就是并发请求被驯服成串行弹窗的过程：**

```
时刻 t0：模型并发调 bash + write_file（第 6 节并行工具）
  ├─ 中间件 A: await askUser(bash)      → _queue=[bash], _processQueue → _current=bash, 通知UI弹bash框
  └─ 中间件 B: await askUser(write_file) → _queue=[write_file]（_current 非空，只入队不弹）

时刻 t1：人类在 bash 框点「allow_once」
  UI 调 respond("allow_once")
  → bash 的 resolve("allow_once") 兑现（中间件A的 await 继续 → bash 执行）
  → _current=undefined, _processQueue → _current=write_file, 通知UI弹write_file框

时刻 t2：人类在 write_file 框点「deny」
  UI 调 respond("deny")
  → write_file 的 resolve("deny") 兑现（中间件B的 await 继续 → 返回 __skip 短路）
  → _current=undefined, _processQueue → 队列空, 通知UI(null) 收起弹窗
```

> 💡 **这套模式解决的核心矛盾（回收第 0 节伏笔）**：[第 6 节](./06-parallel-tools.md) 的并行工具意味着「**同一时刻可能冒出多个审批请求**」，但终端 UI「**一次只能弹一个框**」。`ApprovalManager` 用「队列」接住并发涌入的请求、用「单活跃」保证「一次只弹一个」、用「订阅」把「当前该弹谁」推给 UI、用「捕获 resolve」让每个请求各自的 `await` 在被响应时精确继续。**「并发进、串行出」——这就是它存在的全部理由。**

### 1.6 `ask_user_question` —— 用一个「阻塞式工具」实现「模型主动提问」

审批讲完，转到「提问」这条链路。它和审批的**功能对称、接入相反**：审批是「拦下模型**没主动要**的危险操作」，提问是「响应模型**主动发起**的一次交互」。所以它不是中间件，而是一个用 [第 4 节](./04-tool.md) `defineTool` 定义的**普通工具**——[ask-user-question.ts](../../src/coding/tools/ask-user-question.ts)（126 行）。

**先看它的「数据形状」**——这个工具的参数比一般工具复杂，因为它要描述「一组带选项的问题」（[L8-L39](../../src/coding/tools/ask-user-question.ts#L8-L39)）：

```ts
export interface AskUserQuestionOption {
  label: string;         // 选项的短标签
  description: string;    // 这个选项意味着什么
  preview?: string;       // 可选：选中时的 markdown 预览（仅单选）
}
export interface AskUserQuestionItem {
  question: string;                    // 问题正文
  header: string;                      // 极短的 tab 标签（≤12 字符）
  options: AskUserQuestionOption[];    // 2-4 个选项
  multi_select: boolean;               // 是否允许多选
}
export interface AskUserQuestionParameters {
  questions: AskUserQuestionItem[];    // 1-4 个并行、独立的问题
}
```

**这套结构对标的是「结构化的选择题」而非「开放式问答」。** 为什么？因为**让模型问「选择题」，比问「填空题」更可控**——选项是模型预先列好的，人类只需点选，不用打字，交互快、歧义小。参数用 Zod schema 施加了严格约束（[L41-L72](../../src/coding/tools/ask-user-question.ts#L41-L72)）：`header` 最多 12 字符、每题 2-4 个选项、每次 1-4 个问题。这些约束**既是给模型的「格式说明书」，也是运行时的硬校验**（呼应 [第 4 节](./04-tool.md) 「Zod 一处定义、三处受益」——类型、JSON Schema、运行时校验）。

**核心是 `createAskUserQuestionTool` 工厂（[L105-L125](../../src/coding/tools/ask-user-question.ts#L105-L125)）——它接收一个 `callback` 并返回一个工具：**

```ts
export function createAskUserQuestionTool(
  callback: (params: AskUserQuestionParameters) => Promise<AskUserQuestionResult>,   // ← 由 Manager 提供
) {
  return defineTool({
    name: "ask_user_question",
    description: `Ask the user one or more independent questions with fixed choices. ...`,
    parameters: askUserQuestionParametersSchema,
    invoke: async (input, signal) => {
      const params = askUserQuestionParametersSchema.parse(input);   // ① 再次 Zod 校验
      if (signal?.aborted) {                                          // ② abort 检查（前）
        throw new DOMException("Aborted", "AbortError");
      }
      const result = await callback(params);                         // ③ 阻塞：等人类回答
      if (signal?.aborted) {                                          // ④ abort 检查（后）
        throw new DOMException("Aborted", "AbortError");
      }
      validateResultAgainstParams(params, result);                   // ⑤ 校验答案合法
      return JSON.stringify(result);                                 // ⑥ 序列化回喂模型
    },
  });
}
```

**这个 `invoke` 是「阻塞式工具」的精髓，六步逐个看：**

**①⑤ 双向校验——入口校参数、出口校答案**：`invoke` 一进来先 `askUserQuestionParametersSchema.parse(input)` 校验模型给的参数（虽然 [第 4 节](./04-tool.md) 已经校过一道，这里再确保）；拿到人类答案后再用 `validateResultAgainstParams`（[L74-L99](../../src/coding/tools/ask-user-question.ts#L74-L99)）校验答案——**答案数必须等于问题数、选中的 label 必须在选项里、单选恰好选 1 个、多选至少选 1 个**。这道「出口校验」防的是「UI 传回了非法答案」这类边界错误（测试 [L163-L280](../../src/coding/tools/__tests__/ask-user-question.test.ts#L163-L280) 覆盖了每一种非法情况）。

**②④ 前后两次 abort 检查——呼应第 5 节的贯穿式取消**：`invoke` 在 `await callback` **前后各查一次 `signal?.aborted`**。为什么两次？**前一次**：万一工具还没开始等、任务就已被取消（比如用户按了 Ctrl+C），立刻抛 `AbortError`，不必弹框问人。**后一次**：万一「等人类回答」的漫长过程中任务被取消了，即使回调侥幸返回，也要抛错作废——**不能让一个「已取消的任务」的答案继续污染后续流程**。这是 [第 5 节](./05-react-loop.md) `AbortController` 贯穿式取消在「最可能长时间阻塞的工具」上的严格落地（测试 [L137-L161](../../src/coding/tools/__tests__/ask-user-question.test.ts#L137-L161) 验证 abort 前会抛错）。

**③ 阻塞点 `await callback(params)`——又一处「桥接」调用**：和审批的 `await askUser(...)` 一模一样的思想——`callback` 由 `AskUserQuestionManager` 提供（1.7），这个 `await` 会一直挂起直到人类回答。**注意这带来一个 Agent 循环的语义：当模型调用 `ask_user_question` 时，整个 Agent 主循环会停在 `_act` 里等这个工具返回**（[第 6 节](./06-parallel-tools.md) 的 `Promise.race` 会一直等它）——**这正是「阻塞式工具」的含义：它用「工具执行时间」占住了整个 Agent，直到人类回答。**

**⑥ 返回 JSON 字符串**：`return JSON.stringify(result)`——把人类的选择序列化成字符串回喂给模型。模型下一步就能读到「用户选了哪些 label」，据此继续。**至此，一次「模型问 → 人答 → 模型收到答案」的闭环完成。**

> 💡 **审批 vs 提问的「接入相反」（回收 1.1 的第一个反直觉点）**：审批是**中间件**——它在**每个工具执行前**被 Agent 核心自动调用，模型**根本不知道审批存在**（审批对模型透明）。提问是**工具**——它出现在模型的工具列表里，**由模型主动决定何时调用**（提问对模型可见、可主动发起）。**一个「被动拦截、对模型隐形」，一个「主动调用、对模型显形」——这是两者接入方式相反的根本原因。**（Q1 会深入这个「为什么」。）

### 1.7 `AskUserQuestionManager` —— 与 `ApprovalManager` 逐行同构的孪生

`ask_user_question` 工具里那个 `callback`，来自 [ask-user-question-manager.ts](../../src/coding/tools/ask-user-question-manager.ts)（58 行）。**它和 1.5 的 `ApprovalManager` 几乎是「复制粘贴 + 改名」**——这就是 1.1 说的第二个反直觉点，也是本节标题「**共享**的队列 + 单活跃 + 订阅」的字面兑现。我们**用一张对照表**快速带过，只标注差异：

| 维度 | `ApprovalManager` | `AskUserQuestionManager` | 差异 |
| --- | --- | --- | --- |
| 请求类型 | `ApprovalRequest = { toolUse, resolve }` | `AskUserQuestionRequest = { params, resolve }` | 只是载荷不同（工具调用 vs 问题参数） |
| 状态三件套 | `_queue` / `_currentRequest` / `_subscriber` | `_queue` / `_currentRequest` / `_subscriber` | **完全相同** |
| 入队方法 | `askUser(toolUse)` | `askUserQuestion(params)` | 名字不同，逻辑相同 |
| 队列溢出 | `resolve("deny")`（**兑现为拒绝**） | `reject(new Error(...))`（**抛错**） | ⚠️ **唯一实质差异**，见下 |
| `_processQueue` | 逐行相同 | 逐行相同 | **完全相同** |
| 响应方法 | `respond(decision)` | `respondWithAnswers(result)` | 名字不同，逻辑相同 |
| `subscribe` | 逐行相同 | 逐行相同 | **完全相同** |
| 全局单例 | `globalApprovalManager` | `globalAskUserQuestionManager` | 各有一个 |

**看 `_processQueue` 有多像**（[ask-user-question-manager.ts L29-L39](../../src/coding/tools/ask-user-question-manager.ts#L29-L39)）——和 1.5 的那段几乎逐字符相同：

```ts
private _processQueue() {
  if (this._currentRequest || this._queue.length === 0) {
    if (this._queue.length === 0 && !this._currentRequest) {
      this._subscriber?.(null);
    }
    return;
  }
  this._currentRequest = this._queue.shift()!;
  this._subscriber?.(this._currentRequest);
}
```

**唯一值得停下来的差异，是「队列溢出」时的处理**（[L18-L23](../../src/coding/tools/ask-user-question-manager.ts#L18-L23)）：

```ts
// AskUserQuestionManager：溢出 → reject（抛错）
if (this._queue.length >= MAX_QUEUE_SIZE) {
  console.warn("[AskUserQuestionManager] Queue overflow; rejecting request.");
  reject(new Error("Ask user question queue overflow"));   // ← 抛错，而非「兑现为某个默认答案」
  return;
}
```

**为什么审批溢出「兑现为 `deny`」，提问溢出却「reject 抛错」？** 因为**两者的「安全默认」不同**：

- **审批**有一个天然的「安全兜底答案」——`deny`（拒绝）。溢出时拒绝执行，是安全的（大不了操作没做）。所以它 `resolve("deny")`，让流程**正常继续**（模型收到「被拒」）。
- **提问**却**没有「安全的默认答案」**——用户到底想选 A 还是 B，机器无从替他决定，随便编一个答案是危险的（会让模型基于「假答案」继续）。所以它只能 `reject`——**把这次提问变成一个「工具执行失败」**，让模型知道「问不成」，而不是给它一个瞎编的答案。

**这个差异非常能体现「同构不等于同一」**：两个 Manager 共享了 95% 的机制（队列/单活跃/订阅/桥接），但在「异常兜底」这个**语义**上，各自遵循自己领域的「安全默认」。**机制可以复用，策略必须因地制宜**——这是识别「好的抽象」的一个标志：共性抽出来，差异留在原地，不强行统一。

> 🤔 **一个诚实的观察：为什么不把这套内核抽成一个泛型基类 `RequestQueue<TReq, TRes>`？** 两个 Manager 明明 95% 相同，抽个基类似乎更 DRY。但项目**没有这么做**——这与 [第 13 节 Q3](./13-search-system-tools.md) 「该不该抽公共函数」、[第 14 节](./14-apply-patch.md) 「不为 DRY 引入不匹配抽象」是**同一种务实判断**：（1）只有两个实例，抽象的收益有限；（2）抽成泛型基类后，`askUser`/`respond` 这些「领域方法名」会退化成泛型的 `enqueue`/`resolve`，**可读性反而下降**（`globalApprovalManager.askUser(toolUse)` 比 `globalApprovalManager.enqueue(toolUse)` 更达意）；（3）「溢出兜底」的差异（deny vs reject）会让基类需要额外的钩子来定制，**抽象的复杂度反噬了它节省的重复**。**所以这里选择「容忍少量重复，换取每个 Manager 各自清晰、领域方法名达意」——这是又一个「重复优于错误抽象」的案例。**（Q4 会进一步讨论「什么时候该抽、什么时候不该」。）

### 1.8 装配与全景：两个 `global` 单例如何被接进 Agent 与（未来的）UI

三层零件都看完了，最后看它们**怎么被组装起来**。关键在两个地方：`createCodingAgent`（把回调注入 Agent）和 `cli/index.tsx`（把全局单例的方法接上）。

**先看 [lead-agent.ts](../../src/coding/agents/lead-agent.ts) 如何「按需装配」**（[第 11 节](./11-lead-agent.md) 讲过总装，这里聚焦本节相关的两处）：

```ts
// ① 提问工具：只有宿主提供了 askUserQuestion 回调，才创建这个工具
const askUserQuestionTool = askUserQuestion ? createAskUserQuestionTool(askUserQuestion) : null;

// ② 审批中间件：只有宿主提供了 askUser 回调，才挂上这个中间件
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
// ... 工具数组末尾按需加入提问工具
tools: [ /* ...十个 coding 工具... */, todoTool, ...(askUserQuestionTool ? [askUserQuestionTool] : []) ],
```

**两个 `if` 揭示了一个重要设计：审批和提问都是「可选能力」。** 如果宿主（比如某个无人值守的批处理场景）不提供 `askUser`/`askUserQuestion` 回调，**审批中间件不挂、提问工具不加**——Agent 退化成一个「不问人、全自动」的模式。**「人机交互」不是硬编码进 Agent 的，而是通过「注入回调」按需启用的**——这让同一个 `createCodingAgent` 既能用于「交互式 TUI」，也能用于「全自动脚本」。这是 [第 11 节](./11-lead-agent.md) 「装配灵活性」的又一处体现。

**再看 [cli/index.tsx L74-L83](../../src/cli/index.tsx#L74-L83) 如何把「全局单例」接上：**

```ts
const agent = await createCodingAgent({
  model,
  skillsDirs,
  askUser: globalApprovalManager.askUser,                       // ← 注入审批 Manager 的入队方法
  askUserQuestion: globalAskUserQuestionManager.askUserQuestion, // ← 注入提问 Manager 的入队方法
  approvalPersistence: {                                         // ← 注入第 18 节的落盘实现
    loadAllowList: (cwd) => settingsLoader.loadAllowList(cwd),
    persistAllowedTool: (cwd, toolName) => settingsWriter.appendAllowedTool(cwd, toolName),
  },
});
```

**这里出现了两个 `global*Manager` 单例**（[approval-manager.ts L60](../../src/coding/permissions/approval-manager.ts#L60) 的 `globalApprovalManager` 和 [ask-user-question-manager.ts L58](../../src/coding/tools/ask-user-question-manager.ts#L58) 的 `globalAskUserQuestionManager`）。**为什么用全局单例？** 因为它们要充当「Agent 侧」和「UI 侧」之间的**共享桥梁**——Agent 侧调 `askUser`（入队），UI 侧调 `subscribe`/`respond`（消费）。**两侧必须操作同一个 Manager 实例**，全局单例是最简单的「让两个互不相识的模块共享一个对象」的手段。（这里也埋了一个第 18/19 节的接口：`settingsLoader`/`settingsWriter` 是第 18 节的落盘，UI 侧的 `subscribe` 是第 19 节的 Hook。）

**至此，把本节所有零件连成一张完整的「请求生命周期」全景图：**

```
┌─────────────────────────── 审批链路 ───────────────────────────┐   ┌────────────── 提问链路 ──────────────┐
                                                                  │   │
 模型发出危险 tool_use（bash/write_file/...）                     │   │  模型主动调 ask_user_question 工具
        │ 第 6 节 _act 并发执行                                    │   │        │ 第 6 节 _act 执行
        ▼                                                         │   │        ▼
 beforeToolUse 钩子（coding-approval-middleware）                 │   │  ask-user-question.invoke
   · 不在 requires-approval 名单 → 放行                            │   │    · Zod 校验参数 + abort 检查
   · 在白名单(approval-persistence) → 放行                        │   │        │
   · 否则 await askUser(toolUse) ──┐                              │   │    await callback(params) ──┐
        │                          │                              │   │        │                     │
        ▼                          ▼                              │   │        ▼                     ▼
 ┌─────────────────────────────────────┐                         │   │ ┌──────────────────────────────────┐
 │  ApprovalManager                    │                         │   │ │  AskUserQuestionManager            │
 │  askUser: new Promise → 捕获 resolve │  ←── 1.2 桥接 ──→        │   │ │  askUserQuestion: 捕获 resolve      │
 │  _queue 入队 → _processQueue         │  【队列+单活跃+订阅】     │   │ │  _queue 入队 → _processQueue        │
 │  溢出 → resolve("deny")（安全默认）   │                         │   │ │  溢出 → reject（无安全默认）         │
 │  _currentRequest = 队首 → 通知订阅者  │                         │   │ │  _currentRequest = 队首 → 通知订阅者 │
 └───────────────┬─────────────────────┘                         │   │ └───────────────┬────────────────────┘
   subscribe/respond（globalApprovalManager 单例）                 │   │  subscribe/respondWithAnswers（global 单例）
                 ▼                                                │   │                 ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │  第 19 节 React TUI：use-*-manager Hook 用 subscribe 拿到「当前请求」→ 渲染唯一弹窗                       │
 │  用户点选 → respond(decision) / respondWithAnswers(result) → 兑现 resolve → 上面的 await 继续            │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────┘
        │ 审批：deny → __skip 短路（第 7 节）跳过工具；allow → 放行执行                    │ 提问：JSON.stringify(答案) 回喂模型
        ▼                                                                              ▼
   工具结果回喂模型（第 8 节 formatToolResultForMessage），Agent 循环继续
```

**一句话总括本节主题**：**Helixent 把「审批拦截」和「主动提问」这两个功能，接入方式做成相反的两套（审批是第 7 节的中间件 + `beforeToolUse` 短路，对模型透明；提问是第 4 节的阻塞式工具，由模型主动调用），却让它们背后的两个 `Manager` 共享同一套「队列 + 单活跃 + 订阅 + 捕获 resolve」的内核——用「捕获 resolve」把异步 `await` 桥接到「未来某刻的人类响应」，用「队列 + 单活跃」把第 6 节并行工具带来的「并发请求」驯服成「一次一个的串行弹窗」，用「订阅」把「当前该弹谁」推给（第 19 节的）UI。审批和提问『功能对称、接入相反、内核同构』——这是本节最精巧的对称之美。**

***

## 2. 亮点与关键设计

明确标注哪些是「妙笔」、哪些是「关键决策」：

1. **【核心妙笔】「捕获 resolve」的 deferred 模式，把「等人类」变成一句朴素的 `await`。** `new Promise((resolve) => { queue.push({ ..., resolve }) })`——不立刻 resolve，而是把「让 await 继续的开关」存进队列，待人类响应时（`respond`）再按下。**这让「跨调用栈、跨时间的事件驱动交互」在上层表现为一个普通 Promise**，复杂性全被封装进 Manager。这是本节的总钥匙（1.2）。

2. **【核心妙笔】两个 Manager 共享「队列 + 单活跃 + 订阅」内核，驯服第 6 节的并发请求。** `_queue`（接住并发涌入）+ `_currentRequest`（保证一次只弹一个）+ `_subscriber`（把「当前该弹谁」推给 UI）——把「并发进」精确转换成「串行出」。这是 roadmap 标题里那套模式的实现，也是它存在的根本理由（1.5）。

3. **【关键决策】审批走中间件、提问走工具——功能相似，接入相反。** 审批是横切关注点，用 [第 7 节](./07-middleware.md) 的 `beforeToolUse` + `__skip` 短路**透明拦截**（模型不知情）；提问是模型的主动意图，用 [第 4 节](./04-tool.md) 的 `defineTool` 做成**可主动调用的工具**（模型显式发起）。**接入方式由「谁发起、对谁可见」决定**，而非由「功能长得像不像」决定（1.4/1.6，Q1 详解）。

4. **【关键决策】审批用 `__skip` 短路做「拒绝」，Agent 核心零改动。** `deny` 时返回 `{ __skip: true, result }`，Agent 的 `_beforeToolUse` 检测到 `__skip` 就跳过 `tool.invoke`——危险操作**从未发生**。审批因此成为「插在第 7 节插座上的可插拔插件」（不传 `askUser` 就整个不挂），完美兑现第 7 节「一切扩展的插座」（1.4）。

5. **【妙笔】`allow_always_project` + 持久化契约 = 治「审批疲劳」。** 三种决定里，`allow_always_project` 把「每次都问」降级为「问一次，此后放行」；而「记住」通过 `ApprovalPersistence` 契约（只定义 type、实现留第 18 节）实现「依赖倒置」——`coding` 层依赖抽象、`cli` 层注入实现，既可测又可复用（1.3）。

6. **【妙笔】溢出兜底「同构却不同策」：审批 deny、提问 reject。** 两个 Manager 95% 相同，但队列溢出时——审批有安全默认（`resolve("deny")`，拒绝是安全的），提问无安全默认（`reject`，不能瞎编答案）。**机制复用、策略因地制宜**，是「同构不等于同一」的精准拿捏（1.7）。

7. **【关键决策】人机交互是「注入的可选能力」，非硬编码。** `createCodingAgent` 里 `if (askUser)` 才挂审批中间件、`askUserQuestion ? ... : null` 才加提问工具——同一个 Agent 工厂既能做「交互式 TUI」，也能做「无人值守全自动」。**「是否有人在」成了一个运行时开关**（1.8）。

8. **【妙笔】提问工具前后两次 abort 检查，严守第 5 节的贯穿式取消。** `await callback` 前后各查一次 `signal?.aborted`——前查「等之前就已取消，不必弹框」，后查「等的过程中被取消，答案作废」。**「最可能长时间阻塞的工具」上，取消语义守得最严**（1.6）。

9. **【一致性红利】`subscribe` 返回 unsubscribe 函数，天然契合 React `useEffect`。** `subscribe` 的返回值是一个清空 `_subscriber` 的清理函数，第 19 节的 Hook 直接 `return manager.subscribe(...)` 即可让 React 在卸载时自动清理——**Manager 的 API 形状是「为 React 消费而设计」的**，跨层却严丝合缝（1.5）。

***

## 3. 工业对比

对比业界方案的做法与优缺点。

### 3.1 Claude Code 的权限系统 —— 更细粒度的「按操作」审批

Anthropic 的 Claude Code 有一套成熟的权限（permission）机制，和 Helixent 的审批同源但更细：

- **Claude Code**：审批粒度到**具体操作**而非「工具名」——比如 `bash` 命令会按「命令模式」区分（`npm test` 可以一次批准某个前缀、`rm -rf` 单独确认），文件写入会按路径区分。它还有 `--dangerously-skip-permissions`（YOLO 模式）、`allowedTools` 配置、以及区分 project/user/local 三级的设置。
- **Helixent**：审批粒度是**工具名**（`bash`/`write_file`/... 整个工具要不要审批），白名单也是「工具名级别」（`allow_always_project` 记的是「`bash` 这个工具」而非「`npm test` 这条命令」）。

**取舍**：Claude Code 的「按操作」粒度**更安全**（批准了 `npm test` 不等于批准 `rm -rf`），但**更复杂**（要解析命令、匹配模式、维护更细的白名单）。Helixent 的「按工具」粒度**更简单**（一个字符串集合搞定），但**更粗**——一旦 `allow_always_project` 了 `bash`，此后所有 `bash` 命令都免审批（包括危险的）。**对一个「教学样本 + 小项目」，Helixent 的粗粒度是合理的「够用就好」**；但读者应意识到：**生产级 Agent 通常需要 Claude Code 那种「按操作」的细粒度**，这是 Helixent 为「代码量小」做的一个明确妥协。

### 3.2 OpenAI Codex CLI 的审批模式 —— Suggest / Auto Edit / Full Auto

OpenAI 的 Codex CLI 把「人机信任级别」做成了几档**模式**：

- **Suggest**（默认）：任何改动都要人确认。
- **Auto Edit**：文件改动自动批准，但跑命令仍要确认。
- **Full Auto**：全自动，都不问（在沙箱里跑）。

**对比 Helixent**：Helixent 没有「全局模式」这个概念，它是**按工具 + 白名单**的组合——效果上，「白名单为空」≈ Suggest（都问），「把所有写工具都 allow_always」≈ Full Auto。**Codex 的「模式」更像一个「一键切换信任级别」的宏**，对用户更直观；Helixent 的「逐工具白名单」更**渐进**（用一次、信一个），但没有「一键全信/全不信」的快捷方式。**两者都是「让用户控制信任级别」，只是把旋钮放在了不同的地方**——Codex 放在「模式」，Helixent 放在「逐工具累积的白名单」。

### 3.3 `ask_user_question` vs LangChain 的 Human-in-the-Loop / `interrupt`

LangChain / LangGraph 有一套 Human-in-the-Loop 机制，核心是 `interrupt()`——它能在图（graph）执行到某个节点时**暂停**，把控制权交还给人类，人类响应后从**断点恢复**。

**对比本节的「阻塞式工具」：**

- **LangGraph 的 `interrupt`**：基于**checkpointer（状态快照）**——它把整个图的状态存下来，暂停，可以**跨进程、跨会话恢复**（人类第二天回来接着答）。强大，但需要一套状态持久化基础设施。
- **Helixent 的 `ask_user_question`**：基于**一个挂起的 Promise**——它没有状态快照，Agent 进程**必须一直活着**等 Promise 兑现。简单，但**不能跨进程恢复**（关掉终端，这次提问就丢了）。

**取舍**：LangGraph 的方案适合「长时间运行、可能需要几小时/几天才有人响应」的生产工作流；Helixent 的「Promise 挂起」适合「交互式 CLI、人就在终端前、秒级响应」的场景。**Helixent 用「一个 await」换来了极简，代价是「必须在线等待」**——对一个终端 CLI 工具，这是完全合理的选择（你不会关掉终端再指望它记得刚才问了啥）。

### 3.4 审批用「中间件」的架构价值 —— 对比「在每个工具里手写审批」

一个值得对比的「反面设计」是：**不用中间件，而在每个危险工具的 `invoke` 开头手写审批**。比如让 `bashTool` 的 `invoke` 第一行就 `if (await needApproval()) {...}`。

**Helixent 用中间件的三个优势：**

- **DRY**：审批逻辑写**一次**（在中间件里），而非在 `bash`/`write_file`/`str_replace`/... 六个工具里各写一遍。
- **工具保持纯粹**：`bashTool` 只管「怎么跑命令」，完全不知道「审批」的存在——**关注点分离**。想给工具加审批、去审批，改的是「装配」（挂不挂中间件），而非「工具本身」。
- **策略集中**：「哪些工具要审批」集中在 `CODING_TOOLS_REQUIRING_APPROVAL` 一个数组里，一目了然；换成「每个工具自己审批」，这个策略就散落在六个文件里，难以纵览。

**这正是 [第 7 节](./07-middleware.md) 中间件系统的价值在本节的兑现**：横切关注点（审批、日志、技能注入……）应该「横切」进一个可插拔的层，而非「纵向」侵入每个业务单元。**对比 3.1/3.2 各家方案，它们大多也是「审批作为一个独立的拦截层」而非「散在工具里」——这是行业共识。**

### 3.5 一览表

| 维度 | Helixent | Claude Code | OpenAI Codex | LangGraph HITL |
| --- | --- | --- | --- | --- |
| 审批粒度 | 工具名 | 操作/命令模式 | 模式（三档） | 节点级 |
| 拦截机制 | 中间件 + `__skip` 短路 | 权限层 | 模式判定 | `interrupt()` |
| 「记住选择」 | `allow_always_project` 白名单 | allowedTools 多级配置 | 切模式 | checkpointer |
| 提问机制 | 阻塞式工具（Promise 挂起） | 交互提示 | 交互提示 | `interrupt` + 状态快照 |
| 跨进程恢复 | ❌（必须在线等） | ❌ | ❌ | ✅（有 checkpointer） |
| 并发请求处理 | **队列 + 单活跃 + 订阅** | 内部管理 | 内部管理 | 图调度 |
| 代码量 | **极小（七个小文件）** | 大 | 中 | 大（含状态基础设施） |

***

## 4. 深度解释：为什么这样设计？不这样会怎样？

用 Q&A 形式讲清几个「为什么」，以及「不这样会出什么问题」。

### Q1：审批和提问功能这么像，为什么一个做成「中间件」、一个做成「工具」？统一成一种不行吗？

**不行——因为它们的『发起者』和『可见性』根本不同，决定了接入方式必须相反。**

先厘清两者的本质区别（这是本节最需要想透的一点）：

| | 审批（Approval） | 提问（Ask） |
| --- | --- | --- |
| **谁发起** | **Agent 框架**（模型没主动要） | **模型**（主动决定要问） |
| **对模型可见吗** | **不可见**（模型不知道有审批） | **可见**（是工具列表里的一项） |
| **拦截的对象** | 模型**已经想做**的危险操作 | 无（提问本身就是模型想做的） |
| **典型触发** | 模型调 `bash rm` → 被审批拦住 | 模型遇到歧义 → 主动调 `ask_user_question` |

**看清这个区别，接入方式就是「被逼出来的」，而非随意选的：**

**审批必须是中间件**，因为它要拦截的是「模型**没有主动请求**审批、但框架**必须**在它执行危险操作前插一脚」的场景。如果把审批做成工具，就得指望**模型主动调用一个 `request_approval` 工具**——但模型凭什么会主动请求审批？它想的是「我要跑这个命令」，不是「我要请求批准跑这个命令」。**审批的本质是『在模型不知情的情况下，框架强制插入的一道关卡』——这天然就是「中间件」（拦截器）的职责，而非「工具」（模型主动调用的能力）。**

**提问必须是工具**，因为它是「模型**主动**发起的一次交互」。模型遇到「这个需求有歧义」时，需要一个**它能主动调用**的能力去问人。工具正是「模型能主动调用的能力」的载体。如果把提问做成中间件，它就失去了「被模型主动触发」的入口——中间件是「框架在固定生命周期点自动跑的」，模型无法「主动触发一个中间件」。

**「不统一」会怎样？** 假设硬要统一成「都是工具」：审批就得靠模型自觉调 `request_approval`——**模型不调怎么办？危险操作就裸奔了**，审批形同虚设。假设硬要统一成「都是中间件」：提问就没法被模型主动发起——**模型想问也问不了**。**所以这里的「接入相反」不是设计不一致，恰恰是『让每种交互用最贴合其本质的机制』的精确选择。** 而它们**能共享内核**，是因为「桥接异步 Promise + 排队 + 单活跃 + 订阅」这套**调度机制**与「谁发起」无关——发起方式（中间件 vs 工具）是「入口」，Manager 是「共享的后端」。**入口按本质分道扬镳，后端按机制合流复用——这才是本节设计的精髓。**

### Q2：为什么非要「队列 + 单活跃」？直接让每个审批请求各自弹一个框、并行处理不行吗？

**不行——因为终端 UI 的物理限制是『一次只能有意义地展示/交互一个框』，并行弹窗会造成灾难性的交互混乱。**

先想象「没有队列、并行弹窗」会发生什么。[第 6 节](./06-parallel-tools.md) 的并行工具让模型能一步同时调用 `bash`、`write_file`、`str_replace`——假设它们都要审批。如果每个请求各自弹框：

1. **屏幕上同时冒出三个审批框**——用户看哪个？三个框在终端里叠着渲染，光标该响应谁的按键？**终端不是浏览器，没有「窗口层级」和「焦点管理」**，三个框会渲染成一团乱麻。
2. **用户按一次「y」，是批准了哪个？** 三个框都在监听键盘，一次按键可能被多个框接收，或者根本不知道给了谁。
3. **即使勉强能交互，认知负担也爆炸**——用户要在脑子里同时维护「三个待决定的操作」的上下文。

**「队列 + 单活跃」把这团乱麻理顺了**：无论模型并发抛来多少请求，**同一时刻只有一个 `_currentRequest` 被展示**，用户**心无旁骛地决定这一个**，决定完了下一个才上场。**「一次只做一个决定」符合人类的认知方式，也符合终端「一次一个焦点」的物理现实。**

**「不这样会怎样」的更深一层**：即使不考虑 UI 渲染，「并行处理审批」还有个隐患——**决定之间可能有依赖**。比如模型同时要 `mkdir /foo` 和 `write_file /foo/bar.ts`，如果并行审批、用户先批了 write 后批了 mkdir，执行顺序就可能错乱。**串行审批天然保持了「决定的顺序性」**，让用户能按一个有意义的顺序思考。**所以「队列 + 单活跃」不只是为了 UI 好看，更是为了『让人类的决策过程有序、可控、低负担』——这是 Human-in-the-Loop 的核心诉求。**

### Q3：`ask_user_question` 是「阻塞式工具」，会占住整个 Agent 循环。这不会导致「假死」吗？为什么可以接受？

**它确实会阻塞整个 Agent，但这不是 bug，而是提问的『语义正确性』所要求的——而且它被第 5 节的取消机制兜住了。**

先确认阻塞的事实：[第 6 节](./06-parallel-tools.md) 的 `_act` 用 `Promise.race` 等所有工具完成，而 `ask_user_question` 的 Promise 要等人类回答才 resolve。所以模型调用它时，**整个 Agent 主循环会停在这里，直到人类回答**。看起来像「假死」。

**但这恰恰是提问『应该有』的语义**，三个理由：

1. **提问的目的就是「等答案再继续」。** 模型问「你想用 TypeScript 还是 Python？」——它**必须**拿到答案才能决定下一步写什么代码。如果不阻塞、Agent 继续往下跑，模型就得在「不知道答案」的情况下瞎猜，**那提问就毫无意义了**。**「阻塞直到有答案」是提问的本质，不是缺陷。**

2. **它不是「死锁」，而是「有意的等待」。** 「假死」通常指「程序卡住且无法恢复」。但这里的等待**有明确的唤醒条件**（人类回答）和**明确的取消出口**（[第 5 节](./05-react-loop.md) 的 `AbortController`——用户按 Ctrl+C，`signal.aborted` 变 true，1.6 的两次 abort 检查会抛 `AbortError` 让工具立刻返回）。**「可被唤醒、可被取消的等待」不是假死。**

3. **交互式 CLI 场景下，「等人」本就是常态。** 用户就坐在终端前，Agent 问了个问题、等他回答——这段「等待」在用户看来是**完全自然的**（就像和人对话时等对方回答）。**只有在「无人值守的自动化」场景下，「阻塞等人」才是问题——而那种场景根本不会启用 `ask_user_question`**（1.8：不传 `askUserQuestion` 回调，工具就不挂）。

**「不这样（不阻塞）会怎样」**：如果 `ask_user_question` 不阻塞、立刻返回一个「占位答案」，模型就会基于假答案继续，产出错误的结果，然后人类的真实回答来了也没用了——**整个「提问」沦为摆设**。**所以「阻塞」是提问能发挥作用的前提，而第 5 节的取消机制保证了这个阻塞『可控、可逃生』——两者配合，既让提问有意义，又不会真的把 Agent 锁死。**

### Q4：1.7 说两个 Manager「95% 相同却不抽基类」，可到底什么时候该抽公共抽象、什么时候不该？有没有判断标准？

**有——判断标准是『抽象节省的成本 vs 抽象引入的成本』，而不是『代码看起来重不重复』。本节的选择恰好落在「不该抽」的一侧。**

先破除一个误解：**DRY（Don't Repeat Yourself）的本意是「不要重复知识」，不是「不要重复代码」。** 两段长得一样的代码，如果它们表达的是**两个会独立演化的知识**，那它们「碰巧相同」，强行合并反而会在它们分道扬镳时制造麻烦（即 Sandi Metz 的名言「**错误的抽象比重复更昂贵**」）。

**给一套可操作的判断清单**（用它审视本节）：

| 判断维度 | 倾向「抽象」 | 倾向「保留重复」 | 本节情况 |
| --- | --- | --- | --- |
| **实例数量** | 多（3+，且预计还会增加） | 少（就 2 个，且不太会增加） | 2 个，不太会增（→ 不抽） |
| **是否同一知识** | 是（改一处必改所有处） | 否（各自会独立演化） | 溢出策略已分化（deny/reject）（→ 不抽） |
| **抽象后可读性** | 提升 | 下降（领域名被泛化冲淡） | `askUser` 比 `enqueue` 达意（→ 不抽） |
| **差异的处理成本** | 差异少、易参数化 | 差异需要额外钩子/分支 | 溢出差异需定制钩子（→ 不抽） |

**本节四个维度全部指向「不抽」**：只有 2 个实例、溢出策略已经分化（证明它们是「两个知识」而非「一个知识」）、抽象会让 `askUser`/`respond` 退化成泛型的 `enqueue`/`resolve`（可读性下降）、差异（deny vs reject）需要基类开钩子（复杂度反噬）。**所以「保留两份 95% 相似的代码」是这里的正确选择。**

**反过来，什么时候「该抽」？** 设想如果 Helixent 未来要支持「审批、提问、文件选择、确认对话框、进度反馈……」**五六种**人机交互，且它们的队列逻辑**完全一致**（连溢出策略都能统一），那时「实例数量多 + 确是同一知识 + 差异可参数化」三条满足，抽一个 `RequestQueue<TReq, TRes>` 基类就**划算**了。**判断的关键永远是『此刻抽象的净收益』，而非『看到重复就手痒』。** 本节作者忍住了「手痒」，是成熟工程判断的体现——**这也和 [第 13 节 Q3](./13-search-system-tools.md)、[第 14 节 3.4](./14-apply-patch.md) 一脉相承：Helixent 通篇都在示范「务实地对待重复与抽象」。**

### Q5：`approval-persistence.ts` 只有 6 行、只定义了两个函数类型，为什么要单独占一个文件？直接把类型写在中间件里不行吗？

**因为这 6 行是一个『架构边界』的声明——它标记了 `coding` 层与 `cli` 层的接缝，单独成文件是为了让这条边界『显式、可见、可依赖』。**

先回答「行不行」：把 `ApprovalPersistence` 类型内联进 `coding-approval-middleware.ts` 当然**能跑**。但那样会模糊一件重要的事——**这个类型不是中间件的「内部细节」，而是 `coding` 层对外（对 `cli` 层）暴露的「契约」。**

**单独成文件的三个价值：**

1. **让契约「可被独立引用」。** [lead-agent.ts](../../src/coding/agents/lead-agent.ts) 和 [cli/index.tsx](../../src/cli/index.tsx) 都要引用 `ApprovalPersistence`（一个定义参数类型、一个提供实现）。放在独立文件里，双方 `import { ApprovalPersistence } from ".../approval-persistence"`——**契约有了一个明确的「单一来源」**。若内联进中间件，别人就得从 `coding-approval-middleware` 里 import 一个「持久化契约」，语义上很别扭（为什么持久化契约要从「中间件」文件里拿？）。

2. **让「依赖倒置」这件事『看得见』。** 这个文件的存在本身就在宣告：「**`coding` 层需要一个持久化能力，但拒绝自己实现它，而是定义一个契约、等外层注入**」。一个专门的 `approval-persistence.ts` 文件，比「藏在中间件里的一个 type」**更能表达这个架构意图**——读代码的人一看目录就知道「哦，持久化是一个被抽象出去的、待注入的关注点」。

3. **符合「一个文件一个关注点」的项目气质。** 回看 1.1，审批一侧的文件都极小且单一职责：`requires-approval`（名单）、`approval-types`（决定）、`approval-persistence`（持久化契约）、`coding-approval-middleware`（拦截逻辑）、`approval-manager`（调度）。**每个文件回答一个问题**。把持久化契约塞进中间件，会让中间件同时承担「拦截逻辑」和「持久化契约定义」两个关注点——**违背了这种「小而单一」的一致性**。

**「不这样会怎样」**：短期看没差别（能跑）。但长期看，**架构边界会变得模糊**——当项目变大、有人想「换一种持久化实现」或「给持久化契约加个方法」时，他得先在中间件文件里「考古」找到那个内联的 type，改动的影响范围也不清晰。**把 6 行的契约单独成文件，是用『一点点文件数量的增加』换取『架构边界的清晰与显式』——这在一个以「分层干净」为卖点的项目里，是完全值得的。** 这也呼应了 [第 1 节](./01-overview.md) 反复强调的「严格单向依赖」：`approval-persistence.ts` 就是那条「`coding` 不依赖 `cli`、只依赖抽象」的边界的物理体现。

***

## 5. 参考资料

**本节精讲的源码（七个文件）**：

审批一侧（`src/coding/permissions/`）：
- [requires-approval.ts](../../src/coding/permissions/requires-approval.ts)（9 行）——`CODING_TOOLS_REQUIRING_APPROVAL` 必审批名单
- [approval-types.ts](../../src/coding/permissions/approval-types.ts)（1 行）——`ApprovalDecision` 三种决定
- [approval-persistence.ts](../../src/coding/permissions/approval-persistence.ts)（6 行）——白名单读写契约（实现留第 18 节）
- [coding-approval-middleware.ts](../../src/coding/permissions/coding-approval-middleware.ts)（44 行）——`beforeToolUse` 拦截逻辑、`__skip` 短路
- [approval-manager.ts](../../src/coding/permissions/approval-manager.ts)（60 行）——共享内核：队列 + 单活跃 + 订阅
  - `ApprovalRequest` 类型与状态三件套：[L5-L17](../../src/coding/permissions/approval-manager.ts#L5-L17)
  - `askUser`（捕获 resolve + 溢出保护）：[L19-L29](../../src/coding/permissions/approval-manager.ts#L19-L29)
  - `_processQueue`（单活跃调度心脏）：[L31-L41](../../src/coding/permissions/approval-manager.ts#L31-L41)
  - `respond`（兑现 + 推进）：[L43-L48](../../src/coding/permissions/approval-manager.ts#L43-L48)
  - `subscribe`（UI 注册 + unsubscribe）：[L51-L57](../../src/coding/permissions/approval-manager.ts#L51-L57)
- [permissions/index.ts](../../src/coding/permissions/index.ts)——桶文件导出

提问一侧（`src/coding/tools/`）：
- [ask-user-question.ts](../../src/coding/tools/ask-user-question.ts)（126 行）——阻塞式工具、Zod schema、答案校验
  - 数据类型 `AskUserQuestionOption`/`Item`/`Parameters`/`Result`：[L8-L39](../../src/coding/tools/ask-user-question.ts#L8-L39)
  - Zod schema（约束 2-4 选项、1-4 问题、header≤12）：[L41-L72](../../src/coding/tools/ask-user-question.ts#L41-L72)
  - `validateResultAgainstParams`（出口校验）：[L74-L99](../../src/coding/tools/ask-user-question.ts#L74-L99)
  - `createAskUserQuestionTool`（工厂 + 双 abort 检查）：[L105-L125](../../src/coding/tools/ask-user-question.ts#L105-L125)
- [ask-user-question-manager.ts](../../src/coding/tools/ask-user-question-manager.ts)（58 行）——共享内核的孪生（溢出 reject 是唯一差异）

**co-located 测试（[第 21 节](./00-roadmap.md) 会讲这套约定）**：
- [approval-manager.test.ts](../../src/coding/permissions/__tests__/approval-manager.test.ts)——入队/订阅/串行处理/队列清空/unsubscribe
- [coding-approval-middleware.test.ts](../../src/coding/permissions/__tests__/coding-approval-middleware.test.ts)——名单放行/白名单跳过/deny 短路/持久化/持久化失败不抛
- [requires-approval.test.ts](../../src/coding/permissions/__tests__/requires-approval.test.ts)——名单内容/非空/无重复
- [ask-user-question.test.ts](../../src/coding/tools/__tests__/ask-user-question.test.ts)——schema 校验/abort 抛错/答案校验的各种非法情况
- [ask-user-question-manager.test.ts](../../src/coding/tools/__tests__/ask-user-question-manager.test.ts)——FIFO 顺序/订阅通知

**上游依赖章节**：
- [第 7 节 · Middleware 中间件系统](./07-middleware.md)：`beforeToolUse` 钩子与 `{ __skip: true, result }` 短路协议（审批拦截的机制根基）、「中间件是一切扩展的插座」
- [第 6 节 · 并行工具调度](./06-parallel-tools.md)：并行工具带来「同时多个审批请求」的矛盾（队列 + 单活跃存在的根本原因）
- [第 5 节 · ReAct 主循环](./05-react-loop.md)：`AbortController` 贯穿式取消（提问工具前后两次 abort 检查、阻塞可逃生的保证）
- [第 4 节 · Tool 工具系统](./04-tool.md)：`defineTool` 工厂与 Zod（`ask_user_question` 作为普通工具的定义方式、schema 校验）
- [第 11 节 · Lead Agent](./11-lead-agent.md)：`createCodingAgent` 如何按需装配审批中间件与提问工具、`CODING_TOOLS_REQUIRING_APPROVAL` 的传入

**下游承接章节（本节埋的接口）**：
- [第 18 节 · CLI 入口、配置与设置持久化](./00-roadmap.md)：`ApprovalPersistence` 契约的落地实现（`SettingsLoader`/`SettingsWriter` + `appendToolToAllowList` 读写 `~/.helixent`）
- [第 19 节 · TUI 架构与状态编排](./00-roadmap.md)：`use-approval-manager`/`use-ask-user-question-manager` Hook 如何 `subscribe` 两个 Manager，把「单活跃请求」渲染成 React 弹窗（`approval-prompt`/`ask-user-question-prompt` 组件）

**关联源码（本节引用但不精讲）**：
- Agent 核心的短路分发：[agent.ts `_act` L221-L238](../../src/agent/agent.ts#L221-L238)、[`_beforeToolUse` L337-L349](../../src/agent/agent.ts#L337-L349)
- 装配处：[lead-agent.ts L62-L119](../../src/coding/agents/lead-agent.ts#L62-L119)
- 全局单例接线：[cli/index.tsx L74-L83](../../src/cli/index.tsx#L74-L83)
- 桶文件导出：[coding/index.ts](../../src/coding/index.ts)

**外部资料**：
- JavaScript Promise「deferred / 捕获 resolve」模式（MDN Promise 构造器）：<https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/Promise>
- Sandi Metz「The Wrong Abstraction」（「错误的抽象比重复更昂贵」，Q4 的理论依据）：<https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction>
- Claude Code 权限系统文档（3.1 对比）：<https://docs.anthropic.com/en/docs/claude-code/security>
- OpenAI Codex CLI 的审批模式（3.2 对比）：<https://github.com/openai/codex>
- LangGraph Human-in-the-Loop 与 `interrupt`（3.3 对比）：<https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/>
- 依赖倒置原则（DIP，`approval-persistence` 契约的理论基础）：<https://en.wikipedia.org/wiki/Dependency_inversion_principle>

***

## 6. 小结与下一节预告

本节我们拆透了 Helixent 的人机协作（Human-in-the-Loop）基础设施——**七个小文件、两个功能、两套接入、一套共享内核**：

- **一把总钥匙**：「**捕获 resolve**」的 deferred 模式——`new Promise` 时不立刻 resolve，而把「让 await 继续的开关」存进队列，待人类响应时按下。这让「跨栈、跨时间的事件驱动交互」在上层表现为一句朴素的 `await`（1.2）。
- **审批链路**：三个契约小文件（名单 / 决定 / 持久化契约，1.3）+ `createCodingApprovalMiddleware` 用 [第 7 节](./07-middleware.md) 的 `beforeToolUse` + `__skip` 短路**透明拦截**危险操作、`deny` 时彻底跳过 `tool.invoke`（1.4）。
- **提问链路**：`ask_user_question` 用 [第 4 节](./04-tool.md) 的 `defineTool` 做成一个**阻塞式工具**，由模型**主动**调用，前后两次 abort 检查严守 [第 5 节](./05-react-loop.md) 的取消语义（1.6）。
- **共享内核**：两个 `Manager` 几乎逐行同构——「**队列**（接住第 6 节的并发请求）+ **单活跃**（一次只弹一个）+ **订阅**（把当前请求推给 UI）」，把「并发进」驯服成「串行出」；唯一差异是溢出兜底（审批 deny、提问 reject），体现「机制复用、策略因地制宜」（1.5、1.7）。
- **一条主线**：审批和提问『**功能对称、接入相反、内核同构**』——接入按「谁发起、对谁可见」的本质分道扬镳（中间件 vs 工具），后端按「桥接 + 排队」的机制合流复用。这是本节最精巧的对称之美（Q1）。

至此，**第四部分 · Coding 层全部讲完**。回望这五节：[第 11 节](./11-lead-agent.md) 把通用大脑装配成 Coding Agent（系统提示词 + 工具 + 中间件），[第 12～14 节](./12-tool-foundation-file-io.md) 造出「改动世界」的工具（读写 / 探索 / 打补丁），本节则为这些危险操作加上「人类过目、点头才放行」的护栏。**一个『会写代码、且受人类监督』的 Coding Agent，到这里已经在代码层面完整了。**

**承上启下（启下）**：但请注意本节反复出现的一个**空白**——两个 Manager 都在「**等一个 UI 来 `subscribe` 并 `respond`**」，`approval-persistence` 也在「**等一个实现来落盘**」。更根本的是：**整个 Coding Agent 目前还跑在内存里、连不上任何真实的大模型厂商**——[第 3 节](./03-model.md) 定义的 `ModelProvider` 契约，至今还没有一个真实实现！一个「连不上模型」的 Agent，本质上还是个「空壳」。

**所以下一步必须先补齐「连接真实模型」这一环**——这是 [第五部分 · Community 层](./00-roadmap.md) 的任务。它会揭晓：[第 2 节](./02-message.md) 的内部 `Message`，如何被翻译成 OpenAI / Anthropic 各自的 wire 格式？[第 3 节](./03-model.md) 约定的「每次 yield 完整快照」的流式碎片，又如何从厂商返回的「增量 delta」里拼回来？

> 预告一个对比：你会在第 16 节看到，接入 OpenAI 时最烧脑的是 `StreamAccumulator`——它要增量拼接**一段还没传完的 tool-call JSON**，并坚持「参数没解析成功前，绝不吐出 `tool_use`」。这个「严谨的流式累积」，正是让本节的 `ask_user_question`、以及第 6 节的并行工具，能拿到**完整、合法的工具调用**的底层保证。**Foundation 定义的契约（第 3 节），终于要迎来它的第一个真实实现了。**

👉 下一节 **第 16 节：OpenAI Provider —— 消息转换与流式累积器**。

准备好后，对我说「**生成第 16 节**」即可。
