# 第 10 节：Todos 计划模式 —— 工具 + 中间件的组合拳

> 本节属于 **第三部分 · Agent 层（可复用的通用大脑）**，是 [第 7 节](./07-middleware.md) 分岔出的**三个并列插件**中的第三个、也是最后一个。第 7 节把「插座」（中间件系统）看透了；[第 8 节](./08-tool-result-pipeline.md) 讲了第一个插件——工具结果处理管线（从「结果回喂」这一侧给上下文节流）；[第 9 节](./09-skills.md) 讲了第二个插件 Skills（从「能力注入」那一侧给上下文节流）。本节讲第三个插件 Todos，它换了个正交的关注点：**不再是省 token，而是"治理模型的注意力"**——让 Agent 在动辄几十步的长任务里始终记得自己的计划、不跑偏、不忘事。
>
> 对应 roadmap 为本节设定的**核心问题**：
>
> > 如何让 Agent 在长任务中维护一个「待办清单」并保持专注？
>
> **一句边界声明**：本节精讲**一个文件**——待办系统 [todos.ts](../../src/agent/todos/todos.ts)（142 行，绝对主角），外加两个各只有几行的配套文件：类型定义 [todos/types.ts](../../src/agent/todos/types.ts)（7 行）和桶文件 [todos/index.ts](../../src/agent/todos/index.ts)（2 行）。加起来 150 行出头。至于**中间件的钩子分发机制**是 [第 7 节](./07-middleware.md) 的主题（本节直接用它的结论）、**这个工具的结果如何被归一化后回喂给模型**是 [第 8 节](./08-tool-result-pipeline.md) 的主题、**待办清单在终端里怎么渲染成好看的复选框**是 [第 20 节](./00-roadmap.md) 的主题——本节只负责「一个工具和一个中间件如何共享同一份状态、如何协同把'计划'钉在模型眼前」这条主线。

***

## 0. 承上启下

[第 9 节](./09-skills.md) 结尾，我们把 Skills 系统拆干净了，并在收尾时**明确埋下了本节的钩子**。原话是这样的：

> Skills 让 Agent "**会得更多**"……但"会得多"带来一个新问题：**在一个动辄几十步的长任务里，模型很容易"跑偏"或"忘事"**……答案是插在同一个"中间件插座"上的**第三个、也是最后一个插件——Todos 计划模式**。它比前两个插件更进一步：**同时是"一个工具 + 一个中间件"，二者共享同一份闭包状态**；还有一个基于"距上次写入步数"的**智能提醒**机制，专治模型的"注意力涣散"。

这就是本节的定位。而且第 9 节还**预告了一个具体的钩子接力场景**：

> Todos 的中间件同样在 `beforeModel` 注入内容——回想第 7 节 1.5 讲的"链式叠加"：Skills 先改 `prompt`、Todos 在其成果上**再追加**待办提醒。第 10 节你会亲眼看到这两个插件如何在同一个 `modelContext.prompt` 上"接力"。

我们会在 1.6 兑现这个预告。

**先看问题的真实尺度。** 想象一个真实的长任务：用户说「帮我把这个项目的认证从 session 迁移到 JWT」。这不是一步能完成的——它至少涉及：读现有认证代码、设计 JWT 方案、改登录接口、改中间件、改前端存 token 的逻辑、更新测试、更新文档……可能是 **30 步、40 步**的 ReAct 循环。

在这么长的循环里，一个纯靠"对话历史"记忆的模型会出现两种典型退化：

1. **跑偏（drift）**：做到第 20 步改前端时，突然"灵光一现"顺手重构了一个不相关的工具函数，忘了自己本来要干嘛。
2. **忘事（forgetting）**：一开始盘算好了 6 件事，做完第 3 件后，第 4、5、6 件被淹没在几千行工具输出里，再也没被想起。

人类工程师怎么防这两件事？**列一张 TODO 清单，边做边勾。** 清单是一个"外部记忆 + 注意力锚点"：它把"我要做什么"从易失的脑内工作记忆，固化成一份可以随时回看的、结构化的状态。Todos 系统做的就是**把这张纸条塞进 Agent 的循环里**。

但这里有一个第 8、9 节都没遇到过的新挑战：**这张清单是"有状态"的**——它要能被创建、被增量更新、被查询，而且这份状态要在"工具"（模型主动写清单）和"中间件"（框架被动提醒模型）**两个不同的调用入口之间共享**。第 8 节的结果管线是纯函数（无状态），第 9 节的 Skills 状态存在 `agentContext.skills` 里（由框架托管）。Todos 偏偏两者都不是——它的状态既不适合当纯函数，也不适合塞进 `agentContext`（下面 Q2 会讲为什么）。**那这份状态该放哪、由谁持有？** 这正是本节最精彩的设计所在。

打开 [todos.ts](../../src/agent/todos/todos.ts)，我们开始拆。

***

## 1. 主题内容

### 1.1 先想清楚问题：如果让你来做「计划模式」，你会怎么设计？

老规矩，看代码前先自己当一次设计者。需求拆成三个子问题：

**子问题一：清单状态存哪？** 有三个候选：

- **(a) 全局变量 / 模块级变量**：`const store = []` 放在文件顶层。——**否决**：一个进程里如果同时跑两个 Agent（比如未来的多会话），它们会共享同一份清单，互相污染。
- **(b) 塞进 `agentContext`**：像 Skills 那样存 `agentContext.todos`。——看起来合理，但 3.x 和 Q2 会讲为什么这里**故意没这么做**。
- **(c) 闭包私有状态**：用一个工厂函数 `createTodoSystem()`，在函数体里 `const store = []`，让返回的工具和中间件**都闭包捕获这个 `store`**。——**这是 Helixent 的选择**。每调用一次工厂就产生一份全新的、互相隔离的状态；同一次调用产出的「工具」和「中间件」共享同一份。

**子问题二：谁来读写这份清单？** 两个角色：

- **模型（主动写）**：模型决定"我要列个计划"或"我做完一件了"，于是调用一个工具 `todo_write`。**工具是模型的手。**
- **框架（被动提醒）**：如果模型好久没更新清单了（可能在跑偏或忘事），框架应该"戳"它一下："嘿，你的清单还在这儿，要不要更新？"这个"戳"的动作模型自己不会做，得靠中间件在每步 `beforeModel` 时检查并注入提醒。**中间件是框架的嘴。**

