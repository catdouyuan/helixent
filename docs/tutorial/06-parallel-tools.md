# 第 6 节：并行工具调度 —— `Promise.race` 循环 vs `Promise.all`

> 本节属于 **第三部分 · Agent 层（可复用的通用大脑）**，是 [第 5 节](./05-react-loop.md) 的**直接续集**。上一节我们把整颗心脏——ReAct 主循环的**控制流骨架**——看得一清二楚，但在 `_act`（执行工具）那里**故意留了一个占位**，把它当黑盒一带而过。本节的唯一任务，就是钻进这个黑盒，把它彻底拆开。
>
> 对应 roadmap 为本节设定的**核心问题**：
>
> 1. 一次要调多个工具时，怎么**并发**执行？
> 2. 为什么**不用 `Promise.all`** 一把梭？
>
> 还有两个上一节结尾追加的具体疑问，本节一并回答：
>
> 3. 如果一个工具很慢、另一个很快，能不能让「**先完成的先把结果吐出来**」？
> 4. 执行到一半用户按了 Ctrl-C，怎么把**取消**塞进这场并发里？
>
> **一句边界声明**：本节只讲 `_act` 这一个方法（[agent.ts](../../src/agent/agent.ts#L222-L272)，共 51 行）里的**并发调度逻辑**。工具结果被塞进消息前那一步 `formatToolResultForMessage`（截断、归一化、按工具分级）是 [第 8 节](./00-roadmap.md) 的主题，本节只把它当「一个把结果转成字符串的函数」；`_beforeToolUse` / `_afterToolUse` 这两个钩子的完整协议，是 [第 7 节](./00-roadmap.md) 的主角，本节只看 `_act` 怎么调用它们。

***

## 0. 承上启下

[第 5 节](./05-react-loop.md) 在结尾把话递到了这里，而且递得非常具体。当时我们说，主循环里那句 `yield* this._act(toolUses)`（[agent.ts](../../src/agent/agent.ts#L163)）被当成了黑盒——我们只知道它的**三个对外可见的后果**：

> 「它并发跑完工具、把结果封成 `ToolMessage` 追加进 `messages`、并把每条结果作为 `message` 事件吐出。」

但我们**没有拆开它内部是怎么并发的**。第 5 节留下的钩子是：

> **当模型在一步里同时要求调用多个工具时，怎么并发执行它们？为什么不能简单地用 `Promise.all` 一把梭？如果其中一个工具很慢、另一个很快，能不能让「先完成的先把结果吐出来」？执行到一半用户按了 Ctrl-C，又该怎么把取消塞进这场并发里？**

要回答它，我们只需要打开一个方法：[agent.ts](../../src/agent/agent.ts) 里的 `_act`。它虽然只有 51 行，却是**整个项目里唯一一处「手写并发调度」的地方**——其余代码要么是顺序 `await`，要么把并发的复杂度下沉给了别人。正因为它是全项目并发密度最高的一段，值得逐行吃透。

读本节时，请打开这两个文件对照：

- 本节主角：[agent.ts `_act`](../../src/agent/agent.ts#L222-L272)（本节精讲）
- 结果转字符串的辅助函数（第 8 节精讲，这里当黑盒）：[tool-result-runtime.ts `formatToolResultForMessage`](../../src/agent/tool-result-runtime.ts#L100-L143)

先回忆一下 `_act` 是在什么上下文里被调用的。第 5 节的主循环里，每一步都会：

```
_think() → 拿到一条 AssistantMessage
   → 从中抽出所有 tool_use 段（_extractToolUses）
   → 如果一个都没有：停机
   → 如果有一个或多个：yield* _act(toolUses)   ← 我们现在就在这里
```

所以 `_act` 的**输入**是一个 `ToolUseContent[]`——**这一步里模型点名要调的所有工具**（可能一个，也可能好几个）。它的**输出**是一串 `AgentEvent`（具体说是若干个 `message` 事件，每个裹着一条 `ToolMessage`）。中间发生的事，就是本节的全部内容。

***

## 1. 主题内容

### 1.1 先想清楚问题：一步里冒出多个 `tool_use`，你会怎么跑？

老规矩，看代码前先自己当一次设计者。

现代模型（GPT-4o、Claude 3.5+ 等）有一个能力叫 **parallel tool calling**：在**一条** `AssistantMessage` 里，它可以**同时**吐出好几个 `tool_use` 段。比如模型想「一次性了解项目结构」，它可能在一步里同时要求：

```
tool_use #1: read_file("package.json")
tool_use #2: read_file("README.md")
tool_use #3: bash("ls -R src")
```

现在轮到你写 `_act` 了。手里有 3 个 `tool_use`，你有几种写法：

**写法 A —— 顺序 `await`（最朴素）**：

```ts
for (const toolUse of toolUses) {
  const result = await runOneTool(toolUse);   // 一个跑完才跑下一个
  appendAndYield(result);
}
```

问题：3 个工具**串行**。如果 `bash` 要跑 10 秒，两个 `read_file` 各 10 毫秒，用户要干等 10.02 秒——明明这三件事**互不依赖**，完全可以一起跑。太浪费。

**写法 B —— `Promise.all`（最直觉的并发）**：

```ts
const results = await Promise.all(toolUses.map(runOneTool));  // 一起跑
for (const result of results) appendAndYield(result);         // 全跑完，一次性处理
```

这下并发了，总耗时降到 ≈10 秒（取决于最慢那个）。但它有两个隐痛：

1. **`Promise.all` 要等所有工具都完成，才把结果一次性交出来。** 那两个 10 毫秒就完成的 `read_file`，结果要**憋到第 10 秒**、和 `bash` 一起吐出来。用户界面在这 10 秒里看不到任何工具结果的动静——明明有俩早就好了。
2. **取消怎么塞进去？** 用户在第 3 秒按了 Ctrl-C，`Promise.all` 没有内建的「中途放弃」机制，你得额外想办法打断这个 `await`。

**写法 C —— 「谁先完成谁先吐」（Helixent 的选择）**：让三个工具一起跑，但**每完成一个就立刻把它的结果吐出去**，同时把 Ctrl-C 也作为一个「可能先完成的事件」塞进这场赛跑。这样两个 `read_file` 在第 10 毫秒就能把结果吐给 UI，`bash` 第 10 秒再吐它的；而取消随时能打断。

写法 C 正是 `_act` 的实现。实现它的工具，就是 **`Promise.race` + 一个「还没完成」的集合**。下面我们把这个结构拆开看。

> ⚠️ **一个必须现在就点破的认知误区**：很多人以为「`Promise.all` / `Promise.race` 让工具并行」。**大错。** 让工具并发跑起来的，是**把它们全部「点火」这个动作**（下面 1.3 的那个 `.map`）；`Promise.all` / `Promise.race` 只是**在它们已经在跑之后，用不同的策略去「收割」结果**。`all` 是「等全部收完一起给」，`race` 是「谁先好先给谁」。**并发来自点火，不来自收割方式。** 这一点是理解本节的钥匙，深度解释 Q1 会再钉一遍。

### 1.2 全景：`_act` 的「两阶段」结构

`_act` 的 51 行，可以干净地切成**两个阶段**。先建立空间感：

```
_act(toolUses)                             ← async generator，被主循环 yield* 委托
   │
   ├─ signal = 本次运行的取消令牌（来自第 5 节的 _abortController）
   │
   ╭─ 阶段一：发射（fire-off）─────────────────────────────────╮
   │  pending = toolUses.map(async (toolUse, index) => {...})  │
   │     └─ 关键：.map 里是 async 回调，一 map 就同时点火所有工具  │
   │        每个元素是一个 Promise，最终 resolve 成             │
   │        { index, toolUseId, toolName, result }             │
   │  abortPromise = 一个「只会 reject、永不 resolve」的 Promise │
   │     └─ 把 Ctrl-C 变成赛跑里的一名选手                       │
   ╰───────────────────────────────────────────────────────────╯
   │
   ╭─ 阶段二：收割（harvest）─────────────────────────────────╮
   │  remaining = { 0, 1, 2, ... }  ← 还没完成的下标集合         │
   │  while (remaining 非空):                                   │
   │     resolved = await Promise.race(                        │
   │                   [还没完成的那些 pending, abortPromise])   │
   │     ├─ 若 abortPromise 先赢 → reject 冒泡出去（取消）        │
   │     └─ 若某工具先赢：                                       │
   │           remaining.delete(resolved.index)               │
   │           封成 ToolMessage → append 进 messages → yield    │
   ╰───────────────────────────────────────────────────────────╯
```

**阶段一「发射」**：把所有工具一次性点火，得到一组正在并发运行的 Promise（`pending`）；同时造一个代表「取消」的特殊 Promise（`abortPromise`）。

**阶段二「收割」**：反复用 `Promise.race` 从「还没完成的工具」里挑出**最先完成的那一个**，立刻把它的结果封成消息吐出去，直到全部收完。取消令牌 `abortPromise` 也被塞进每一轮 race——它一旦「赢」，就把整个 `_act` 掀翻。

下面按这两个阶段逐段精讲。

### 1.3 阶段一之一：`toolUses.map(async ...)` —— 并发的真正源头（[agent.ts](../../src/agent/agent.ts#L224-L239)）

```ts
const signal = this._abortController?.signal;
const pending = toolUses.map(async (toolUse, index) => {
  try {
    const tool = this.tools?.find((t) => t.name === toolUse.name);
    if (!tool) throw new Error(`Tool ${toolUse.name} not found`);
    const beforeResult = await this._beforeToolUse(toolUse);
    if (beforeResult.skip) {
      return { index, toolUseId: toolUse.id, toolName: toolUse.name, result: beforeResult.result };
    }
    const result = await tool.invoke(toolUse.input, signal);
    await this._afterToolUse(toolUse, result);
    return { index, toolUseId: toolUse.id, toolName: toolUse.name, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { index, toolUseId: toolUse.id, toolName: toolUse.name, result: `Error: ${message}` };
  }
});
```

**先说第一行**：`const signal = this._abortController?.signal`。它把第 5 节那个「贯穿全链路的取消令牌」的 `signal` 取出来，待会儿要往两个地方送：送进每个工具的 `tool.invoke(input, signal)`（让工具能被动中断），也送进 `abortPromise`（让收割循环能主动放弃）。

**核心是 `toolUses.map(async (toolUse, index) => {...})`。** 这一行看着像普通的数组变换，但因为回调是 `async` 的，它做了一件大事：

> **`.map` 一执行，就把所有 async 回调「同步地」逐个启动，每个都一路跑到自己的第一个 `await` 才挂起。** 于是所有工具**几乎同时**进入「在途」状态——这就是并发的**全部来源**。

回忆 JS 的执行语义：调用一个 async 函数，它会**同步执行**到第一个 `await`（这里是 `await this._beforeToolUse(...)` 或更靠后的 `await tool.invoke(...)`），然后返回一个 pending 的 Promise、把控制权交回来。所以 `.map` 遍历 3 个 `toolUse` 时，等于「点火第 1 个（它跑到 await 就挂起）→ 点火第 2 个 → 点火第 3 个」——三把火几乎在同一时刻烧起来，之后各自独立推进。`pending` 就是这三团正在燃烧的火苗（三个 Promise）组成的数组。

> 严格地说，JS 是单线程的，这里是 **I/O 并发**（concurrency）而非 CPU 并行（parallelism）：三个工具的「等待」（等子进程、等文件、等网络）是重叠的。对 `bash` / `read_file` 这类 I/O 密集型工具，效果就是「一起等」，总耗时约等于最慢那个，而不是三者之和。

**每个 pending 任务最终 resolve 成什么？** 一个带四个字段的对象：

```ts
{ index, toolUseId: toolUse.id, toolName: toolUse.name, result }
```

- `index`——**这个任务在原数组里的下标**。它是本节最容易被忽略、却至关重要的一个设计（1.6 会看到：`Promise.race` 只告诉你「谁的值先到」，不告诉你「它是第几个」，所以每个结果必须**自带下标**当身份牌，收割循环才知道该把谁从「还没完成」集合里划掉）。
- `toolUseId`——`toolUse.id`，即第 2 节 `ToolUseContent.id`。它是把「这条结果」和「当初那次调用」对应起来的**关联键**（1.7 封 `ToolMessage` 时要用）。
- `toolName`——工具名，待会儿传给 `formatToolResultForMessage` 好按工具分级截断（第 8 节）。
- `result`——工具的原始返回值（或错误文本，见下）。

注意一个关键事实：**这个 async 回调无论走哪条分支，都是 `return`（正常 resolve），从不 `throw`（reject）。** 这是理解收割阶段的前提，1.4 专门讲。

### 1.4 每个 pending 任务内部：找工具 / 中间件 / 调用 / 就地容错

把 1.3 那段 `try` 块拆成四步看：

**第一步：按名字找到工具**（[agent.ts](../../src/agent/agent.ts#L226-L227)）

```ts
const tool = this.tools?.find((t) => t.name === toolUse.name);
if (!tool) throw new Error(`Tool ${toolUse.name} not found`);
```

模型点名的 `toolUse.name` 是个字符串，得在 `this.tools` 里按名字查出真正的 `Tool` 对象（第 4 节的 `FunctionTool`）。查不到就 `throw`——注意这个 `throw` **不会逃出这个回调**，它会被下面那个 `catch` 就地接住（见第四步）。「模型幻觉出一个不存在的工具名」是真实会发生的事，这里必须兜住。

**第二步：`_beforeToolUse` 中间件钩子 + 「短路跳过」**（[agent.ts](../../src/agent/agent.ts#L228-L231)）

```ts
const beforeResult = await this._beforeToolUse(toolUse);
if (beforeResult.skip) {
  return { index, toolUseId: toolUse.id, toolName: toolUse.name, result: beforeResult.result };
}
```

在真正执行工具**之前**，先过一遍所有中间件的 `beforeToolUse` 钩子。`_beforeToolUse`（[agent.ts](../../src/agent/agent.ts#L338-L350)，第 7 节精讲）会返回 `{ skip: boolean; result?: unknown }`。**如果某个中间件要求跳过**（`skip` 为真），`_act` 就**不调用工具**，直接把中间件给的 `result` 当成这次工具的结果返回。

这个「短路」信号看着不起眼，却是后面一大块功能的地基：**审批系统**（第 15 节）正是靠它实现的——当一个危险操作（如 `bash` 删文件）需要人类确认、而用户点了「拒绝」，审批中间件就通过 `beforeToolUse` 返回一个「跳过 + 一条拒绝说明」，让工具**根本不执行**，同时给模型一条「用户拒绝了」的结果。本节只需记住：**`_act` 在调用工具前留了一个「中间件可以拦下并替我作答」的口子**。

**第三步：真正执行工具 + `_afterToolUse` 钩子**（[agent.ts](../../src/agent/agent.ts#L232-L234)）

```ts
const result = await tool.invoke(toolUse.input, signal);
await this._afterToolUse(toolUse, result);
return { index, toolUseId: toolUse.id, toolName: toolUse.name, result };
```

`tool.invoke(toolUse.input, signal)` 就是第 4 节定义的工具执行入口。**注意第二个参数 `signal`**——第 4 节 `FunctionTool.invoke` 那个「可选的第二参数 `AbortSignal`」，此刻被真正填上了。这意味着：像 `bash` 这种长跑工具，能在内部监听这个 `signal`，一旦取消就 `proc.kill()` 掉子进程（[bash.ts](../../src/coding/tools/bash.ts#L22-L26)）——这正是第 5 节 1.9 描绘的那条「取消通道」在工具端的落点。执行完再过一遍 `afterToolUse` 钩子（第 7 节），最后打包返回。

**第四步：`catch` —— 「就地把错误捕获成 `Error:` 文本」的容错哲学**（[agent.ts](../../src/agent/agent.ts#L235-L238)）

```ts
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  return { index, toolUseId: toolUse.id, toolName: toolUse.name, result: `Error: ${message}` };
}
```

这是 `_act` 里**最能体现设计哲学的四行**。上面三步里任何一处抛错——工具没找到、工具内部炸了、中间件抛异常——都会掉进这个 `catch`。而它的处理方式不是「让错误继续往上抛」，而是：

> **把错误消息转成一个以 `"Error:"` 开头的普通字符串，当作这次工具的 `result` 正常 `return`。**

也就是说，**一个工具的失败，被降级成了「一次带错误文本的正常完成」**。这么做有三层用意：

1. **故障隔离**：3 个工具并发跑，其中 `bash` 炸了，**不能连累**另外两个 `read_file`。如果这里让错误 `throw` 出去、又被收割阶段的 `Promise.race` 捕获，就可能掀翻整个 `_act`、连带主循环崩溃。把错误就地「压」成一个正常结果，保证了「一个工具挂掉，其余照常产出」。
2. **让模型自己看到并处理错误**：这条 `Error: ...` 文本最终会变成一条 `ToolMessage` 喂回模型（下一轮 `_think` 读到）。模型看到「哦，我调的命令报错了」，就能自己决定「换个命令 / 修正参数 / 放弃」——这正是 ReAct「观察→再思考」的闭环价值。如果错误直接崩掉循环，模型**永远没机会自我纠错**。
3. **与下游归一化无缝对接**：这个 `"Error:"` 前缀不是随便选的。第 8 节的 `normalizeToolResult`（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L80-L89)）里有一条专门的分支：`if (typeof result === "string" && result.startsWith("Error:"))`，它会把这种字符串识别成一个「错误类结果」。**`_act` 这里的 `Error:` 约定，和第 8 节的解析约定是一对暗号。**

这与第 4 节工具「宁可返回 `errorToolResult` 也不静默吞错」、第 5 节主循环「宁可 `throw` 也不假装完成」是**同一种诚实哲学的不同侧面**：错误要被如实记录、要能被看见、但**不该让一个局部失败摧毁全局**。

### 1.5 阶段一之二：`abortPromise` —— 把 Ctrl-C 变成赛跑里的一名选手（[agent.ts](../../src/agent/agent.ts#L241-L249)）

```ts
const abortPromise = signal
  ? new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })
  : null;
```

这是本节**第一个「妙笔」**，专治核心问题之四：「怎么把取消塞进并发」。

思路：既然收割阶段要用 `Promise.race` 挑「最先完成的选手」，那我们干脆**造一个专门代表『取消』的选手**塞进赛跑。它平时一直「跑不完」（pending），但用户一按 Ctrl-C，它就**瞬间冲线**——而且是以「摔倒」（reject）的方式冲线，从而让整个 `await Promise.race(...)` 抛错。

逐点看它的精巧之处：

- **`Promise<never>`**——类型标成 `never`，因为这个 Promise **永远不会 resolve（正常完成），只会 reject（出错）**。它的存在意义就是「要么一直挂着，要么摔倒」，从不产出正常值。用 `never` 精确表达了这个语义。
- **`if (signal.aborted) { reject(signal.reason); return; }`**——**先查「是不是已经取消了」**。如果在进入 `_act` 之前用户就按过取消（signal 已 aborted），那就立刻 reject，不必再等监听器。这是处理「取消发生在监听之前」的竞态兜底。
- **`signal.addEventListener("abort", () => reject(signal.reason), { once: true })`**——否则，挂一个**一次性**监听器：signal 一旦 abort，就 reject。`{ once: true }` 保证监听器触发后自动移除，不留垃圾。
- **`reject(signal.reason)`**——注意 reject 的值是 `signal.reason`。这和第 5 节主循环顶端 `throwIfAborted()` 抛出的东西**是同一个** `reason`。于是无论取消是被「循环顶端的哨兵」逮住、还是被「`_act` 里的赛跑」逮住，**外部拿到的异常对象是一致的**——上层（TUI 的 `try/catch`，第 19 节）只需认一种取消异常即可。
- **`: null`**——如果压根没有 signal（`_abortController` 为空的极端情况），`abortPromise` 就是 `null`，收割阶段会走「不带 abort」的那条 race 分支（1.6 会看到）。

一句话：**`abortPromise` 把「一个随时可能发生的外部中断」翻译成了「一个随时可能率先完成的 Promise」**，从而能被 `Promise.race` 这种「挑最快」的机制自然地纳入。这是用 Promise 组合子表达「取消」的经典手法。

### 1.6 阶段二：`Promise.race` + `remaining` 集合的收割循环（[agent.ts](../../src/agent/agent.ts#L251-L271)）

发射完毕，进入本节的**绝对核心**——收割循环：

```ts
const remaining = new Set(pending.map((_, i) => i));
while (remaining.size > 0) {
  const candidates = [...remaining].map((i) => pending[i]);
  const resolved = (await (abortPromise
    ? Promise.race([...candidates, abortPromise])
    : Promise.race(candidates)))!;
  remaining.delete(resolved.index);

  const toolMessage: ToolMessage = {
    role: "tool",
    content: [
      {
        type: "tool_result",
        tool_use_id: resolved.toolUseId,
        content: formatToolResultForMessage({ toolName: resolved.toolName, result: resolved.result }),
      },
    ],
  };
  this._appendMessage(toolMessage);
  yield { type: "message", message: toolMessage };
}
```

**`remaining`：还没完成的下标集合。** `new Set(pending.map((_, i) => i))` 造出 `{0, 1, 2, ...}`——一开始所有下标都「还没完成」。这个 Set 是循环的「进度记账本」，每收割一个就划掉一个，空了就结束。

**`while (remaining.size > 0)`：只要还有没收割的，就继续。** 每一轮做三件事：

1. **挑出「还在场」的选手**：

   ```ts
   const candidates = [...remaining].map((i) => pending[i]);
   ```

   把 `remaining` 里剩下的下标，映射回对应的 pending Promise。**注意：这些是 1.3 里就已经创建、并且一直在后台燃烧的同一批 Promise 对象**，不是新造的（这一点极其重要，深度解释 Q3 会讲「为什么重复 race 它们不会重复执行工具」）。

2. **赛跑，挑出最先完成的一个**：

   ```ts
   const resolved = (await (abortPromise
     ? Promise.race([...candidates, abortPromise])
     : Promise.race(candidates)))!;
   remaining.delete(resolved.index);
   ```

   这是心脏的搏动。`Promise.race([...candidates, abortPromise])` 会返回**这些 Promise 中最先「有结果」的那一个的结果**：

   - 如果某个工具 Promise 先 resolve（记得 1.4：工具 Promise **只 resolve 不 reject**），`race` 就产出它那个 `{index, toolUseId, toolName, result}` 对象。
   - 如果 `abortPromise` 先 reject（用户按了 Ctrl-C），`race` 就**抛出** `signal.reason`——这个异常冒出 `_act`、冒出主循环的 `yield*`、一路上抛，最终被 `stream` 的 `finally` 收尾（复位状态）、被 TUI 的 `try/catch` 接住。**取消，就这样从「一个 Promise 摔倒」变成了「整台机器停机」。**

   拿到 `resolved` 后，`remaining.delete(resolved.index)` 把它划掉。**这里就是 1.3 埋下的 `index` 字段发挥作用的地方**：`Promise.race` 只给你「值」，不给你「它是候选数组里的第几个」，所以只能靠值里自带的 `index` 来定位该划掉谁。

   （末尾那个 `!` 是 TypeScript 的非空断言。因为项目开了 `noUncheckedIndexedAccess`（[tsconfig.json](../../tsconfig.json)），`pending[i]` 的类型被推断为「可能 undefined」，`race` 的结果类型也就带上了 `undefined`；但我们知道 `remaining` 里的下标一定有效，所以用 `!` 告诉编译器「放心，非空」。)

3. **把这一个结果封成 `ToolMessage`，落库 + 吐出**：

   ```ts
   const toolMessage: ToolMessage = {
     role: "tool",
     content: [{ type: "tool_result", tool_use_id: resolved.toolUseId, content: formatToolResultForMessage(...) }],
   };
   this._appendMessage(toolMessage);
   yield { type: "message", message: toolMessage };
   ```

   下一小节专门讲这条消息的形状。这里先记住两个动作：`_appendMessage` 把它**追加进 `this.messages`**（对话历史又长一条——这就是第 5 节说的「结果回流」，供下一轮 `_think` 观察），`yield` 把它作为一个 `message` 事件**吐给主循环**（再经 `yield*` 冒泡到 TUI）。

**这个循环最关键的性质——「完成顺序」而非「调用顺序」**：

假设三个工具耗时是 `read_file`(10ms)、`read_file`(15ms)、`bash`(10s)。收割循环的时间线是：

```
t=10ms:   race 挑出 read_file#1 → 划掉 0 → yield 它的结果消息   （此刻 bash 还在跑！）
t=15ms:   race 挑出 read_file#2 → 划掉 1 → yield 它的结果消息
t=10s:    race 挑出 bash        → 划掉 2 → yield 它的结果消息
          remaining 空 → 循环结束
```

**先完成的 `read_file` 在第 10 毫秒就把结果吐出去了，根本不等 `bash`。** 这正是核心问题之三的答案，也是 1.1 写法 B（`Promise.all`）做不到的——`all` 会把三个结果**憋到第 10 秒一起给**。

而且注意：**当 `while` 循环停在 `await` 上等一个结果时，其余工具并没有被暂停**——它们是 1.3 就点火、一直在后台并发推进的。收割循环只是「站在终点线旁，谁先冲线就登记谁」，它自己的 `await` 完全不拖慢任何一个工具。所以总耗时 ≈ 最慢那个工具（10s），而不是 10+0.01+0.015。

### 1.7 每个结果如何变成一条 `ToolMessage`（而且是「一工具一消息」）

再看 1.6 里那段封装：

```ts
const toolMessage: ToolMessage = {
  role: "tool",
  content: [
    {
      type: "tool_result",
      tool_use_id: resolved.toolUseId,
      content: formatToolResultForMessage({ toolName: resolved.toolName, result: resolved.result }),
    },
  ],
};
```

它构造的是第 2 节的 `ToolMessage`（[message.ts](../../src/foundation/messages/types/message.ts#L46-L51)），内容是一个只含**单个** `tool_result` 段的数组（[content.ts](../../src/foundation/messages/types/content.ts#L59-L66)）。三个字段：

- **`role: "tool"`**——第 2 节四种 role 之一，标明「这是一条工具结果消息」。
- **`tool_use_id: resolved.toolUseId`**——**关联键**。它等于当初那个 `ToolUseContent.id`，把「结果」精确绑回「哪一次调用」。第 2 节讲 `ToolUseContent<T>` 时埋的这个 `id`，此刻兑现了它的用途：模型（和 provider）靠它把乱序到达的结果和当初的调用一一对上。
- **`content: formatToolResultForMessage(...)`**——把原始 `result`（可能是结构化对象、`Error:` 字符串、或裸值）转成**喂给模型的字符串**。这个函数是第 8 节的主题（负责归一化、按工具名分级截断、防止上下文爆炸），本节当黑盒。只需知道：它把五花八门的 `result` 收敛成一个字符串，塞进 `content`。

**一个值得专门点出的设计决策：「一工具一消息」。** 注意 `content` 数组里**只有一个** `tool_result`。也就是说，如果这一步有 3 个工具，`_act` 会产出 **3 条独立的 `ToolMessage`**（每收割一个就造一条、append 一条、yield 一条），而**不是**把 3 个结果塞进一条消息的 content 数组。

为什么这么设计？因为收割是**逐个进行**的——`race` 每次只挑出一个赢家，自然每次只封一条消息。这带来一个好处：**结果能一条一条地流式吐给 UI**，配合 1.6 的「完成顺序」，用户能看到工具结果**陆续**出现，而不是憋到最后一次性刷屏。至于「Anthropic 的 API 要求把多个 tool_result 合并进一条 user 消息」这种**厂商 wire 格式**的差异，是 provider 层（第 16/17 节）在发请求前做转换的事——**内部表示保持「一工具一消息」的简洁，wire 格式的重组下沉给 provider**。这又是第 2 节「wire vs internal 分界」思想的一次体现。

### 1.8 回到主循环：`yield* this._act(...)` 如何把这一切接回去

最后把镜头拉回第 5 节的主循环，确认 `_act` 是怎么被「接」进去的（[agent.ts](../../src/agent/agent.ts#L163)）：

```ts
yield* this._act(toolUses);
```

第 5 节 1.6 讲过 `yield*`（生成器委托）：它把 `_act` 内部 `yield` 的**每一个** `message` 事件，原样透传给主循环的调用方（TUI 的 `for await`）。`_act` 的返回值是 `void`——我们不需要它 return 什么，只需要它的**两个副作用**：

1. 把每条 `ToolMessage` **append 进 `this.messages`**（让下一轮 `_think` 能观察到）；
2. 把每条 `ToolMessage` 作为 `message` 事件 **`yield` 出去**（让 UI 能实时渲染）。

于是第 5 节留下的那个「黑盒」被彻底填平了。现在，整个 ReAct 循环——`_think`（思考）→ `_act`（并发行动）→ 隐式 observe（下一轮读到 append 的结果）——**首尾相接、完整跑通**。

***

## 2. 亮点与关键设计

1. **并发来自「eager map 点火」，`race`/`all` 只是收割策略——本节第一认知。**
   `toolUses.map(async ...)` 一执行就把所有工具同时送入「在途」状态，这才是并发的源头。`Promise.race` 与 `Promise.all` 的区别**只在于如何等待已在运行的结果**：`all` 等全部、按调用顺序一次给；`race` 挑最快、按完成顺序逐个给。看清这点，才不会误以为「换成 all 就不并发了」。

2. **`Promise.race` + `remaining` 集合 = 「谁先完成谁先产出」。**
   用一个「还没完成的下标集合」驱动 `while` 循环，每轮 race 出最快的一个、划掉、封消息、`yield`。结果按**完成顺序**流式吐出，快工具的结果不被慢工具拖累。每个结果自带 `index` 身份牌，解决了「`race` 只给值不给位置」的问题。

3. **把 abort 做成一个「只 reject 的 `Promise<never>`」塞进 race——取消的优雅表达。**
   `abortPromise` 平时永远 pending，Ctrl-C 一到就 `reject(signal.reason)`，从而让 `await Promise.race([...tools, abortPromise])` 抛错、掀翻整个 `_act`、经 `finally` 复位。用 `signal.reason` 保证异常与第 5 节 `throwIfAborted()` 一致。一个中断，被翻译成了「一名随时可能率先冲线的选手」。

4. **工具错误「就地捕获成 `Error:` 文本」而非抛出——故障隔离 + 自我纠错。**
   每个 pending 任务的 `try/catch` 把任何失败降级成一个 `Error:` 前缀的正常结果。好处三重：一个工具挂掉不连累其余并发工具、不崩溃主循环；错误如实喂回模型让它自我纠错（ReAct 闭环）；`Error:` 前缀与第 8 节 `normalizeToolResult` 的解析约定对暗号。

5. **`signal` 一路送进 `tool.invoke(input, signal)`——兑现第 4 节的预留接口。**
   同一个取消令牌既进 `abortPromise`（主动放弃收割），又进每个工具（被动中断子进程，如 `bash` 的 `proc.kill()`）。一个 signal，主动、被动两道防线，落实第 5 节 1.9 那条「贯穿全链路的取消通道」的工具端终点。

6. **「一工具一消息」+ `tool_use_id` 关联——内部表示的简洁。**
   每收割一个结果就封一条独立的 `ToolMessage`（单元素 content），靠 `tool_use_id` 绑回调用。结果得以逐条流式吐给 UI；厂商要求的「多结果合并」交给 provider 层重组，内部保持干净。

***

## 3. 工业对比

把 Helixent 的 `_act` 与业界主流框架处理「一步多工具」的方式放一起看：

| 维度 | Helixent | Vercel AI SDK | OpenAI Agents SDK (Python) | LangChain (`AgentExecutor`) |
| --- | --- | --- | --- | --- |
| 是否并发 | **是**（eager map 点火） | 是（并发执行 tool calls） | 是（`asyncio.gather`） | 视版本：传统偏顺序，新版可并行 |
| 收割策略 | **`Promise.race` 循环**（完成顺序，逐个 yield） | 收集后统一返回（≈ `all`，调用顺序） | `gather`（≈ `all`，调用顺序） | 汇总后统一处理 |
| 结果何时可见 | **每完成一个立即 yield** 一条消息事件 | `onStepFinish`，一步的工具全完才回调 | 一步的工具全完后进入下一轮 | 一步全完后继续 |
| 单个工具失败 | **就地捕获成 `Error:` 文本**，不连累其余 | tool 抛错可被捕获为 tool error 结果 | 工具异常按错误结果处理 | 由 executor / handler 处理 |
| 取消/中断 | **abort 做成 `Promise<never>` 塞进 race** + signal 透传工具 | `abortSignal` 透传 | 取消/超时机制 | 靠外部控制，较分散 |
| 结果消息形态 | 内部「一工具一消息」，wire 重组交给 provider | 框架内部管理 | framework 管理 | framework 管理 |

几点读法：

- **「并发执行多工具」是行业共识，差异在「怎么收割」。** 绝大多数框架（Vercel AI SDK、OpenAI Agents SDK）用的是 `Promise.all` / `asyncio.gather` 这类「等全部、按调用顺序一次给」的收割方式——实现简单、结果有序，但**无法在一步内让快工具的结果先冒出来**。Helixent 特意选了 `race` 循环，换取「完成顺序、逐个流式吐出」的**实时反馈**能力。这与它「一切皆流、调用方掌握节奏」的整体气质（第 5 节的 pull 模型）是一脉相承的。
- **值得诚实说明「race 的收益边界」**：因为主循环要等 `_act` **整个**结束才进行下一轮 `_think`，所以「完成顺序 yield」**并不会让模型更早看到部分结果、更不会缩短这一步的总耗时**（总耗时仍≈最慢工具）。它的收益是纯粹的 **UI/UX**：终端能看到工具结果**陆续**刷出，而不是卡住 10 秒再一次性刷屏。用 `Promise.all` 功能上完全正确，只是「不够跟手」。理解这一点，才不会神化 `race`（深度解释 Q2 展开）。
- **取消的「组合子表达」是个漂亮范式。** 把 abort 建模成「一个会 reject 的 Promise，参与 race」，是 JS 里表达可取消并发的经典手法。相比之下，一些框架把取消揉在各处的 `if (cancelled)` 检查里，较分散。Helixent 用一个 `Promise<never>` 把它收拢成「赛跑里的一名选手」，干净且统一。
- **故障隔离靠 `try/catch`，不靠收割方式——一个常见误解的澄清。** 有人以为「用 `Promise.all` 会因为一个工具失败而丢掉全部结果，所以要用 `race`」。这在 Helixent 里**不成立**：因为工具 Promise 被 `try/catch` 包成「只 resolve 不 reject」，即便用 `Promise.all` 也不会因单个失败而整体 reject。**故障隔离来自 1.4 的就地捕获，与 race/all 的选择正交。** race 解决的是「顺序与流式」，不是「容错」。

***

## 4. 深度解释：为什么这样设计？不这样会怎样？

**Q1：并发到底是 `Promise.race`（或 `Promise.all`）带来的吗？如果我把 `race` 换成顺序 `await`，工具还并发吗？**
并发**不是** `race`/`all` 带来的，而是 1.3 那句 `toolUses.map(async ...)` 带来的——`.map` 一跑，所有 async 回调就被同步启动、各自跑到第一个 `await` 挂起，所有工具由此**同时在途**。`race`/`all` 只是在「它们已经在跑」之后，用不同策略去**等结果**。所以：只要你**先把所有 Promise 都创建出来**（`pending = toolUses.map(...)`），再逐个 `await pending[i]`，工具**依然是并发的**（你只是按固定顺序去收而已）。真正会**毁掉并发**的写法是「创建一个、await 一个、再创建下一个」（1.1 的写法 A）——那才是顺序执行。一句话：**并发看「何时创建 Promise」，收割方式只看「如何等待已创建的 Promise」。**

**Q2：既然 race 不缩短总耗时、也不改变模型看到结果的时机，为什么还要用它，不图省事用 `Promise.all`？**
因为它买的是**终端的实时反馈**，这在一个真人盯着看的 CLI 里价值很高。设想 `bash("npm test")` 要跑 30 秒、同时有两个 `read_file` 各几毫秒：用 `Promise.all`，用户会盯着一个「Running…」卡整整 30 秒，中途**毫无动静**，体验像「死机」；用 `race` 循环，两个 `read_file` 的结果在几毫秒内就刷出来了，用户立刻知道「哦它读了这俩文件，正在等测试」，30 秒的等待就有了着落。功能上 `all` 完全正确（结果最终一样、模型看到的历史也一样），但 `race` 让**过程可见**。这与第 5 节主循环选择「吐 progress 事件」是同一个动机：**Agent 跑得久，过程必须被观察。** 代价是代码比 `await Promise.all(...)` 复杂了十几行——项目认为这个交换值得。

**Q3：收割循环每一轮都拿「还没完成的 pending」重新 `Promise.race` 一遍。已经跑过的工具会不会被重复执行？重复 race 有性能问题吗？**
不会重复执行，也几乎没有额外开销——这依赖 JS Promise 的两个铁律：**① Promise 只 settle 一次；② 对一个已 settle 的 Promise 再 `await`/再 race，立刻拿到缓存的结果，不会重跑产生它的代码。** `pending` 里的每个 Promise 对应「一次工具执行」，工具的实际工作（`tool.invoke`）在 1.3 点火时就发生了、只发生一次。收割循环里 `candidates = [...remaining].map(i => pending[i])` 拿到的是**同一批 Promise 对象的引用**，不是新建的。所以「重复 race」只是「重复地对同一批 Promise 挂监听等它们 settle」，已经 settle 的那些会被 `remaining.delete` 排除在下一轮 `candidates` 之外，根本不参与后续 race。开销仅是每轮重建一个小数组 + 重新 race 剩余项，对「一步最多几个工具」的规模完全可忽略。

**Q4：为什么工具错误要「就地 `catch` 成 `Error:` 字符串」，而不是让它 `throw`、在外面统一处理？**
因为 `throw` 在这个并发场景里会引发连锁破坏。假设不 catch，让工具 Promise 直接 reject：那么收割循环里 `await Promise.race([...candidates, abortPromise])` 会**抛出**这个 reject——而这个抛出和「用户取消」的抛出**长得一模一样**，收割循环无法区分「是某工具失败了」还是「用户按了 Ctrl-C」，只能一律当致命错误掀翻 `_act`。结果就是：**3 个工具里 1 个失败，另外 2 个已经跑完或即将跑完的结果全被丢弃，整轮甚至整个循环崩溃。** 就地 catch 把失败降级成「一次正常完成、只是结果是错误文本」，于是：失败工具照样产出一条 `ToolMessage`（内容是 `Error: ...`）、其余工具不受影响、模型下一轮能读到错误并自我纠错。这就是 1.4 说的「故障隔离 + 自我纠错」。至于为什么偏偏用 `Error:` 前缀——因为第 8 节的 `normalizeToolResult` 靠这个前缀识别错误结果（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L80-L89)），两处是约定好的暗号。

**Q5：`abortPromise` 为什么要写成 `Promise<never>` 并用 `signal.reason` 来 reject？取消真正发生时，数据流是怎么走的？**
`Promise<never>` 精确表达了它的语义——**它永远不产出正常值**，只有两种命运：一直 pending，或 reject。写成 `never` 让类型系统知道「这个 Promise 不会给你一个 `{index,...}` 结果」，从而 `Promise.race([...tools, abortPromise])` 的结果类型仍是工具结果的类型（abort 分支只会走异常通道，不污染正常值类型）。用 `signal.reason` reject，则是为了**和第 5 节主循环顶端 `throwIfAborted()` 抛出的异常保持同一个对象**——这样上层只需认识一种「取消异常」。取消真正发生时的数据流是：`Agent.abort()` → `signal` 触发 abort 事件 → `abortPromise` 的监听器 `reject(signal.reason)` → 正在 `await` 的 `Promise.race` 抛出 reason → 异常冒出 `_act`（一个 async generator，异常会从当前 `yield`/`await` 处抛出）→ 冒出主循环的 `yield* this._act(...)` → 冒出 `stream` 的 `for` 循环 → 触发 `stream` 的 `finally`（复位 `_streaming` / `_abortController`）→ 最终被 TUI 的 `try/catch` 接住展示。**与此同时**，`signal` 也早已透传给每个在途工具的 `tool.invoke(input, signal)`，所以像 `bash` 这类工具会在内部收到 abort、`proc.kill()` 掉子进程——**主动放弃收割**（abortPromise）和**被动中断工具**（signal 进 invoke）两条线同时生效，取消才干净彻底。

**Q6：为什么每个工具结果单独封一条 `ToolMessage`，而不是把一步里所有结果塞进一条消息的 content 数组？这在对接不同厂商时不会出问题吗？**
内部选「一工具一消息」，首先是**实现的自然结果**：收割循环每次 `race` 只挑出一个赢家，就地封一条、yield 一条，天然就是逐条的——这也正好支撑了 1.6 的「完成顺序流式吐出」（若要合并成一条，就得等全部完成才封，退化成 `Promise.all` 的体验）。至于厂商差异：OpenAI 的 wire 格式本就是「一个 `tool_call_id` 对应一条 `role:"tool"` 消息」，与内部表示天然一致；Anthropic 则要求「把同一轮的多个 `tool_result` 合并进一条 `role:"user"` 消息」——但**这种重组是 provider 在发请求前做的**（第 16/17 节的 `convertTo...Messages`），内部的 `messages` 数组保持「一工具一消息」的简洁，发出去前再按厂商要求打包。这正是第 2 节反复强调的 **wire 格式 vs 内部表示** 分界：**内部只维护一种最干净的形状，各家 API 的怪癖统统隔离在 provider 层。** 所以不但不会出问题，反而让内部逻辑免受厂商格式的污染。

***

## 5. 参考资料

- 本项目源码：[agent.ts `_act`](../../src/agent/agent.ts#L222-L272)（`pending` 发射 [L224-239](../../src/agent/agent.ts#L224-L239)、`abortPromise` [L241-249](../../src/agent/agent.ts#L241-L249)、收割循环 [L251-271](../../src/agent/agent.ts#L251-L271)）
- 下游（第 8 节精讲，本节当黑盒）：[tool-result-runtime.ts `formatToolResultForMessage`](../../src/agent/tool-result-runtime.ts#L100-L143)、`normalizeToolResult` 的 `Error:` 识别分支 [L80-89](../../src/agent/tool-result-runtime.ts#L80-L89)
- 中间件钩子（第 7 节精讲）：[agent.ts `_beforeToolUse`](../../src/agent/agent.ts#L338-L350)、[agent-middleware.ts `BeforeToolUseResult`](../../src/agent/agent-middleware.ts#L73-L78)
- 工具端的 signal 落点：[bash.ts](../../src/coding/tools/bash.ts#L22-L26)（`proc.kill()` 响应 abort）
- 消息与内容类型（第 2 节）：[message.ts `ToolMessage`](../../src/foundation/messages/types/message.ts#L46-L51)、[content.ts `ToolResultContent` / `ToolUseContent`](../../src/foundation/messages/types/content.ts#L45-L66)
- MDN · `Promise.race()`：<https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/race>
- MDN · `Promise.all()`：<https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all>
- MDN · `AbortController` / `AbortSignal.reason`：<https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/reason>
- MDN · async function 的执行语义（同步执行到首个 `await`）：<https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function>
- Vercel AI SDK · 并行工具调用（parallel tool calls）：<https://sdk.vercel.ai/docs/ai-sdk-core/tools-and-tool-calling>
- OpenAI Agents SDK (Python) · 工具并行执行（`asyncio.gather`）：<https://openai.github.io/openai-agents-python/tools/>
- 上游依赖：[第 2 节 · Message 消息类型系统](./02-message.md)、[第 4 节 · Tool 工具系统](./04-tool.md)、[第 5 节 · ReAct 主循环](./05-react-loop.md)

***

## 6. 小结与下一节预告

本节我们钻进第 5 节故意留下的 `_act` 黑盒，把整个项目里**唯一一处手写并发调度**看透了：

- **两阶段结构**：先「发射」（`toolUses.map(async ...)` 一次性点火所有工具，得到一组并发在途的 Promise），再「收割」（`while` + `Promise.race` 从「还没完成的集合」里逐个挑出最快的）。
- **并发的真正来源**：是 eager map 的点火，**不是** `race`/`all`。`race` 与 `all` 只是收割策略之别——`all` 等全部、按调用顺序一次给；`race` 挑最快、按**完成顺序**逐个给。Helixent 选 `race` 循环，为的是终端能**实时**看到工具结果陆续刷出。
- **取消的优雅表达**：把 abort 做成一个「只 reject 的 `Promise<never>`」塞进每一轮 race，Ctrl-C 一到就 `reject(signal.reason)`、掀翻 `_act`、经 `finally` 复位；同时 `signal` 也透传进每个 `tool.invoke`，主动放弃与被动中断双线并行。
- **容错哲学**：每个工具 `try/catch` 就地把错误压成 `Error:` 文本当正常结果——故障隔离（不连累并发同伴、不崩主循环）、自我纠错（错误喂回模型）、与第 8 节的解析约定对暗号。
- **结果落地**：每收割一个就封一条独立 `ToolMessage`（`tool_use_id` 关联回调用），`_appendMessage` 进历史 + `yield` 给 UI；厂商 wire 格式的合并交给 provider 层。
- **回收前几节的钩子**：`signal` 兑现了第 4 节 `invoke` 的第二参数、落实了第 5 节的取消通道；`ToolMessage` / `tool_use_id` 建立在第 2 节的类型之上；`_before/_afterToolUse` 是第 7 节的引子。

至此，**第 5 节的 `_act` 占位被彻底填平，ReAct 主循环首尾贯通、能完整跑通了**——`_think` 思考、`_act` 并发行动、下一轮隐式观察，一台会自主干活的机器已经成型。

**承上启下（启下）**：但这台机器目前是「**封闭**」的。回看 `_act`：它在执行工具前后硬编码地调用了 `_beforeToolUse` / `_afterToolUse`；主循环里也散落着 `_beforeAgentRun` / `_beforeAgentStep` / `_afterModel` 等一串钩子调用。我们一直把它们当「已经插好的插座」轻轻带过，但一个真正的问题浮现了：

> **如果想给 Agent 加一个「危险操作先弹给人类审批」的行为、或「长任务里定期提醒更新待办」的行为、或「按需注入一套技能说明」的行为——难道每加一个都要去改 `agent.ts` 这颗心脏吗？** 有没有办法**不碰核心代码**，就把这些行为「插」进循环的各个时机？

答案就是这些钩子背后的**中间件系统**——`agent.ts` 里那一串 `_beforeX/_afterX` 到底遵循什么协议、`beforeToolUse` 返回 `{ __skip: true }` 的「短路」信号（本节 1.4 已经用到）究竟怎么运作，是 [第 7 节](./00-roadmap.md) 的主题。它是**后续一切扩展（审批、技能、待办）的插座**。

👉 下一节 **第 7 节：Middleware 中间件系统 —— 8 个生命周期钩子**。它会揭开本节反复出现、却一直被当黑盒的那些 `_beforeX/_afterX` 钩子的全部秘密，让这台封闭的机器变成一个**可任意扩展**的平台。

准备好后，对我说「**生成第 7 节**」即可。
