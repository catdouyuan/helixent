# 第 7 节：Middleware 中间件系统 —— 8 个生命周期钩子

> 本节属于 **第三部分 · Agent 层（可复用的通用大脑）**，是 [第 6 节](./06-parallel-tools.md) 的**直接续集**，也是整个第三部分的**枢纽**。前两节我们把 ReAct 主循环的**控制流骨架**（第 5 节）和**并发工具调度**（第 6 节）看透了，一台会自主干活的机器已经成型——但它是「**封闭**」的：想加审批、加技能、加待办提醒，似乎都得去改 `agent.ts` 这颗心脏。本节要回答的，就是这台机器**如何在不动核心代码的前提下变成一个可任意扩展的平台**。
>
> 对应 roadmap 为本节设定的**核心问题**：
>
>> 如何在不改 Agent 核心代码的前提下，插入审批、技能注入、待办提醒等行为？
>>
>
> **一句边界声明**：本节只精讲**两处**——中间件的**类型契约**（[agent-middleware.ts](../../src/agent/agent-middleware.ts)，139 行）和主循环里的**钩子分发逻辑**（[agent.ts](../../src/agent/agent.ts#L278-L360) 那 8 个 `_beforeX/_afterX` 私有方法）。至于插在这些钩子上的三个**具体插件**——结果处理管线、Skills、Todos——分别是 [第 8](./00-roadmap.md)、[第 9](./00-roadmap.md)、[第 10 节](./00-roadmap.md) 的主题；审批与提问是 [第 15 节](./00-roadmap.md) 的主题。本节只把它们当「用来演示钩子怎么被使用」的例子，点到为止，不展开其内部实现。

---

## 0. 承上启下

[第 6 节](./06-parallel-tools.md) 在结尾把话递到了这里，而且递得很尖锐。当时我们钻进 `_act`，逐行看懂了并发调度，但过程中**反复撞见几个被当黑盒轻轻带过的东西**：

- 在真正执行工具**之前**，`_act` 调了一句 `await this._beforeToolUse(toolUse)`（[agent.ts](../../src/agent/agent.ts#L228)），并且检查它的返回值有没有 `skip`——当时我们说「审批系统靠这个短路实现，第 7 节再讲」。
- 工具执行**之后**，又调了 `await this._afterToolUse(toolUse, result)`（[agent.ts](../../src/agent/agent.ts#L233)）——同样被跳过了。

不止 `_act`。回看第 5 节的主循环 `stream`，你会发现它**从头到尾撒满了这类钩子调用**（[agent.ts](../../src/agent/agent.ts#L140-L171)）：

```
_appendMessage(message)          ← 追加用户消息
await this._beforeAgentRun()     ← ① 钩子
for (step = 1..maxSteps):
    await this._beforeAgentStep(step)   ← ② 钩子
    assistantMessage = yield* this._think()
        └─ 内部：await this._beforeModel(modelContext)   ← ③ 钩子
    await this._afterModel(assistantMessage)            ← ④ 钩子
    yield { type: "message", ... }
    if (无 toolUses):
        await this._afterAgentRun()      ← ⑤ 钩子
        return
    yield* this._act(toolUses)
        └─ 内部：await this._beforeToolUse(toolUse)   ← ⑥ 钩子
        └─ 内部：await this._afterToolUse(toolUse, result)   ← ⑦ 钩子
    await this._afterAgentStep(step)     ← ⑧ 钩子
```

**8 个钩子，散布在主循环的 8 个关键时刻。** 第 5、6 节我们一直把它们当「已经插好、不用管」的插座，专注在控制流和并发上。现在到了拆插座的时候。第 6 节留下的钩子是：

> **如果想给 Agent 加一个「危险操作先弹给人类审批」的行为、或「长任务里定期提醒更新待办」的行为、或「按需注入一套技能说明」的行为——难道每加一个都要去改 `agent.ts` 这颗心脏吗？有没有办法不碰核心代码，就把这些行为「插」进循环的各个时机？`beforeToolUse` 返回 `{ __skip: true }` 的那个「短路」信号，究竟怎么运作？**

要回答它，我们只需要打开两个文件对照：

- 契约定义：[agent-middleware.ts](../../src/agent/agent-middleware.ts)（本节精讲，139 行，全是类型）
- 分发实现：[agent.ts](../../src/agent/agent.ts#L278-L360) 里 8 个 `_beforeX/_afterX` 私有方法（本节精讲，共 82 行，8 个方法长得几乎一模一样）

读本节时，建议把这两处并排打开。你会发现一个惊人的事实：**整个「中间件系统」没有任何框架、没有注册表、没有优先级排序、没有生命周期管理器——它就是「一个接口 + 8 个几乎复制粘贴的 for 循环」。** 它的全部威力，来自一个极简到近乎「作弊」的约定。我们这一节就是要说清：**这个约定是什么，为什么它足够，以及为什么「少即是多」。**

---

## 1. 主题内容

### 1.1 先想清楚问题：如果让你来加「审批」，你会怎么改？

老规矩，看代码前先自己当一次设计者。

假设现在 `agent.ts` 里**还没有**任何钩子，主循环就是干干净净的 `_think` → `_act` 循环。产品经理提了三个需求，而且是**陆续**提的：

1. 「`bash` 这种危险命令，执行前得弹窗让用户点『同意/拒绝』。」
2. 「支持技能系统：开跑前扫描 `skills/` 目录，把技能列表注入 system prompt。」
3. 「长任务里模型老忘记更新待办清单，每隔 10 步提醒它一次。」

**最朴素的做法——直接改 `agent.ts`**：

```ts
// _act 里
if (toolUse.name === "bash" || toolUse.name === "write_file") {
  const decision = await askUserForApproval(toolUse);   // 需求1：审批
  if (decision === "deny") { /* 跳过 */ }
}
// stream 开头
this.skills = await scanSkillsDir();                     // 需求2：技能
// _think 里拼 prompt 时
if (this.skills) modelContext.prompt += renderSkills();
// stream 里
if (stepsSinceLastTodoWrite > 10) modelContext.prompt += todoReminder();  // 需求3：待办
```

这么写，三个需求都能实现。但它有几个**致命病灶**：

1. **心脏被反复开胸。** 每来一个新需求，就得改一次 `agent.ts`——这个文件是整个项目最核心、最不该频繁改动的地方。改错一行，整台机器停摆。
2. **通用 Agent 被「编程专用」逻辑污染。** `agent.ts` 是**通用**的 ReAct 循环（第 5 节强调过），它压根不该知道「`bash` 是危险命令」「有个叫 skills 的东西」——这些是 coding 场景（第四部分）才关心的。把它们写进 `agent.ts`，等于让通用大脑绑死了一种用途。
3. **无法组合、无法开关。** 三个需求硬编码在一起，想「这次运行不要审批、只要待办」都做不到，只能靠 `if` 开关堆成一团。
4. **无法复用。** 别人想拿这个 Agent 做「客服机器人」，得先把 coding 相关的 `if` 全删掉。

问题的本质是：**这三个需求，都是「在循环的某个时刻，插入一段额外逻辑」**——需求 1 是「工具执行前」，需求 2 是「整轮开跑前」，需求 3 是「每次调模型前」。它们的**时机不同，但形态一致**。

于是一个经典设计浮现：**把「循环的每个关键时刻」定义成一个具名的『钩子点』，让外部代码以『插件』的形式注册到这些钩子上。核心循环只负责「到点了就喊一嗓子」，至于喊完谁来响应、做什么，核心一概不管。** 这就是**中间件（Middleware）/ 生命周期钩子（Lifecycle Hooks）**模式。

Helixent 的实现，把这个模式做到了**极简的极致**。下面我们先看它定义了哪些「时刻」，再看这些时刻是怎么被「喊」出来的。

### 1.2 全景：4 对钩子，8 个时刻，包住循环的每一层

`AgentMiddleware`（[agent-middleware.ts](../../src/agent/agent-middleware.ts#L80-L139)）定义了 **8 个钩子**，它们**成对出现**，每一对「包住」主循环里的一个层级。先建立空间感：

```
beforeAgentRun ─────────────────────────────────────────┐  ← 一次运行的最外层
  for each step:                                          │
    beforeAgentStep ───────────────────────────────┐     │  ← 每一步的外层
      beforeModel ──────────────────┐              │     │  ← 调模型前
        [ model.stream(...) ]        │  _think      │     │
      （afterModel）─────────────────┘              │     │  ← 调模型后（拿到 assistantMessage）
      if 无工具调用: afterAgentRun ──── return       │     │  ← 运行正常结束
      for each toolUse (并发):                       │     │
        beforeToolUse ──────┐                       │     │  ← 每个工具执行前（可短路！）
          [ tool.invoke ]   │  _act                 │     │
        （afterToolUse）─────┘                       │     │  ← 每个工具执行后
    afterAgentStep ─────────────────────────────────┘     │  ← 每一步的收尾
                                                     ⋯     │
afterAgentRun（无工具时才触发，见下）────────────────────────┘
```

四对钩子，对应四个「作用域」，由外到内：

| 钩子对                                   | 触发时机                                                   | 一句话用途            | 谁在用（本节仅举例）                                         |
| ---------------------------------------- | ---------------------------------------------------------- | --------------------- | ------------------------------------------------------------ |
| `beforeAgentRun` / `afterAgentRun`   | 整轮运行的**最外层**（`stream` 开头 / 正常停机时） | 一次性的准备与收尾    | Skills 在`beforeAgentRun` 扫描技能目录                     |
| `beforeAgentStep` / `afterAgentStep` | **每一步**的首尾                                     | 按步计数、按步注入    | （计步类逻辑）                                               |
| `beforeModel` / `afterModel`         | **调模型**前后                                       | 改 prompt、改模型输出 | Skills / Todos 在`beforeModel` 往 prompt 注入内容          |
| `beforeToolUse` / `afterToolUse`     | **每个工具**执行前后                                 | 拦截工具、观察结果    | 审批在`beforeToolUse` 短路；Todos 在 `afterToolUse` 计步 |

> ⚠️ **一个必须现在就厘清的「作用域嵌套 ≠ 完全对称」问题**：`beforeAgentRun` 和 `afterAgentRun` 看着像一对括号，但它们**并不严格配对**。看主循环（[agent.ts](../../src/agent/agent.ts#L158-L161)）：`afterAgentRun` **只在「模型这一步没有产出任何工具调用、于是正常停机」时才触发**。如果 Agent 是因为「达到 maxSteps 上限」而抛错退出的（[agent.ts](../../src/agent/agent.ts#L166)），`afterAgentRun` **不会被调用**。这一点在 `agent-middleware.ts` 的注释里写得很清楚（[agent-middleware.ts](../../src/agent/agent-middleware.ts#L101-L107)）：「this hook is **not** called if the agent throws (e.g. max steps reached)」。所以别把它当成「一定会执行的 finally」——它是「优雅收尾钩子」，不是「兜底清理钩子」。这个细节深度解释 Q4 会再钉一遍。

下面我们分三步拆：先看**接口长什么样**（1.3），再看**分发逻辑长什么样**（1.4），最后看**那个「返回值即协议」的极简约定**（1.5）以及它最精巧的变体——`beforeToolUse` 的短路（1.6）。

### 1.3 契约：`AgentMiddleware` 接口 —— 全是可选钩子（[agent-middleware.ts](../../src/agent/agent-middleware.ts#L80-L139)）

先看这个接口本身。为省篇幅，我把 8 个钩子的签名压在一起看（完整版见源码）：

```ts
export interface AgentMiddleware {
  beforeAgentRun?:  (p: BeforeAgentRunParams)  => Promise<Partial<AgentContext> | null | undefined | void>;
  afterAgentRun?:   (p: AfterAgentRunParams)   => Promise<Partial<AgentContext> | null | undefined | void>;
  beforeAgentStep?: (p: BeforeAgentStepParams) => Promise<Partial<AgentContext> | null | undefined | void>;
  afterAgentStep?:  (p: AfterAgentStepParams)  => Promise<Partial<AgentContext> | null | undefined | void>;
  beforeModel?:     (p: BeforeModelParams)     => Promise<Partial<ModelContext>  | null | undefined | void>;
  afterModel?:      (p: AfterModelParams)      => Promise<Partial<AssistantMessage> | null | undefined | void>;
  beforeToolUse?:   (p: { agentContext; toolUse }) => Promise<BeforeToolUseResult>;
  afterToolUse?:    (p: AfterToolUseParams)    => Promise<Partial<AgentContext> | null | undefined | void>;
}
```

盯住这几个特征，每一个都是刻意为之：

**特征一：8 个钩子全部带 `?`——全是可选的。** 这意味着一个「中间件」可以只实现自己关心的那一两个钩子，其余不写。审批中间件（[coding-approval-middleware.ts](../../src/coding/permissions/coding-approval-middleware.ts#L19-L43)）就**只实现了 `beforeToolUse`**一个；Todos（[todos.ts](../../src/agent/todos/todos.ts#L119-L139)）只实现了 `beforeModel` + `afterToolUse` 两个。这是「插件按需实现」的基础。

**特征二：全部返回 `Promise<...>`——钩子一律是 async 的。** 这让钩子里可以自由地 `await`（扫目录、读文件、弹审批窗等人回应）。分发时用顺序 `await`（1.4 会看到），保证了「一个钩子彻底跑完，才轮到下一个」。

**特征三：返回类型都是「`Partial<某个东西> | null | undefined | void`」。** 这是整个系统的**灵魂**，1.5 专门讲。先记住这个形状：**要么返回「对某个上下文的部分修改」，要么返回「什么都不改」（几种 falsy）。**

**特征四：每对钩子的「参数」和「返回类型」各不相同，但都围着两个 `Context` 转。** 观察各钩子的 `Params`（[agent-middleware.ts](../../src/agent/agent-middleware.ts#L19-L71)）：

- 大多数钩子的参数里都有 `agentContext: AgentContext`——就是第 5 节那个「贯穿全程的可变上下文」（`prompt` / `messages` / `tools` / `skills`，见 [agent.ts](../../src/agent/agent.ts#L20-L31)）。它是**共享且可变**的（注释原文：`shared, mutable`）。
- `beforeModel` 额外拿到 `modelContext: ModelContext`——即将喂给模型的那份上下文（[model-context.ts](../../src/foundation/models/model-context.ts#L4-L9)），也是本次运行临时拼装的。所以 `beforeModel` 的返回类型是 `Partial<ModelContext>`（改的是模型上下文，比如往 prompt 里加东西）。
- `afterModel` 额外拿到 `message: AssistantMessage`——模型刚吐出的那条消息。所以它的返回类型是 `Partial<AssistantMessage>`（可以改模型的输出）。
- `afterToolUse` 额外拿到 `toolResult: unknown`——工具的原始返回值，供观察。

**「返回类型 = 你能改什么」这个对应关系，是理解每个钩子能力边界的钥匙**：`beforeModel` 返回 `Partial<ModelContext>` 所以能改 prompt；`afterModel` 返回 `Partial<AssistantMessage>` 所以能改模型输出；其余钩子返回 `Partial<AgentContext>` 所以改的是那份贯穿全程的 agent 上下文。**返回什么类型，就只能改什么对象**——类型系统在这里帮你把「每个时刻能动的东西」框得死死的。

### 1.4 分发：8 个「几乎复制粘贴」的 `_beforeX/_afterX`（[agent.ts](../../src/agent/agent.ts#L278-L360)）

契约看完，看它是怎么被「喊」出来的。打开 [agent.ts](../../src/agent/agent.ts#L278-L360)，你会看到 8 个私有方法。它们长得**惊人地像**——像到可以用一个「模板」概括。先看最典型的 `_beforeAgentRun`（[agent.ts](../../src/agent/agent.ts#L298-L306)）：

```ts
private async _beforeAgentRun() {
  for (const middleware of this.middlewares) {
    if (!middleware.beforeAgentRun) continue;
    const result = await middleware.beforeAgentRun({ agentContext: this._context });
    if (result) {
      Object.assign(this._context, result);
    }
  }
}
```

**五行，就是整个中间件系统的心跳。** 逐行读：

1. `for (const middleware of this.middlewares)`——**按数组顺序**遍历所有中间件。`this.middlewares` 就是构造 Agent 时传进来的那个数组（[agent.ts](../../src/agent/agent.ts#L89)），顺序即优先级，没有任何重排。
2. `if (!middleware.beforeAgentRun) continue`——**这个中间件没实现这个钩子？跳过。** 这就是 1.3「全可选」在分发端的落地：没写的钩子等于不存在。
3. `const result = await middleware.beforeAgentRun({...})`——**顺序 `await`** 调用这个钩子，把上下文传进去。顺序 await 意味着**严格串行**：中间件 A 的钩子彻底跑完（包括它内部所有 await），才轮到中间件 B。
4. `if (result) { Object.assign(this._context, result); }`——**如果钩子返回了个 truthy 的东西，就用 `Object.assign` 把它合并进共享上下文。** 返回 falsy（`null`/`undefined`/`void`）就什么都不做。这就是 1.3 特征三那个「返回值即协议」的兑现，1.5 详解。

现在看其余 7 个方法。它们和上面这个模板的差异**小到可以忽略**，只在三处微调：

| 方法                               | 遍历的钩子          | 传入的参数                                | `Object.assign` 的目标                            |
| ---------------------------------- | ------------------- | ----------------------------------------- | --------------------------------------------------- |
| `_beforeAgentRun`                | `beforeAgentRun`  | `{ agentContext }`                      | `this._context`                                   |
| `_afterAgentRun`                 | `afterAgentRun`   | `{ agentContext }`                      | `this._context`                                   |
| `_beforeAgentStep(step)`         | `beforeAgentStep` | `{ agentContext, step }`                | `this._context`                                   |
| `_afterAgentStep(step)`          | `afterAgentStep`  | `{ agentContext, step }`                | `this._context`                                   |
| `_beforeModel(modelContext)`     | `beforeModel`     | `{ modelContext, agentContext }`        | **`modelContext`**                          |
| `_afterModel(message)`           | `afterModel`      | `{ agentContext, message }`             | **`message`**                               |
| `_beforeToolUse(toolUse)`        | `beforeToolUse`   | `{ agentContext, toolUse }`             | `this._context`（**但有短路分支，见 1.6**） |
| `_afterToolUse(toolUse, result)` | `afterToolUse`    | `{ agentContext, toolUse, toolResult }` | `this._context`                                   |

看出来了吗？**除了 `_beforeModel` 合并进 `modelContext`、`_afterModel` 合并进 `message`、`_beforeToolUse` 多了个短路分支，其余全是把同一个模板换个钩子名、换个参数。** 举两个例子对照，你能立刻确认这种「同构」：

`_beforeModel`（[agent.ts](../../src/agent/agent.ts#L278-L286)）——注意 `Object.assign` 的目标变成了 `modelContext`：

```ts
private async _beforeModel(modelContext: ModelContext) {
  for (const middleware of this.middlewares) {
    if (!middleware.beforeModel) continue;
    const result = await middleware.beforeModel({ modelContext, agentContext: this._context });
    if (result) {
      Object.assign(modelContext, result);   // ← 合并进 modelContext，不是 this._context
    }
  }
}
```

`_afterModel`（[agent.ts](../../src/agent/agent.ts#L288-L296)）——目标变成了 `message`：

```ts
private async _afterModel(message: AssistantMessage) {
  for (const middleware of this.middlewares) {
    if (!middleware.afterModel) continue;
    const result = await middleware.afterModel({ agentContext: this._context, message });
    if (result) {
      Object.assign(message, result);   // ← 合并进 message
    }
  }
}
```

**这个「刻意的重复」本身就是一个设计决策。** 你可能会想：8 个方法这么像，为什么不抽象成一个泛型的 `_dispatch(hookName, params, target)`？这是深度解释 Q5 的问题，先埋着。这里只需记住这个心智模型：

> **每一个 `_beforeX/_afterX`，都是「遍历中间件数组 → 跳过没实现的 → 顺序 await 调用 → 把返回的 Partial 合并进对应目标」这同一套动作。核心循环在 8 个时刻分别喊这 8 嗓子，中间件们排队响应。**

### 1.5 灵魂：「返回 `Partial` 则 `Object.assign` 合并，返回空则无操作」的极简协议

现在正式拆这个系统的**灵魂**——那个被 roadmap 点名的「极简协议」：

> **一个钩子如果返回 truthy 的 `Partial<Context>`，它会被 `Object.assign(context, result)` 合并进共享上下文；返回 `null`/`undefined`/`void`（或任何 falsy 值）则表示「无操作」。**

这句话（几乎逐字来自 [agent-middleware.ts](../../src/agent/agent-middleware.ts#L11-L17) 的顶部注释）看着平平无奇，但它用**一个约定**同时解决了「中间件系统」通常要用一堆 API 才能解决的几件事。我们把它掰开：

**它统一了「观察」和「修改」两种意图。** 一个中间件想干的事无非两类：只想「看一眼」（观察，比如计步、打日志），或想「改一改」（修改，比如往 prompt 加东西）。这个协议让两者用**同一个函数签名**表达：

- **只想观察**？那就在钩子里干你的事（比如 `stepsSinceLastWrite++`），**什么都不 return**（返回 `void`）。分发端 `if (result)` 判定为 falsy，`Object.assign` 不执行——完美的「只读」。Todos 的 `afterToolUse` 就是这样（[todos.ts](../../src/agent/todos/todos.ts#L134-L138)）：它只是把计数器归零，不返回任何东西。
- **想修改**？那就 `return` 一个只包含「你要改的字段」的对象。比如 Todos 的 `beforeModel` 想给 prompt 追加提醒，就 `return { prompt: modelContext.prompt + formatReminder(store) }`（[todos.ts](../../src/agent/todos/todos.ts#L130)）。分发端 `Object.assign` 把这个 `{ prompt }` 合并进 `modelContext`，于是 prompt 被更新。

**它是「增量合并」而非「整体替换」。** `Object.assign(target, result)` 的语义是「把 `result` 里出现的字段覆盖到 `target` 上，`result` 里没提到的字段保持不动」。这意味着中间件**只需声明自己关心的那几个字段**，不用把整个 context 复制一遍再改。Todos 只返回 `{ prompt }`，`modelContext` 里的 `messages`/`tools`/`signal` 原样保留。这既省事，又避免了「忘了带某个字段导致它被抹掉」的 bug。

**它天然支持「链式叠加」。** 因为分发是**顺序 for 循环 + 每次都 `Object.assign` 进同一个 target**，多个中间件对**同一个字段**的修改会**依次叠加**。设想 Skills 和 Todos 都想改 `prompt`：Skills 的 `beforeModel` 先跑，把技能列表拼进 `modelContext.prompt`；Todos 的 `beforeModel` 后跑，它读到的 `modelContext.prompt` **已经是 Skills 改过的版本**（因为 `Object.assign` 就地改了同一个对象），于是它在「技能列表 + 原 prompt」的基础上再追加待办提醒。**顺序即叠加顺序**，后面的中间件看到的是前面中间件的成果——这正是「middleware（中间件）」这个名字的本意：**像流水线上串起来的一道道工序，每道工序都在前一道的产物上继续加工。**

**为什么这个协议「够用」？** 因为 Agent 循环里「插件想做的事」，本质上都能归结为「**在某个时刻，对某个共享上下文做一次可选的增量修改**」——注入 prompt 是改 `modelContext.prompt`，加载技能是往 `agentContext.skills` 写数组，改模型输出是改 `message`。一个「可选返回 Partial + Object.assign 合并」的约定，把这些需求**全部**覆盖了。不需要事件发射器、不需要 `next()` 回调、不需要洋葱模型——**一个返回值就是全部 API**。这是「少即是多」的典范，深度解释 Q1 会和 Express/Koa 的洋葱模型对比。

### 1.6 妙笔：`beforeToolUse` 的「短路跳过」信号（[agent.ts](../../src/agent/agent.ts#L338-L350)）

8 个钩子里，有 7 个严格遵循 1.5 的协议：「返回 Partial 则合并，返回空则无操作」。**唯独 `beforeToolUse` 多了第三种可能**——它能返回一个「**别执行这个工具了，用我给的结果顶替**」的**短路信号**。这是 roadmap 特意点名的「妙笔」，也是审批系统（第 15 节）赖以存在的地基。

先看它的返回类型（[agent-middleware.ts](../../src/agent/agent-middleware.ts#L73-L78)）：

```ts
export type BeforeToolUseResult =
  | Partial<AgentContext>                                  // ① 常规：合并进上下文
  | { readonly __skip: true; readonly result: unknown }   // ② 短路：跳过工具执行
  | null | undefined | void;                               // ③ 无操作
```

比其余钩子多出来的，就是那个 `{ __skip: true; result: unknown }` 分支。再看分发端怎么处理它（[agent.ts](../../src/agent/agent.ts#L338-L350)）：

```ts
private async _beforeToolUse(toolUse: ToolUseContent): Promise<{ skip: boolean; result?: unknown }> {
  for (const middleware of this.middlewares) {
    if (!middleware.beforeToolUse) continue;
    const result = await middleware.beforeToolUse({ agentContext: this._context, toolUse });
    if (result && typeof result === "object" && "__skip" in result) {
      return { skip: true, result: result.result };      // ← 短路：立刻返回，后续中间件都不跑了
    }
    if (result) {
      Object.assign(this._context, result);              // ← 常规：和其他钩子一样合并
    }
  }
  return { skip: false };
}
```

对比 1.4 那个模板，多了一段判断，藏着三个关键设计：

**关键一：`"__skip" in result` —— 用一个「魔法字段」区分两种返回意图。** 常规返回是 `Partial<AgentContext>`（一堆业务字段），短路返回是 `{ __skip: true, result }`。分发端靠检测有没有 `__skip` 这个键来区分：**有 `__skip` → 这是短路信号；没有 → 这是常规的上下文合并。** 用一个不太可能和业务字段撞名的 `__skip`（双下划线前缀是「内部/魔法」的惯例）当哨兵，简单而有效。

**关键二：短路会「提前 return」，中断整条中间件链。** 注意那句 `return { skip: true, result: result.result }` ——它**直接从 `_beforeToolUse` 返回了**，`for` 循环就此中断。这意味着：**一旦某个中间件要求跳过，排在它后面的其他中间件的 `beforeToolUse` 就都不会再跑了。** 这个语义很合理：既然这个工具已经被判「不执行」，后面的中间件再对它做手脚也没意义。第一个喊「跳过」的中间件，拥有最终决定权。

**关键三：分发端把「魔法字段」翻译成了「朴素布尔」再交给 `_act`。** 看返回类型：`_beforeToolUse` 对外返回的是 `{ skip: boolean; result?: unknown }`，而**不是**直接把 `{ __skip: true, result }` 抛给调用方。回忆第 6 节 `_act` 里那两句（[agent.ts](../../src/agent/agent.ts#L228-L231)）：

```ts
const beforeResult = await this._beforeToolUse(toolUse);
if (beforeResult.skip) {
  return { index, toolUseId: toolUse.id, toolName: toolUse.name, result: beforeResult.result };
}
```

`_act` 只关心一件事：**skip 是 true 还是 false**。是 true 就别调工具、直接把 `result` 当结果返回；是 false 就正常 `tool.invoke`。**「`__skip` 魔法字段」是「中间件 ↔ 分发器」之间的协议，「`{ skip, result }` 朴素对象」是「分发器 ↔ `_act`」之间的协议——分发器做了一层翻译，把中间件世界的约定，转成 `_act` 世界好懂的布尔。** 这层翻译让 `_act`（第 6 节的并发调度）完全不需要知道 `__skip` 这个魔法字段的存在，职责干净。

**这个短路信号，究竟解决了什么？** 它让中间件有能力**「代替工具作答」**——在工具**根本不执行**的前提下，凭空给出一个结果。审批系统（[coding-approval-middleware.ts](../../src/coding/permissions/coding-approval-middleware.ts#L20-L42)）就是这么用的（本节只展示、不精讲，第 15 节详解）：

```ts
beforeToolUse: async ({ toolUse }) => {
  if (!options.requiresApproval.includes(toolUse.name)) return;   // 无需审批 → 无操作
  const allowed = await loadAllowList(options.cwd);
  if (allowed.has(toolUse.name)) return;                          // 已在白名单 → 放行
  const decision = await options.askUser(toolUse);                // 弹窗，等人点
  if (decision === "deny") {
    return {
      __skip: true,                                               // ← 用户拒绝 → 短路！
      result: `User denied execution of tool: ${toolUse.name}. ...`,
    };
  }
  // allow → 什么都不返回（void）→ 工具正常执行
}
```

读一遍这段逻辑，你会发现它把 1.5 和 1.6 的**三种返回**全用上了：无需审批 / 已白名单 → `return`（void，无操作，工具照跑）；用户拒绝 → `return { __skip: true, result: "拒绝说明" }`（短路，工具不跑，把拒绝说明当结果喂回模型）；用户同意 → 也是不返回（工具照跑）。**审批这个看似复杂的功能，就靠 `beforeToolUse` 的三态返回，在 20 行里干净地实现了，而 `agent.ts` 一个字都不用改。** 这就是 roadmap 说的「中间件是后续一切扩展的插座」的真正含义。

> 一个值得回味的细节：用户拒绝时，短路返回的 `result` 是一段**给模型看的自然语言**（"User denied... You must either find an alternative approach or ask the user for clarification."）。这条文本会经第 6 节的收割逻辑封成 `ToolMessage` 喂回模型，模型下一轮读到「哦，用户拒绝了这个操作，我得换个思路」——**审批的「拒绝」不是硬邦邦的报错，而是变成一条能让模型自我调整的观察**。这又和第 6 节「错误就地捕获成 `Error:` 文本喂回模型」是同一种「让模型看见并自我纠错」的哲学。

### 1.7 串起来：三个真实中间件如何各占其位

理论讲完，我们把本节反复提到的三个真实中间件放在一起，看它们**分别插在哪个钩子、用了协议的哪一面**——这既是对前 6 小节的检验，也是对第 8/9/10/15 节的预告。

**① Skills 中间件（第 9 节精讲，这里只看它插在哪）**（[skills-middleware.ts](../../src/agent/skills/skills-middleware.ts#L32-L116)）用了两个钩子：

- `beforeAgentRun`：整轮开跑前，扫描 `skillsDirs` 目录，把发现的技能 frontmatter 收集成数组，`return { skills }`——**合并进 `agentContext.skills`**（用的是 1.5 的常规修改协议，改的是 `AgentContext`）。
- `beforeModel`：每次调模型前，若 `agentContext.skills` 非空，就把技能列表渲染成一段 XML，`return { prompt: modelContext.prompt + skillsXML }`——**追加进 prompt**（改的是 `ModelContext`）。

**② Todos 系统（第 10 节精讲）**（[todos.ts](../../src/agent/todos/todos.ts#L119-L139)）也用了两个钩子，且展示了「观察」与「修改」的对照：

- `beforeModel`：计数器 `+1`，若「距上次写待办已超过 N 步」，就 `return { prompt: modelContext.prompt + formatReminder(store) }`——**追加提醒进 prompt**（修改）。
- `afterToolUse`：若这次调用的是 `todo_write` 工具，就把计数器归零——**只观察不修改**（`return` void，1.5 说的纯观察）。

**③ 审批中间件（第 15 节精讲）**（[coding-approval-middleware.ts](../../src/coding/permissions/coding-approval-middleware.ts#L19-L43)）只用一个钩子：

- `beforeToolUse`：如 1.6 所述，用「无操作 / 短路」两态实现「放行 / 拦截」。

把它们并排看，中间件系统的「插座」价值就具象了：

```
beforeAgentRun ── [Skills 扫描目录]
beforeModel   ── [Skills 注入技能列表] → [Todos 注入待办提醒]   （顺序叠加同一个 prompt）
beforeToolUse ── [审批 拦截危险工具]
afterToolUse  ── [Todos 重置计步器]
```

**这四个中间件（还有第 8 节的结果处理，虽然它走的是另一条路径）互不知道彼此的存在，却能在同一台 Agent 上和谐共存、按数组顺序叠加生效。** 想加一个新行为？写一个新的 `AgentMiddleware` 对象，塞进 `middlewares` 数组即可（第 11 节的 `createCodingAgent` 就是这么装配的，[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L66-L76)）。`agent.ts` 永远不用动。**这就是本节要证明的命题：一个封闭的循环，靠 8 个钩子 + 一个极简协议，变成了一个开放的平台。**

---

## 2. 亮点与关键设计

1. **「一个可选接口 + 8 个几乎复制粘贴的 for 循环」= 整个中间件系统。**
   没有框架、没有注册表、没有优先级排序、没有洋葱模型。8 个 `_beforeX/_afterX`（[agent.ts](../../src/agent/agent.ts#L278-L360)）都是同一个模板：`遍历 middlewares → 跳过没实现的 → 顺序 await 调用 → Object.assign 合并返回值`。核心循环只负责「到点喊一嗓子」，谁响应、做什么，核心一概不管。极简到近乎「作弊」，却完全够用。
2. **「返回 `Partial` 则 `Object.assign` 合并，返回 falsy 则无操作」——用一个返回值当全部 API。**
   这个协议同时解决了三件事：统一了「观察」（返回 void）与「修改」（返回 Partial）两种意图；是「增量合并」（中间件只声明自己关心的字段）；天然支持「链式叠加」（顺序 for + 就地 Object.assign，后面的中间件看到前面的成果）。不需要事件、不需要 `next()` 回调——**返回值即协议**。
3. **「返回什么类型，就只能改什么对象」——类型系统框定每个钩子的能力边界。**
   `beforeModel` 返回 `Partial<ModelContext>`（能改 prompt），`afterModel` 返回 `Partial<AssistantMessage>`（能改模型输出），其余返回 `Partial<AgentContext>`。分发端对应地把返回值 `Object.assign` 进 `modelContext` / `message` / `this._context` 三个不同目标。类型和分发目标严格对应，让「每个时刻能动什么」一目了然。
4. **`beforeToolUse` 的「短路跳过」信号——审批系统的地基。**
   唯一一个有第三态返回的钩子：`{ __skip: true, result }` 让中间件能「代替工具作答」，在工具根本不执行的前提下凭空给结果。分发端用 `"__skip" in result` 检测、提前 `return` 中断中间件链，并把魔法字段翻译成 `{ skip, result }` 朴素对象交给 `_act`。审批的「同意/拒绝」正是靠「无操作 / 短路」两态在 20 行里实现的，`agent.ts` 一字不改。
5. **4 对钩子「包住」循环的 4 个作用域，但 `afterAgentRun` 刻意不对称。**
   run / step / model / toolUse 四层由外到内嵌套。但 `afterAgentRun` **只在「无工具调用而正常停机」时触发**，达到 maxSteps 抛错退出时**不触发**——它是「优雅收尾钩子」，不是「兜底 finally」。这个不对称是有意的语义选择（深度解释 Q4）。
6. **中间件让「通用大脑」与「场景逻辑」彻底解耦。**
   `agent.ts` 是通用 ReAct 循环，它不知道「`bash` 是危险命令」「有个叫 skills 的东西」——这些 coding 专用逻辑全被隔离在独立的中间件里，通过数组注入。同一个 Agent 换一组中间件就能变成客服机器人。这是第 1 节「严格分层」思想在扩展性维度上的延续。

---

## 3. 工业对比

把 Helixent 的中间件系统与业界几种「给 Agent/请求管线加扩展点」的主流方案放一起看：

| 维度              | Helixent                                                | Express/Koa 中间件                            | LangChain Callbacks            | OpenAI Agents SDK (Hooks/Guardrails)        |
| ----------------- | ------------------------------------------------------- | --------------------------------------------- | ------------------------------ | ------------------------------------------- |
| 扩展点形态        | **8 个具名生命周期钩子**（可选实现）              | 单一`(req, res, next)` 洋葱链               | 十几个`on_xxx` 事件回调      | `RunHooks` 生命周期 + `Guardrails` 拦截 |
| 控制流模型        | 顺序`await` for 循环，**无 `next()`**         | **洋葱模型**：`next()` 显式下探再回溯 | 事件发射（observer），一般只读 | 生命周期回调 + guardrail 可抛出中断         |
| 如何「修改」      | **返回 `Partial` → `Object.assign` 合并**    | 直接改`req`/`res` 对象（副作用）          | 多为只读观察，改动能力弱       | hooks 可改上下文，guardrail 决定放行        |
| 如何「拦截/短路」 | **`beforeToolUse` 返回 `{ __skip, result }`** | 不调用`next()`（洋葱截断）                  | 一般不支持拦截                 | **Guardrail** 触发 tripwire 中断      |
| 复杂度            | **极低**（一个接口 + 8 个 for 循环）              | 中（洋葱语义需理解`next` 前后）             | 高（回调种类多、参数杂）       | 中高（hooks + guardrails 两套机制）         |

几点读法：

- **和 Express/Koa 洋葱模型的最大差异：Helixent 没有 `next()`。** 洋葱模型里，每个中间件通过调用 `next()` 把控制权「下探」给下一层，下一层返回后还能「回溯」执行 `next()` 之后的代码——一个中间件的逻辑被 `next()` 劈成「进」和「出」两半，天生适合「计时、包裹 try/catch」这类需要「前后夹住」的场景，但心智负担也更重（忘了 `await next()` 就出 bug）。Helixent 用**成对的 before/after 钩子**代替了「一个函数里 `next()` 前后两半」：想「前后夹住」？就在 `beforeX` 和 `afterX` 里各写一段。**它把洋葱的「一个函数两阶段」摊平成了「两个函数各一阶段」，牺牲了一点点「共享闭包变量」的便利（其实靠 Todos 那样的模块级闭包也能解决），换来了「无 `next()`、无回溯、纯顺序」的极简心智。** 深度解释 Q1 展开。
- **和 LangChain Callbacks 的差异：Helixent 的钩子能「改」，不只是「看」。** LangChain 的 callback（`on_llm_start` / `on_tool_end` 等）主要面向**观察**（日志、追踪、监控），改动上下文的能力弱。Helixent 的钩子通过「返回 Partial」是**一等的修改手段**——注入 prompt、加载技能、改模型输出都靠它。这是「中间件」与「回调/观察者」的本质分野：前者在管线里**加工**数据，后者在旁边**旁观**数据。
- **和 OpenAI Agents SDK 的差异：Helixent 用「一个钩子的三态返回」统一了 hooks 和 guardrails。** OpenAI SDK 把「生命周期观察」（RunHooks）和「拦截/中断」（Guardrails）做成了**两套**机制。Helixent 则把「观察」（返回 void）、「修改」（返回 Partial）、「拦截」（返回 `__skip`）**压进同一个 `beforeToolUse` 的三态返回里**——概念更少，代价是「拦截」只在工具粒度可用（其他钩子没有短路能力）。对一个「工具执行」才是主要危险源的 coding agent 来说，这个取舍很合理。
- **共同的行业趋势**：无论叫中间件、回调、还是钩子，「**给核心循环留一组具名扩展点，让横切关注点（审批、日志、注入、限流）以插件形式挂上去**」已是 Agent 框架的标配。Helixent 的价值在于用**最少的机制**（一个接口 + Object.assign 约定）覆盖了「观察 / 修改 / 拦截」三种核心需求，是「奥卡姆剃刀」在框架设计上的漂亮示范。

---

## 4. 深度解释：为什么这样设计？不这样会怎样？

**Q1：为什么用「成对 before/after 钩子」而不用 Express/Koa 那种带 `next()` 的洋葱模型？洋葱模型不是更强大吗？**
洋葱模型的强大之处在于：一个中间件函数里，`next()` **之前**的代码在「进入内层前」执行、`next()` **之后**的代码在「内层返回后」执行——两段共享同一个函数闭包，天然适合「开始计时…（下探）…结束计时」「try {（下探）} catch」这类需要用一个变量把前后夹住的场景。但它有三个代价：① **心智负担**——你得时刻记着「`await next()` 前后是两个不同的时空」，忘了 `await` 或忘了调 `next()` 都会出诡异 bug；② **控制流是递归下探再回溯**，调试时栈很深；③ 对 Agent 这种「循环里有很多离散时刻」的场景，硬套「一条洋葱链」并不自然——你很难用「一层洋葱」同时表达「run 级」「step 级」「model 级」「tool 级」四种不同粒度的前后时刻。Helixent 的选择是**把洋葱摊平**：既然「前后夹住」的需求存在，那就直接提供 `beforeX` 和 `afterX` 两个钩子，想夹就在两处各写一段。代价是「前后共享变量」不能再靠函数闭包，得靠中间件对象自己的闭包（看 Todos：`stepsSinceLastWrite` 是 `createTodoSystem` 的闭包变量，`beforeModel` 和 `afterToolUse` 共享它，[todos.ts](../../src/agent/todos/todos.ts#L76-L139)）——但这反而更显式、更好懂。**结论：洋葱模型是「一个函数、两阶段、靠 `next()` 缝合」；Helixent 是「两个函数、各一阶段、靠对象闭包共享状态」。对「多粒度离散时刻」的 Agent 循环，后者更贴合，心智更轻。**

**Q2：`Object.assign(context, result)` 这种「就地修改共享对象」的做法，会不会导致中间件之间互相干扰、难以调试？为什么不用「不可变（immutable）+ 每个中间件返回新 context」？**
会有一点「共享可变状态」的固有风险，但项目用两个约束把它压到了可接受范围。先说风险：因为所有中间件 `Object.assign` 进**同一个** `this._context`/`modelContext`，理论上中间件 B 能覆盖中间件 A 刚写的字段。但实践中这恰恰是**想要的**行为——1.5 讲的「链式叠加」（Skills 写 prompt、Todos 在其基础上再追加）正依赖这种「就地累积」。若改成「不可变 + 每次返回全新 context」，那「叠加」就得靠每个中间件**手动复制上一份再改**（`return { ...ctx, prompt: ctx.prompt + x }`），啰嗦且容易漏字段；而且 `modelContext` 里还有 `signal`（AbortSignal）这种**本就不该被复制**的对象（复制会切断第 5、6 节的取消通道）。**为什么就地修改在这里是安全的**：① 分发是**严格顺序** `await`（1.4），不存在两个中间件并发写同一个 context 的竞态——串行执行让「就地修改」的时序完全可预测；② 中间件数量少（通常 2-4 个）、且各管各的字段（Skills 管 `skills`/`prompt`，审批管 `beforeToolUse`），实际冲突极少。**结论：在「串行执行 + 少量各司其职的中间件」前提下，就地 `Object.assign` 是「简单」压倒「纯粹」的务实选择，还顺带保住了 signal 这类不可复制对象的正确传递。**

**Q3：`beforeToolUse` 用 `"__skip" in result` 来区分「短路」和「常规修改」，为什么不直接让钩子返回一个带 `action: "skip" | "continue"` 字段的结构化对象，岂不更清晰？**
可以，但会牺牲「常规路径」的简洁。当前设计的精髓是**「常规情况零仪式」**：一个只想修改上下文的中间件，直接 `return { skills: [...] }` 就行，和其他 7 个钩子的写法**完全一致**——它不需要知道 `beforeToolUse` 有短路这回事。只有**少数**想短路的中间件（目前就审批一个），才需要用那个特殊的 `{ __skip: true, result }`。如果改成强制返回 `{ action, payload }`，那么**每一个** `beforeToolUse` 都得写 `return { action: "continue", payload: {...} }`，把「绝大多数常规情况」也拖进了「仪式感」里，得不偿失。用 `"__skip" in result` 这个**鸭子类型检测**，让「常规修改」和其他钩子长得一模一样、零负担，只给「短路」这个少数派加一个可辨识的魔法字段——**把复杂度只加在需要它的地方**。这也是为什么 `__skip` 用了双下划线前缀：它是「内部协议字段」，刻意长得不像普通业务字段，降低撞名概率。深度设计上，这和 TypeScript「可辨识联合」的思路一致：用一个特殊标记（这里是 `__skip` 的存在性）来 narrow 出特殊分支。

**Q4：为什么 `afterAgentRun` 只在「无工具调用而正常停机」时触发，达到 maxSteps 抛错时却不触发？这不会导致资源泄漏（比如某个中间件在 beforeAgentRun 里开了资源、指望 afterAgentRun 关）吗？**
这是一个**刻意的语义选择**，不是遗漏。看主循环（[agent.ts](../../src/agent/agent.ts#L149-L170)）：`afterAgentRun` 的调用点在 `if (toolUses.length === 0) { await this._afterAgentRun(); return; }` 里面——它表达的语义是「**Agent 圆满地把任务做完了、主动收工**」。而达到 maxSteps 是 `throw new Error("Maximum number of steps reached")`，属于「**异常退出**」。设计者把 `afterAgentRun` 定位成「**成功收尾钩子**」（做「任务完成后的总结、上报」这类只在成功时才有意义的事），而**不是**「无论如何都会执行的 finally」。`agent-middleware.ts` 的注释明确写了这个契约（[agent-middleware.ts](../../src/agent/agent-middleware.ts#L101-L107)）,把「it is not called if the agent throws」白纸黑字告诉了中间件作者。至于「资源泄漏」——答案是：**真正需要「无论成功失败都清理」的资源，不该依赖 `afterAgentRun`**。看主循环，负责「无论如何都复位」的是 `stream` 的 `finally` 块（[agent.ts](../../src/agent/agent.ts#L167-L170)，复位 `_streaming` / `_abortController`）——那才是「兜底 finally」。中间件如果有必须兜底清理的资源，正确做法是自己在钩子里用 try/finally，或把资源生命周期挂在外部（如 TUI 层）。**结论：`afterAgentRun` 是「优雅收尾」而非「保证清理」，这个区分让「成功时才做的事」和「必须兜底的事」各归其位，避免把两种语义混成一个「看似 finally 实则不是」的陷阱。**

**Q5：8 个 `_beforeX/_afterX` 方法几乎一模一样，为什么不抽象成一个泛型的 `_dispatch(hook, params, target)` 来消除重复？**
技术上完全可以，但项目选择保留这份「刻意的重复」，理由有三。① **8 个方法的差异恰好卡在「不好抽象」的点上**：`_beforeModel` 合并进 `modelContext`、`_afterModel` 合并进 `message`、其余合并进 `this._context`——**合并目标不同**；`_beforeToolUse` 还多一段短路逻辑——**控制流不同**；各钩子的参数结构（`{step}` / `{message}` / `{toolUse, toolResult}`）也不同。硬要抽象成一个 `_dispatch`，就得传入「钩子名（字符串）+ 目标对象 + 参数构造函数 + 是否处理短路」等一堆参数，泛型签名会复杂到**比 8 个朴素方法还难读**，还可能丢失类型安全（钩子名用字符串索引，TS 难以精确推导每个钩子的参数/返回类型）。② **这段代码几乎不变**：8 个时刻是 Agent 循环的稳定骨架，不会频繁增删，「重复」带来的维护成本极低——不是「每次改一处要同步改八处」的那种危险重复。③ **可读性优先**：8 个平铺直叙的小方法，读者扫一眼就懂「哦，这个时刻遍历这个钩子、合并进这个目标」；一个高度泛型化的 `_dispatch` 反而要求读者在脑子里做类型代入。**这是「DRY（不重复）」与「可读性/类型安全」的经典权衡，Helixent 选了后者**——当「消除重复」的抽象比「重复本身」更难懂时，重复就是更好的选择。这和第 20 节「两个渲染器刻意不复用」是同一种审美。

**Q6：中间件是「顺序 await」执行的，如果某个中间件的钩子里有个很慢的 `await`（比如审批要等用户点几十秒），会不会阻塞整个 Agent？这是 bug 还是特性？**
是**特性**，而且是刻意的。审批的本质就是「**停下来，等人类决定**」——在用户点「同意/拒绝」之前，这个工具**本就不该执行**，整个 Agent「卡住」正是我们想要的行为（[coding-approval-middleware.ts](../../src/coding/permissions/coding-approval-middleware.ts#L28) 那句 `await options.askUser(toolUse)` 会一直挂起，直到第 15 节的 Manager 收到用户的响应）。顺序 `await` 分发在这里恰好提供了「**天然的背压（backpressure）**」：慢钩子会让循环等它，而不需要任何额外的暂停/恢复机制。那会不会「误伤」——某个本应快的钩子因为写得烂而拖慢全局？会，但这属于「中间件作者的责任」，框架不该越俎代庖去并发执行钩子（并发反而会破坏 1.5 的「链式叠加」语义——Todos 依赖「Skills 已经改完 prompt」这个前提，若并发，顺序就乱了）。**顺序执行是「链式叠加」和「审批背压」两个特性的共同基石**：正因为串行，后面的中间件才能稳稳看到前面的成果，审批才能「卡住等人」而不需要复杂的挂起机制。想异步「观察」而不阻塞？中间件自己 `void someAsyncLog()`（不 await）即可——把「是否阻塞」的决定权交给中间件作者，框架只保证「按序、逐个、await」这个最可预测的语义。

---

## 5. 参考资料

- 本节主角（契约）：[agent-middleware.ts](../../src/agent/agent-middleware.ts)（`AgentMiddleware` 接口 [L80-139](../../src/agent/agent-middleware.ts#L80-L139)、各钩子 `Params` [L19-71](../../src/agent/agent-middleware.ts#L19-L71)、`BeforeToolUseResult` 短路类型 [L73-78](../../src/agent/agent-middleware.ts#L73-L78)、顶部协议注释 [L7-18](../../src/agent/agent-middleware.ts#L7-L18)）
- 本节主角（分发）：[agent.ts 钩子分发](../../src/agent/agent.ts#L278-L360)（`_beforeModel` [L278-286](../../src/agent/agent.ts#L278-L286)、`_afterModel` [L288-296](../../src/agent/agent.ts#L288-L296)、`_beforeAgentRun` [L298-306](../../src/agent/agent.ts#L298-L306)、`_beforeToolUse` 短路 [L338-350](../../src/agent/agent.ts#L338-L350)）
- 钩子在主循环里的调用点（第 5 节）：[agent.ts stream](../../src/agent/agent.ts#L140-L171)、[agent.ts `_act` 里的 before/afterToolUse](../../src/agent/agent.ts#L228-L234)
- 三个真实中间件（本节仅举例，分别由后续章节精讲）：[skills-middleware.ts](../../src/agent/skills/skills-middleware.ts)（第 9 节）、[todos.ts](../../src/agent/todos/todos.ts)（第 10 节）、[coding-approval-middleware.ts](../../src/coding/permissions/coding-approval-middleware.ts)（第 15 节）
- 中间件的装配现场（第 11 节）：[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L62-L119)
- 被钩子修改的两个上下文：[agent.ts `AgentContext`](../../src/agent/agent.ts#L20-L31)、[model-context.ts `ModelContext`](../../src/foundation/models/model-context.ts#L4-L9)
- MDN · `Object.assign()`（增量合并语义）：[https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/assign](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/assign)
- MDN · `in` 运算符（`"__skip" in result` 的鸭子类型检测）：[https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/in](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/in)
- Koa 中间件 / 洋葱模型（工业对比）：[https://github.com/koajs/koa/blob/master/docs/guide.md](https://github.com/koajs/koa/blob/master/docs/guide.md)
- Express 中间件：[https://expressjs.com/en/guide/using-middleware.html](https://expressjs.com/en/guide/using-middleware.html)
- LangChain Callbacks（观察型扩展点对比）：[https://python.langchain.com/docs/concepts/callbacks/](https://python.langchain.com/docs/concepts/callbacks/)
- OpenAI Agents SDK · Guardrails / Lifecycle（拦截型扩展点对比）：[https://openai.github.io/openai-agents-python/guardrails/](https://openai.github.io/openai-agents-python/guardrails/)
- 上游依赖：[第 5 节 · ReAct 主循环](./05-react-loop.md)、[第 6 节 · 并行工具调度](./06-parallel-tools.md)

---

## 6. 小结与下一节预告

本节我们拆开了第 5、6 节一直当黑盒的那些 `_beforeX/_afterX` 钩子，看清了 Helixent **如何用最少的机制，把一个封闭的循环变成一个可任意扩展的平台**：

- **8 个钩子、4 个作用域**：`beforeAgentRun/afterAgentRun`（整轮）、`beforeAgentStep/afterAgentStep`（每步）、`beforeModel/afterModel`（调模型）、`beforeToolUse/afterToolUse`（每个工具），由外到内嵌套，包住循环的每一层。
- **系统的全部实现**：一个「全可选钩子」的 `AgentMiddleware` 接口 + 8 个「几乎复制粘贴」的分发方法（`遍历 → 跳过没实现的 → 顺序 await → Object.assign 合并`）。没有框架、没有 `next()`、没有注册表。
- **灵魂协议**：「返回 `Partial` 则 `Object.assign` 合并，返回 falsy 则无操作」——用一个返回值统一了「观察 / 修改」，且天然支持「顺序叠加」。返回什么类型就只能改什么对象（`ModelContext` / `AssistantMessage` / `AgentContext`），类型系统框定能力边界。
- **妙笔——短路信号**：`beforeToolUse` 独有的 `{ __skip: true, result }` 让中间件能「代替工具作答」，分发端用 `"__skip" in result` 检测、提前 return 中断链、翻译成朴素布尔交给 `_act`。审批系统靠它在 20 行内实现「同意/拒绝」，`agent.ts` 一字不改。
- **务实取舍**：就地 `Object.assign`（而非不可变）保住了叠加语义和 signal 传递；顺序 `await`（而非并发）提供了「链式叠加」和「审批背压」；8 个方法刻意不抽象（可读性 > DRY）；`afterAgentRun` 刻意不对称（成功收尾 ≠ 兜底清理）。

至此，roadmap 说的那句「**中间件是后续一切扩展的插座**」已经落到了实处——我们不仅看清了插座的形状，还确认了三个真实插件（Skills / Todos / 审批）分别插在哪、怎么用协议的哪一面。

**承上启下（启下）**：插座已经装好，接下来的 [第 8](./00-roadmap.md)、[第 9](./00-roadmap.md)、[第 10 节](./00-roadmap.md)，就是往这个插座上插的三个**具体插件**。它们互不相关、可任意组合，因此可以**并列**学习。按 roadmap 的安排，我们**先从最基础、被所有工具依赖的「结果处理」讲起**——回想第 6 节那个一直当黑盒的 `formatToolResultForMessage`：

> **第 6 节工具返回的五花八门的结果（结构化对象 / `Error:` 字符串 / 裸值），到底是怎么被统一成一段喂给模型的字符串的？一个 `bash("ls -R /")` 可能吐出几万行，如何防止它把模型的上下文窗口直接撑爆？**

这个「结果怎么归一化、怎么按工具分级截断」的问题，就是 [第 8 节](./00-roadmap.md) 的主题。它虽然不走 `beforeToolUse` 这条中间件路径（而是在 `_act` 收割结果时被直接调用），但它和本节一样，是「让 Agent 循环稳健运转」的关键一环。

👉 下一节 **第 8 节：工具结果处理管线 —— normalize / policy / summary**。它会揭开 `formatToolResultForMessage` 这个从第 6 节就反复出现、却一直被当黑盒的函数的全部秘密。

准备好后，对我说「**生成第 8 节**」即可。