**关键洞察就在这里**：一个功能（计划模式）天然需要**两个不同性质的入口**——一个是"模型主动触发的工具"，一个是"框架被动触发的中间件"——**而它们必须操作同一份状态**。这就是本节标题「**工具 + 中间件的组合拳**」的含义：不是两个独立的东西，而是**共享闭包状态的一对孪生组件**。

**子问题三：提醒的时机怎么定？** 不能每步都提醒（烦，且烧 token），也不能从不提醒（那就退化成普通工具了）。合理的策略是：**"距离模型上次更新清单已经过了 N 步"** 才提醒——因为"很久没更新"正是"可能跑偏/忘事"的信号。而且提醒本身也要限流，不能连续每步都提醒。这就是 1.5 要讲的"智能提醒"。

想清楚这三点，下面的代码就全是水到渠成了。我们**自底向上**看：先看清单条目长什么样（类型），再看工厂函数如何用闭包持有状态，然后分别看「工具」和「中间件」两个孪生组件，最后看它们如何协同。

### 1.2 数据形状：`TodoItem` —— 只有三个字段（[todos/types.ts](../../src/agent/todos/types.ts)）

整个类型定义只有 7 行：

```ts
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}
```

一个待办项就三个字段，对应人类 TODO 清单最朴素的样子：

| 字段 | 含义 | 谁产生 |
| --- | --- | --- |
| `id` | 唯一标识符，**增量更新时用它来定位**（1.4 的 `merge` 靠它） | 模型自己编（通常是 `"1"`、`"2"` 这样的序号） |
| `content` | 一句话描述这件待办事项 | 模型 |
| `status` | 四种状态之一（见下） | 模型 |

`TodoStatus` 是一个**四值联合类型**，语义直接对应工作流：

- `pending`：还没开始。
- `in_progress`：正在做（工具描述里强约束**同一时刻只能有一个**）。
- `completed`：做完了。
- `cancelled`：不需要了（比如需求变更，某件事作废）。

⚠️ 注意 `cancelled` 这个状态——它不是"失败"，而是"主动取消/不再需要"。很多简易 TODO 实现只有 `done/undone` 两态，Helixent 特意区分出 `cancelled`，是因为在真实编程任务里"这件事想清楚后发现不用做了"是常态，需要一个能表达"我看到了它、但我决定不做"的状态，而不是把它偷偷删掉（删掉会让模型"忘了自己曾经考虑过它"）。

这个类型简单到近乎"平平无奇"，但请记住它——1.4 的 `merge` 语义、1.5 的提醒渲染，全都建立在这三个字段上。

### 1.3 骨架：`createTodoSystem` 工厂与「闭包共享状态」（[todos.ts](../../src/agent/todos/todos.ts#L75-L142)）

现在进入绝对主角。整个系统的入口是一个**工厂函数**，它的签名一句话就说清了本节标题：

```ts
export function createTodoSystem(): { tool: Tool; middleware: AgentMiddleware } {
  const store: TodoItem[] = [];
  let stepsSinceLastWrite = Infinity;
  let stepsSinceLastReminder = Infinity;

  const tool = defineTool({ /* ... 1.4 讲 ... */ });
  const middleware: AgentMiddleware = { /* ... 1.5 讲 ... */ };

  return { tool, middleware };
}
```

**这短短几行是整节的灵魂，必须逐点钉死。**

**要点 A：返回一个 `{ tool, middleware }` 对。** 呼应 roadmap 的亮点预告——「`createTodoSystem` 同时返回『一个工具 + 一个中间件』」。调用方（[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L62)）这样用：

```ts
const { tool: todoTool, middleware: todoMiddleware } = createTodoSystem();
// ...
const middlewares = [createSkillsMiddleware(skillsDirs), todoMiddleware];  // 中间件进这里
// ...
tools: [ /* ...一堆工具... */, todoTool ],                                 // 工具进这里
```

看清楚了吗？**同一次 `createTodoSystem()` 调用产出的两个东西，被装到了 Agent 的两个完全不同的槽位里**——`todoTool` 进 `tools` 数组（供模型 function-calling），`todoMiddleware` 进 `middlewares` 数组（供框架钩子分发）。它们在 Agent 眼里是两个毫不相关的东西，但它们**私底下共享同一份 `store`**。

**要点 B：三个闭包变量就是"共享状态"。** 函数体一开头声明的三个 `let`/`const`：

- `store: TodoItem[]`——**清单本体**。工具往里写，中间件从里读。
- `stepsSinceLastWrite`——**距上次写清单过了几步**。工具写清单时归零，中间件每步递增。
- `stepsSinceLastReminder`——**距上次提醒过了几步**。中间件提醒时归零、每步递增。

`tool` 和 `middleware` 都是在 `createTodoSystem` 函数体内**定义**的，所以它们**闭包捕获**了这三个变量。这就是 (c) 方案的全部魔法：**不需要任何"状态管理器"、不需要把状态挂到 `agentContext`、不需要全局变量——一个工厂函数的词法作用域，天然就是一个"私有、隔离、共享给内部组件"的状态容器。**

**要点 C：为什么初值是 `Infinity`？** 这是个容易看漏的妙笔。`stepsSinceLastWrite` 和 `stepsSinceLastReminder` 初始都是 `Infinity` 而不是 `0`。想想 1.5 的提醒条件：`stepsSinceLastWrite >= 10`。如果初值是 `0`，那要等 10 步才可能第一次触发；而初值是 `Infinity`，意味着"从一开始就满足'很久没写了'的条件"——**但因为此时 `store` 是空的（`store.length > 0` 不成立），提醒不会真的触发**。等模型第一次写了清单，`stepsSinceLastWrite` 归零，才开始正常计数。`Infinity` 在这里表达的语义是「**"上次写入"发生在'无穷久以前'（即：还没发生过）**」——比用 `0` 或加一个 `hasWritten` 布尔标志都更干净。**用一个数值的极值来编码"事件从未发生"，省掉了一个额外的状态标志。**

**要点 D：为什么是工厂函数而不是 class？** 你可能会想："共享状态 + 多个方法"，这不就是 class 的教科书场景吗？为什么用闭包不用 `class TodoSystem`？原因在 3.x 和 Q1 展开，这里先给结论：因为**产出物要分别塞进两个不同的数组（`tools` 和 `middlewares`），且它们要满足的是两个已有的接口（`Tool` 和 `AgentMiddleware`），而不是"一个 TodoSystem 对象"**。闭包能让状态私有、又能让两个组件各自"长成"它该有的接口形状——这比"暴露一个 class 实例、再从它身上摘出 `.tool` 和 `.middleware`"更贴合使用场景。

### 1.4 工具侧：`todo_write` —— 模型的手（[todos.ts](../../src/agent/todos/todos.ts#L80-L117)）

先看孪生组件的第一个：工具 `todo_write`。它用 [第 4 节](./04-tool.md) 的 `defineTool` 定义，模型通过 function-calling 调用它来"写清单"。

**参数 schema（Zod）**：

```ts
parameters: z.object({
  todos: z
    .array(
      z.object({
        id: z.string().describe("Unique identifier for this todo item."),
        content: z.string().describe("Description of the task."),
        status: z.enum(["pending", "in_progress", "completed", "cancelled"]).describe("Current status."),
      }),
    )
    .describe("Array of todo items to create or update."),
  merge: z
    .boolean()
    .describe(
      "If true, merges into the existing list by id (existing ids updated, new ids appended). If false, replaces the entire list.",
    ),
}),
```

两个参数：一个 `todos` 数组（每一项正好是 1.2 的 `TodoItem` 形状），一个 `merge` 布尔开关。**注意这个 Zod schema 和 1.2 的 TS 类型是"一处定义、两处呼应"**——`z.enum([...])` 的四个值和 `TodoStatus` 完全一致（回想第 4 节：Zod schema 会同时生成给模型看的 JSON Schema 和给 TS 用的类型）。

**`invoke` 实现——`merge` 的两种语义**（[todos.ts](../../src/agent/todos/todos.ts#L99-L116)）：

```ts
invoke: async ({ todos, merge }) => {
  if (merge) {
    for (const item of todos) {
      const idx = store.findIndex((t) => t.id === item.id);
      if (idx >= 0) {
        store[idx] = item;      // ← id 已存在：更新
      } else {
        store.push(item);       // ← id 是新的：追加
      }
    }
  } else {
    store.length = 0;           // ← 全量替换：先清空
    store.push(...todos);       // ← 再灌入新列表
  }

  stepsSinceLastWrite = 0;      // ← 关键：写完归零"距上次写入步数"
  return formatSummary(store);
},
```

这里有三个点要讲：

**点一：`merge=false`（全量替换）vs `merge=true`（增量合并）。** 这是 roadmap 点名的亮点。

- **`merge=false`**：`store.length = 0` 清空 + `push(...todos)` 灌入。**整个清单被新列表替换。** 适合"我要重新规划"或"第一次建清单"。注意 `store.length = 0` 而不是 `store = []`——因为 `store` 是闭包捕获的**同一个数组引用**，不能重新赋值（那会指向新数组、丢掉共享），只能**原地清空**。这是操作共享可变状态时的一个必须注意的细节。
- **`merge=true`**：遍历传入的 `todos`，**按 `id` 定位**：`id` 已存在就**原地更新**那一项，`id` 是新的就**追加**。适合"我只想改第 3 件的状态为 completed，别的别动"——模型**只需传那一件**，不用把整个清单重发一遍。

**点二：为什么增量更新如此重要？** 想象一个 8 件事的清单，模型刚做完第 3 件。如果只有全量替换，模型每次勾掉一件都得把 8 件**原样重发**一遍（还不能抄错任何一件的 `content`）——既烧 token 又容易出错（模型重述长文本时会"手滑"改字）。有了 `merge=true`，它只需发 `{ todos: [{ id: "3", content: "...", status: "completed" }], merge: true }`，**精准、省 token、不会误伤其他项**。这正是工具描述里那句 `You can send only the changed items` 的价值。

**点三：`stepsSinceLastWrite = 0`——工具与中间件的第一个"暗号"。** `invoke` 的倒数第二行把 `stepsSinceLastWrite` 归零。**这行代码是"工具"写给"中间件"的一张纸条**："我刚更新过清单，你（中间件）的提醒计时器该重置了。"因为它俩闭包共享这个变量，工具一改，中间件下次读到的就是新值。**这就是"组合拳"的第一拳落点**——工具通过修改共享变量，间接影响了中间件的行为。（其实 1.5 会看到中间件里还有第二处归零，二者的关系放到 Q3 辨析。）

**返回值：`formatSummary`** —— 工具的 `invoke` 必须返回点东西回喂给模型。这里返回一句人类可读的摘要（[todos.ts](../../src/agent/todos/todos.ts#L55-L64)）：

```ts
function formatSummary(todos: TodoItem[]): string {
  const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
  for (const t of todos) counts[t.status]++;
  const parts: string[] = [];
  if (counts.pending > 0) parts.push(`${counts.pending} pending`);
  if (counts.in_progress > 0) parts.push(`${counts.in_progress} in_progress`);
  if (counts.completed > 0) parts.push(`${counts.completed} completed`);
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`);
  return `Todo list updated. ${todos.length} items: ${parts.join(", ")}.`;
}
```

它统计四种状态各有几个，拼成 `Todo list updated. 8 items: 3 pending, 1 in_progress, 4 completed.` 这样的字符串。**注意它只在某状态计数 `> 0` 时才拼进去**——所以你不会看到 `0 cancelled` 这种噪声。这句摘要会经由 [第 8 节](./08-tool-result-pipeline.md) 的 `formatToolResultForMessage` 归一化后，作为 `tool_result` 回喂给模型，让模型"确认清单已更新、当前概况如何"。**给模型的是摘要（省 token），不是整个清单的 JSON**——又一次呼应第 8 节"上下文是稀缺资源"。

### 1.5 中间件侧：`beforeModel` 智能提醒 + `afterToolUse` 归零（[todos.ts](../../src/agent/todos/todos.ts#L119-L139)）

再看孪生组件的第二个：中间件。它用了 [第 7 节](./07-middleware.md) 的**两个钩子**——`beforeModel`（提醒）和 `afterToolUse`（归零）：

```ts
const middleware: AgentMiddleware = {
  beforeModel: async ({ modelContext }) => {
    stepsSinceLastWrite++;
    stepsSinceLastReminder++;

    if (
      store.length > 0 &&
      stepsSinceLastWrite >= REMINDER_CONFIG.STEPS_SINCE_WRITE &&      // 10
      stepsSinceLastReminder >= REMINDER_CONFIG.STEPS_BETWEEN_REMINDERS // 10
    ) {
      stepsSinceLastReminder = 0;
      return { prompt: modelContext.prompt + formatReminder(store) };
    }
  },

  afterToolUse: async ({ toolUse }) => {
    if (toolUse.name === TODO_WRITE_TOOL_NAME) {
      stepsSinceLastWrite = 0;
    }
  },
};
```

配置常量在文件顶部（[todos.ts](../../src/agent/todos/todos.ts#L11-L14)）：

```ts
const REMINDER_CONFIG = {
  STEPS_SINCE_WRITE: 10,
  STEPS_BETWEEN_REMINDERS: 10,
} as const;
```

**先看 `beforeModel`——"智能提醒"的核心。** 每步调模型前，它做三件事：

1. **两个计数器都 `++`**：`beforeModel` 每步都会被调（回想第 5、7 节：每步 `_think` 都会先跑 `_beforeModel`），所以这两个 `++` 就是"步数在流逝"的心跳。
2. **检查三个提醒条件（`&&`）**：
   - `store.length > 0`：**清单非空才提醒**。空清单提醒毫无意义（这也是 1.3 要点 C 里 `Infinity` 初值能安全存在的原因）。
   - `stepsSinceLastWrite >= 10`：**距上次写清单已经 10 步了**——这是"可能跑偏/忘事"的信号。
   - `stepsSinceLastReminder >= 10`：**距上次提醒也已经 10 步了**——提醒本身的限流，防止连续每步都提醒。
3. **满足则注入提醒**：`stepsSinceLastReminder = 0`（重置提醒计时器），然后 `return { prompt: modelContext.prompt + formatReminder(store) }`——把提醒**追加**到 prompt。

**提醒长什么样？`formatReminder`**（[todos.ts](../../src/agent/todos/todos.ts#L66-L73)）：

```ts
function formatReminder(todos: TodoItem[]): string {
  const lines = todos.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n");
  return `\n<todo_reminder>
The todo_write tool hasn't been used recently. If you're working on tasks that benefit from tracking, consider updating your todo list. Only use it if relevant to the current work. Here are the current items:

${lines}
</todo_reminder>`;
}
```

它把当前清单渲染成一段 `<todo_reminder>` XML，逐行列出 `1. [in_progress] 改登录接口` 这样的条目，**把完整的当前清单重新钉到模型眼前**。措辞也很讲究——`consider updating`（"考虑"更新，不是命令）、`Only use it if relevant to the current work`（"只在相关时才用"）——**这是"温和提醒"而非"强制"**：它把清单摆出来让模型自己判断要不要更新，而不是逼它必须调 `todo_write`。（为什么用温和措辞？Q4 展开。）

**再看 `afterToolUse`——第二处归零。** 每次任意工具调用完成后，中间件检查：如果刚调的是 `todo_write`，就把 `stepsSinceLastWrite = 0`。

等等——1.4 里工具的 `invoke` 结尾**已经**归零过一次了，这里为什么又归零？看似冗余，其实是**双保险**，二者触发时机不同：

- 工具 `invoke` 内的归零：`todo_write` **成功执行**后归零。
- 中间件 `afterToolUse` 的归零：**任何** `todo_write` 调用（哪怕将来 invoke 逻辑改了、或被 `beforeToolUse` 短路跳过又补了结果）走完钩子后归零。

在**当前**代码里，正常调用 `todo_write` 时这两处都会归零，看起来确实重复。**这处"看似冗余"的设计意图和它的利弊，我们诚实地放到 [Q3](#4-深度解释为什么这样设计不这样会怎样) 摊开讲**——我不粉饰成"精心设计的双保险"，也会说清它其实更像"两个自然合理的归零点恰好重叠"。

### 1.6 兑现第 9 节的预告：两个插件在 `modelContext.prompt` 上"接力"

第 9 节结尾预告过："Skills 先改 `prompt`、Todos 在其成果上**再追加**待办提醒。"现在我们有能力把它讲透了。

回忆 [第 7 节](./07-middleware.md) 的钩子分发（[agent.ts](../../src/agent/agent.ts#L278-L286)）：`_beforeModel` **按中间件数组顺序**依次调用每个中间件的 `beforeModel`，每个返回的 `Partial<ModelContext>` 都被 `Object.assign` 合并进**同一个** `modelContext`：

```ts
private async _beforeModel(modelContext: ModelContext) {
  for (const middleware of this.middlewares) {
    if (!middleware.beforeModel) continue;
    const result = await middleware.beforeModel({ modelContext, agentContext: this._context });
    if (result) {
      Object.assign(modelContext, result);   // ← 合并进同一个 modelContext
    }
  }
}
```

而 [lead-agent.ts](../../src/coding/agents/lead-agent.ts#L66) 的中间件顺序是：

```ts
const middlewares = [createSkillsMiddleware(skillsDirs), todoMiddleware];
//                    ↑ 先跑（第 9 节）              ↑ 后跑（本节）
```

于是在某一步 `beforeModel` 分发时，发生了一场**接力**：

```
modelContext.prompt = this.prompt                          （每步从干净的原始 prompt 起算，见第 9 节 1.5）
        │
        ▼  Skills 的 beforeModel 先跑
modelContext.prompt = 原始 prompt + <skill_system>...</skill_system>
        │
        ▼  Todos 的 beforeModel 后跑（读到的 modelContext.prompt 已含 skills）
modelContext.prompt = 原始 prompt + <skill_system>... + <todo_reminder>...</todo_reminder>
```

**关键点：Todos 的 `beforeModel` 里那句 `modelContext.prompt + formatReminder(store)`——它读到的 `modelContext.prompt` 已经是"原始 + skills"了**（因为 Skills 先跑并已 `Object.assign` 进去）。所以 Todos 是**在 Skills 的成果之上追加**，两段注入和平共存于同一个 prompt。这就是第 7 节"链式叠加"最生动的一次落地：**多个中间件像流水线工序一样，在同一个 `modelContext.prompt` 上接力改写，互不知道对方存在，却能有序叠加。**

而且——和第 9 节 Skills 一样——Todos 改的也是**每步新建、用完即弃的 `modelContext.prompt`**（不是持久的 `agentContext.prompt`），所以提醒**每次触发时注入一份，绝不在历史里累积**。这一点第 9 节 1.5 关键点 B 已经详证过，这里 Todos 完全复用了同一个机制，不再赘述。

### 1.7 全景：一次长任务里，工具与中间件如何协同

把工具、中间件、共享状态串成一张时间线图，你就能看清"组合拳"到底怎么打：

```
共享闭包状态：  store=[]   stepsSinceLastWrite=∞   stepsSinceLastReminder=∞
                  │                │                        │
步骤 1 beforeModel │  ++→∞          ++→∞                     store 空 → 不提醒
步骤 1 模型决定列计划 → 调 todo_write(merge=false, [6件事])
        ├─ tool.invoke:   store←[6件]         stepsSinceLastWrite=0   ◄── 工具归零（第一拳）
        └─ afterToolUse:  是 todo_write        stepsSinceLastWrite=0   ◄── 中间件归零（双保险，Q3）
                  │                │                        │
步骤 2 beforeModel │  ++→1          （不满足 ≥10）            不提醒
步骤 3~11 …模型埋头干活，一直没再调 todo_write…
步骤 11 beforeModel│  ++→10         10≥10 且 store 非空 且 11≥10  ►► 注入 <todo_reminder> 6件清单
                  │                stepsSinceLastReminder=0   ◄── 提醒后重置提醒计时器
步骤 11 模型"想起来了" → 调 todo_write(merge=true, [{id:2, completed}])
        └─ 归零 stepsSinceLastWrite=0，计数重新开始……
```

**一句话总括**：**模型用 `todo_write` 工具主动维护清单（写时归零计时器）；中间件在每步 `beforeModel` 数着"距上次写入的步数"，一旦超过阈值就把完整清单重新钉到模型眼前——工具是"手"、中间件是"提词器"，二者共享同一份闭包 `store` 与计数器，合成一套治理注意力的组合拳。**

***

## 2. 亮点与关键设计

明确标注哪些是「妙笔」、哪些是「关键决策」：

1. **【核心妙笔】工具 + 中间件共享闭包状态。** `createTodoSystem` 一个工厂，返回 `{ tool, middleware }`，二者闭包捕获同一份 `store`/计数器。一个功能天然需要"模型主动触发"（工具）和"框架被动触发"（中间件）两个入口，闭包让它们无需任何外部状态管理器就能共享状态——这是整节的灵魂（1.3）。

2. **【关键决策】状态存闭包，而非 `agentContext`，也非全局变量。** 闭包保证了"每次 `createTodoSystem()` 一份隔离状态"（多 Agent 不串味），又避免把 Todos 的私有实现细节泄漏进公共的 `AgentContext`（1.3 要点 D、Q1/Q2）。

3. **【妙笔】计数器初值用 `Infinity` 编码"从未发生"。** `stepsSinceLastWrite = Infinity` 表达"上次写入在无穷久以前（即还没写过）"，配合 `store.length > 0` 守卫，空清单期天然不会误触发提醒——省掉一个 `hasWritten` 布尔标志（1.3 要点 C）。

4. **【关键决策】基于"距上次写入步数"的智能提醒。** 不是每步提醒（烦、烧 token），也不是从不提醒（退化成普通工具），而是"很久没更新才提醒"——因为"久未更新"恰是"跑偏/忘事"的信号。再加一个"距上次提醒步数"做限流，双阈值防止提醒刷屏（1.5）。

5. **【关键决策】`merge` 双语义——增量更新是主角。** `merge=true` 按 `id` 精准更新/追加，让模型"只发改动项"，既省 token 又避免重述长文本时手滑改字；`merge=false` 全量替换用于重新规划（1.4 点一、点二）。

6. **【妙笔】`store.length = 0` 原地清空而非重新赋值。** 因为 `store` 是被工具和中间件共享的**同一个数组引用**，全量替换时只能原地清空再 `push`，绝不能 `store = []`（那会指向新数组、切断共享）——操作共享可变状态的关键细节（1.4 点一）。

7. **【关键决策】提醒用"温和措辞"而非强制。** `consider updating` / `Only use it if relevant`——把清单摆出来让模型自主判断，而不是逼它必调工具。避免"为了更新而更新"的无效调用（1.5、Q4）。

8. **【机制复用】在 `modelContext.prompt` 上与 Skills 接力叠加。** 完全复用第 7 节"链式叠加 + 每步临时上下文"机制：Skills 先注入、Todos 在其成果上追加，两段和平共存、每步重注入却绝不累积（1.6）。

9. **【关键决策】给模型回喂摘要而非整份清单。** `formatSummary` 只回一句"X items: a pending, b completed"，整份清单靠中间件按需注入——延续第 8 节"上下文是稀缺资源"的一贯节流哲学（1.4 点三、返回值）。

***

## 3. 工业对比

对比业界方案的做法与优缺点。

### 3.1 Claude Code 的 `TodoWrite` —— Helixent 的直接对标

Anthropic 的 Claude Code 内置了一个名为 **`TodoWrite`** 的工具，几乎是 Helixent `todo_write` 的原型：同样是"给一个结构化的 todo 数组、每项有 `content` 和 `status`、状态含 `pending/in_progress/completed`、强约束同时只有一个 `in_progress`"。Claude Code 的系统提示词里也有大段"何时该用 todo、何时不该用"的引导（对照 Helixent 工具描述里那段 `## When to Use` / `## When NOT to Use`——[todos.ts](../../src/agent/todos/todos.ts#L16-L53)，几乎是同款措辞）。

**差异在于"提醒机制"。** Claude Code 主要靠系统提示词引导模型"记得更新 todo"，而 Helixent 多做了一层**中间件层面的主动提醒**——用 `stepsSinceLastWrite` 计数、超阈值就把清单重新注入。**这是 Helixent 相对朴素实现的一个增量**：它不完全依赖"模型自觉"，而是给框架加了一个"提词器"。**读懂本节，你就读懂了 Claude Code 计划模式的骨架，还多学了一招"步数触发的提醒"。**

### 3.2 OpenAI Assistants / 函数调用 —— 有工具，无"提醒回路"

用 OpenAI 的函数调用，你完全可以自己定义一个 `update_todos` 函数让模型调用。但**原生 API 里没有"中间件"这一层**——模型调不调、多久调一次，纯靠 prompt 引导和模型自觉。想实现 Helixent 这种"N 步没更新就主动提醒"，你得**自己在应用层的循环里维护计数器、并在每次请求前判断要不要往 messages 里塞提醒**。

**这恰好反向印证了第 7 节中间件系统的价值**：Helixent 把"在每步模型调用前后插入逻辑"抽象成了标准钩子，于是"步数提醒"这种需求变成一个 20 行的中间件，而不是散落在主循环里的 if-else。**没有中间件插座，Todos 的提醒逻辑就无处安放（只能硬编码进 Agent 核心）。**

### 3.3 LangGraph / 状态机 Agent —— 把"计划"提升为一等公民的图节点

LangGraph 这类"图式 Agent"框架走的是另一条路：**把"计划"建模成图里的一个显式节点/状态**。典型的 "Plan-and-Execute" 模式会有一个专门的 `planner` 节点先产出计划、存进 graph state，再由 `executor` 节点逐条执行，甚至有 `replan` 节点在执行偏差时重新规划。

**取舍对比**：

- **LangGraph 方式**：计划是**框架的一等结构**，状态转移显式、可回放、可分支。功能强，但**重**——你得学一套图 DSL、把任务拆成节点、管理 state schema。
- **Helixent 方式**：计划只是**一个普通工具 + 一份闭包状态**，没有独立的"计划节点"，模型在同一个 ReAct 循环里"顺手"维护清单。**轻**——150 行、零新概念（工具和中间件都是你已经会的东西）。代价是计划不是"强制执行"的，模型可以无视清单（靠提醒和 prompt 引导来降低这个风险）。

**一句话**：LangGraph 把计划做成"轨道"（模型必须沿着走），Helixent 把计划做成"便签"（模型自己贴、自己看、框架偶尔提醒）。对 Coding Agent 这种"任务形态高度动态、很难预先建成固定图"的场景，"便签"式的灵活往往比"轨道"式的严格更实用。

### 3.4 一览表

| 方案 | 计划的载体 | 有无"主动提醒" | 状态存放 | 复杂度 |
| --- | --- | --- | --- | --- |
| **Helixent Todos** | 一个工具 + 一个中间件 | ✅ 有（步数触发） | 闭包私有 `store` | 极低（~150 行） |
| Claude Code TodoWrite | 一个内置工具 | ⚠️ 主要靠 prompt | 框架内部 | 低 |
| OpenAI 函数调用 | 自定义函数 | ❌ 需自己在循环里实现 | 应用层自理 | 中（提醒要手写） |
| LangGraph Plan-Execute | 图节点 + graph state | ✅ 有（replan 节点） | 显式 state schema | 高（需建图） |

***

## 4. 深度解释：为什么这样设计？不这样会怎样？

用 Q&A 形式讲清几个"为什么"，以及"不这样会出什么问题"。

### Q1：为什么用「工厂函数 + 闭包」而不是 `class TodoSystem`？

**"共享状态 + 多个操作"确实是 class 的经典场景，但这里的产出形态不适合 class。** 关键在于：Todos 的两个组件**要满足两个已有的、不同的接口**（`Tool` 和 `AgentMiddleware`），并**分别塞进 Agent 的两个不同数组**（`tools` 和 `middlewares`）。

如果写成 class：

```ts
class TodoSystem {
  private store: TodoItem[] = [];
  get tool(): Tool { /* ... */ }
  get middleware(): AgentMiddleware { /* ... */ }
}
const ts = new TodoSystem();
// 使用时还是得摘出来：
tools.push(ts.tool);
middlewares.push(ts.middleware);
```

你会发现：**class 实例 `ts` 本身没人直接用**——所有人要的都是从它身上摘下来的 `.tool` 和 `.middleware`。那 class 这层包装就是纯粹的仪式感。而工厂 + 解构：

```ts
const { tool, middleware } = createTodoSystem();
```

一行到位，直接拿到两个要用的东西，`store` 天然私有在闭包里，**没有一个"没人用的 TodoSystem 对象"在中间碍事**。**当"对象"本身从不作为整体被使用、只是几个组件的容器时，工厂 + 闭包比 class 更贴合。** 这也是函数式风格在 TS 里的一个典型胜场。

### Q2：为什么不把 `store` 存进 `agentContext.todos`（像 Skills 存 `agentContext.skills` 那样）？

**因为那会把 Todos 的私有实现细节泄漏进公共契约。** `AgentContext`（[agent.ts](../../src/agent/agent.ts#L20-L31)）是**所有中间件、甚至 Agent 核心都能看到**的公共对象。Skills 的 `skills` 字段存在那里，是因为它**需要被跨钩子共享**（`beforeAgentRun` 发现、`beforeModel` 消费——见第 9 节），而且它是 Agent 的一个较通用的概念。

但 Todos 的 `store` **只被它自己的工具和中间件用**，没有任何别的组件需要看到它。如果硬塞进 `agentContext.todos`：

1. **污染公共契约**：`AgentContext` 里凭空多一个 `todos?: TodoItem[]` 字段，所有中间件都"看得见但用不上"，概念噪声。
2. **失去隔离**：`agentContext` 是每个 Agent 实例一份，虽然也能隔离多 Agent，但 Todos 的状态和"计数器"（`stepsSinceLastWrite` 等）根本不该是 `AgentContext` 的公共字段——它们是纯粹的实现细节。
3. **闭包已经完美解决**：闭包既给了隔离（每次 `createTodoSystem()` 一份），又给了封装（外界完全看不到 `store`）。**没有任何理由把私有状态提升为公共字段。**

**结论：`agentContext` 存"需要跨组件共享的、较通用的"状态；闭包存"只在一个功能内部共享的"私有状态。** Skills 属于前者，Todos 属于后者。**同一个作者，两个插件，两种状态存放策略，恰恰体现了"按状态的可见范围选择存放位置"的判断力**——这是很值得学的一课。

### Q3：工具 `invoke` 里已经 `stepsSinceLastWrite = 0` 了，中间件 `afterToolUse` 为什么又归零一次？是不是冗余？

**诚实地说：在当前代码路径下，这两处归零确实会同时发生，看起来是冗余的。** 我不把它粉饰成"精心设计的双保险"。更准确的描述是：**这是"两个各自都合理的归零点，恰好在正常路径上重叠了"。**

分别看两处的"独立合理性"：

- **工具 `invoke` 里归零**：站在工具的视角，"我刚成功写完清单，把'距上次写入'重置"是天经地义的——工具对自己造成的状态变更负责。
- **中间件 `afterToolUse` 里归零**：站在中间件的视角，它监听"任何工具用完"事件，判断"如果刚用的是 `todo_write`，就重置计时器"——这是中间件**不依赖工具内部实现**、独立观测到"清单被更新了"这一事实后的合理反应。

**为什么说这不算坏味道**：两处归零**语义一致、结果一致**（都把 `stepsSinceLastWrite` 设 0），所以即便重复也不会产生 bug（幂等）。而且它们体现了两种视角的"防御"：万一将来工具 `invoke` 重构时不小心删了那行归零，中间件的 `afterToolUse` 还能兜住；反之亦然。

**但要批判的话**：这确实是一处"能消掉的重复"——完全可以只保留中间件那处（更符合"中间件负责观测、工具只管干活"的职责划分），或只保留工具那处。当前保留两处，**利是"双保险 + 各自视角自洽"，弊是"读代码的人会疑惑到底哪处才是权威"**。这属于第 9 节 Q4 同款的"可容忍的小重复"——规模小、幂等、无害，知道它存在、知道它可以简化，比纠结"好坏"更重要。

### Q4：提醒为什么用"温和措辞"（consider / only if relevant）而不是强制模型必须更新？

**因为"强制更新"会诱发"为了更新而更新"的无效调用，反而添乱。** 设想提醒写成 `You MUST call todo_write now to update your list`——模型会**条件反射地**去调 `todo_write`，哪怕当前根本没有任何进展值得记录（比如它正卡在读一个大文件的中途）。结果就是：清单被无意义地"重写"一遍、烧 token、还打断了模型正在进行的思路。

温和措辞（`consider updating` / `Only use it if relevant to the current work`）的用意是：**提醒的真正目的不是"逼你写清单"，而是"把清单重新摆到你眼前，防止你忘了它的存在"。** 至于要不要真的更新，交给模型根据当前情境判断。**"重新注入完整清单"这个动作本身**（`formatReminder` 把 6 件事逐条列出）**才是提醒的核心价值**——它对抗的是"忘事"（清单被淹没在历史里）；而"要不要更新"是模型看到清单后的自主决策，不该被强迫。

**不这样（强制）会怎样**：清单更新频率虚高、充斥"和上次一模一样"的无效重写、token 浪费、模型思路被反复打断。**温和提醒是在"防遗忘"和"不打扰"之间找的平衡点。**

### Q5：为什么是"10 步"？这个阈值怎么来的，会不会不合适？

**10 是一个经验性的、写死的常量**（[todos.ts](../../src/agent/todos/todos.ts#L11-L14)），没有自适应逻辑。它背后的权衡是：

- **太小（比如 2 步）**：模型每做两步就被提醒一次，清单反复刷屏，`<todo_reminder>` 频繁注入烧 token，且频繁打断——**过犹不及**。
- **太大（比如 50 步）**：等提醒时模型可能早就跑偏出十万八千里了，提醒来得太晚，失去"及时拉回"的意义。
- **10 步**：大致对应"模型连续做了约 10 个动作还没碰清单"——在编程任务里，这通常意味着它要么在专注做一件大事（那提醒一下无妨，它瞄一眼清单确认没跑偏即可），要么真的忘了清单（那正好拉回来）。**是个"不太吵又不太晚"的折中。**

**会不会不合适？** 会——不同任务的"合理步长"其实不同（简单任务可能 10 步就该做完了，复杂任务 10 步只是刚热身）。**当前实现的局限是"一刀切"**：所有任务、所有清单长度都用同一个 10。**更完善的做法**（当前没做，可作改进）是让阈值随任务规模/清单长度自适应，或做成可配置。但对一个 150 行的教学级实现而言，**"写死 10、双阈值限流"已经能覆盖绝大多数场景**，且简单可预测——这是"简单够用"对"精巧完备"的又一次务实取舍（呼应第 9 节 Q1 的同类判断）。

***

## 5. 参考资料

**本节精讲的源码（一个主角 + 两个配套）**：
- 待办系统（绝对主角）：[todos.ts](../../src/agent/todos/todos.ts)（工厂 [createTodoSystem](../../src/agent/todos/todos.ts#L75-L142)、工具 [todo_write](../../src/agent/todos/todos.ts#L80-L117)、中间件 [beforeModel/afterToolUse](../../src/agent/todos/todos.ts#L119-L139)、[formatSummary](../../src/agent/todos/todos.ts#L55-L64)、[formatReminder](../../src/agent/todos/todos.ts#L66-L73)、[REMINDER_CONFIG](../../src/agent/todos/todos.ts#L11-L14)、[工具描述文案](../../src/agent/todos/todos.ts#L16-L53)）
- 类型定义：[todos/types.ts](../../src/agent/todos/types.ts)
- 桶文件：[todos/index.ts](../../src/agent/todos/index.ts)

**装配与调用链**：
- 库默认装配：[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L62)（`createTodoSystem` 解构）、[L66](../../src/coding/agents/lead-agent.ts#L66)（`todoMiddleware` 进中间件数组，**排在 Skills 之后**）、[L115](../../src/coding/agents/lead-agent.ts#L115)（`todoTool` 进工具数组）

**测试（可作为"可执行的规格说明"对照阅读）**：
- [todos.test.ts](../../src/agent/__tests__/todos.test.ts)（`merge=false` 全量替换 [L9-L21](../../src/agent/__tests__/todos.test.ts#L9-L21)、`merge=true` 按 id 更新 [L23-L40](../../src/agent/__tests__/todos.test.ts#L23-L40)、按 id 追加新项 [L42-L55](../../src/agent/__tests__/todos.test.ts#L42-L55)、四状态计数 [L63-L79](../../src/agent/__tests__/todos.test.ts#L63-L79)、空清单时 `beforeModel` 不提醒 [L83-L90](../../src/agent/__tests__/todos.test.ts#L83-L90)）

**上游依赖章节**：
- [第 4 节 · Tool 工具系统](./04-tool.md)（`todo_write` 是 `defineTool` + Zod schema 定义的工具）
- [第 5 节 · ReAct 主循环](./05-react-loop.md)（`beforeModel` 每步 `_think` 前触发、每步新建 `modelContext`）
- [第 7 节 · Middleware 中间件系统](./07-middleware.md)（`beforeModel`/`afterToolUse` 钩子、按数组顺序分发、`Object.assign` 合并协议、"链式叠加"）
- [第 8 节 · 工具结果处理管线](./08-tool-result-pipeline.md)（`formatSummary` 的返回值经此归一化回喂；"给摘要不给全量"的节流哲学）
- [第 9 节 · Skills 技能系统](./09-skills.md)（同为中间件插件；`modelContext.prompt` 上的"接力叠加"；"每步注入不累积"机制）

**外部资料**：
- Anthropic · Claude Code 的 `TodoWrite` 工具与"计划模式"（本节的直接对标）：<https://docs.anthropic.com/en/docs/claude-code>
- LangGraph · Plan-and-Execute Agent 模式（对比 3.3）：<https://langchain-ai.github.io/langgraph/tutorials/plan-and-execute/plan-and-execute/>
- ReAct 论文（计划/行动/观察的思想源头，第 5 节已引）：<https://arxiv.org/abs/2210.03629>

***

## 6. 小结与下一节预告

本节我们拆开了 Helixent 的 Todos 计划模式，看清了它**如何用 150 行代码、以"一个工具 + 一个中间件"的组合拳，治理模型在长任务里的注意力**：

- **组合拳（核心）**：`createTodoSystem` 工厂返回 `{ tool, middleware }`，二者**闭包共享**同一份 `store` 与计数器。工具 `todo_write` 是"模型的手"（主动写清单），中间件是"框架的提词器"（被动提醒），一个功能的两个天然入口，靠闭包无缝共享状态。
- **状态存放的判断力**：私有状态存**闭包**（隔离 + 封装），而非塞进公共的 `agentContext`（对比 Skills）——按"状态的可见范围"选存放位置（Q1、Q2）。
- **智能提醒**：基于"距上次写入步数"（`stepsSinceLastWrite >= 10`）+ "距上次提醒步数"限流 + "清单非空"守卫的**三条件**触发；用 `Infinity` 初值优雅编码"从未写过"；用**温和措辞**避免"为更新而更新"（1.5、Q4、Q5）。
- **`merge` 双语义**：增量更新（按 `id` 精准改、只发改动项，省 token 防手滑）+ 全量替换（重新规划），是 Todos 好用的关键（1.4）。
- **机制复用**：在 `modelContext.prompt` 上与 Skills **接力叠加**，完整兑现第 9 节的预告——两个中间件像流水线工序，在同一个 prompt 上有序改写、每步重注入却绝不累积（1.6）。
- **一处诚实标注的小重复**：工具与中间件里各有一次 `stepsSinceLastWrite = 0`，我们没粉饰成"精妙双保险"，而是讲清它是"两个自洽视角的重叠"，可简化、但无害（Q3）。

至此，插在第 7 节"中间件插座"上的**三个插件全部讲完**了。回头看这三节的排布之妙：[第 8 节](./08-tool-result-pipeline.md) 从"结果回喂"侧节流、[第 9 节](./09-skills.md) 从"能力注入"侧节流——两者共享"上下文是稀缺资源"的焦虑；而本节 Todos 换了个正交维度——**不省 token，而是治注意力**。**三个插件，两种正交关注点，共用同一个中间件插座、互不知道对方存在却能有序协作**，这正是 roadmap 把它们并列安排、又让本节收尾的深意。

**承上启下（启下）**：到这里，一个**通用**的 Agent 大脑已经彻底完备了——**主循环**（第 5 节）+ **并行调度**（第 6 节）+ **中间件插座**（第 7 节）+ **三大插件**（第 8/9/10 节）。它是一台能思考、能行动、能被扩展的**通用**机器。

但请注意"通用"二字——**它还不是一个"会写代码"的 Agent**。它不知道该配哪些工具（读文件？跑命令？打补丁？），也没有一份"我是一个编程助手、我该怎么在项目里干活"的人设。**把这台通用大脑"特化"成一个专门的 Coding Agent**——给它装上一组编程专用工具、灌入一份精心调校的系统提示词、插上本节和第 8/9 节的三个中间件——是第四部分的任务。

而这一切的"总装线"，就是我们在本节和第 9 节里已经瞥见过很多次的那个工厂函数 `createCodingAgent`（[lead-agent.ts](../../src/coding/agents/lead-agent.ts)）。**它像一张装配总图，把前十节所有零件——模型、工具、中间件——拼成一个成品 Agent。** 这就是 [第 11 节](./00-roadmap.md) 的主题。

> 预告一个悬念：第 11 节你会看到 `createCodingAgent` 里那段 XML 风格的系统提示词——里面藏着 `<tool_usage>` 行为约束、`<notes>` 边界声明，甚至会**自动加载项目根目录的 `AGENTS.md` 当作长期记忆**。通用大脑的"人格"，就是在那里被注入的。

👉 下一节 **第 11 节：Lead Agent —— 系统提示词、工具装配与 AGENTS.md**。

准备好后，对我说「**生成第 11 节**」即可。
