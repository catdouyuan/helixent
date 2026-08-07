# 第 9 节：Skills 技能系统 —— 渐进式加载（Progressive Disclosure）

> 本节属于 **第三部分 · Agent 层（可复用的通用大脑）**，是 [第 7 节](./07-middleware.md) 分岔出的**三个并列插件**中的第二个。第 7 节我们把「插座」（中间件系统）看透了，[第 8 节](./08-tool-result-pipeline.md) 讲了第一个插件——工具结果处理管线（从「结果回喂」这一侧给上下文节流）。本节接着讲第二个插件 Skills，它从**另一侧**——「能力注入」——给上下文节流。
>
> 对应 roadmap 为本节设定的**核心问题**：
>
>> 如何让 Agent「按需」学会一套专门技能，而不是把所有说明书一次性塞进 prompt？
>>
>
> **一句边界声明**：本节精讲**四个文件**——技能中间件 [skills-middleware.ts](../../src/agent/skills/skills-middleware.ts)（117 行，是绝对主角）、frontmatter 读取器 [skill-reader.ts](../../src/agent/skills/skill-reader.ts)（13 行）、给 CLI 用的技能枚举器 [list-skills.ts](../../src/agent/skills/list-skills.ts)（41 行）、以及只有 5 行的类型定义 [types/index.ts](../../src/agent/skills/types/index.ts)。加起来不到 180 行代码，外加对两个**真实技能样例** [coding-plan/SKILL.md](../../skills/coding-plan/SKILL.md)、[deep-research-plan/SKILL.md](../../skills/deep-research-plan/SKILL.md) 的解读。至于**中间件分发机制**是 [第 7 节](./07-middleware.md) 的主题（本节直接用它的结论）、**技能正文靠哪个工具读进来**（`read_file`）是 [第 12 节](./00-roadmap.md) 的主题、**斜杠命令的输入框/补全**是 [第 20 节](./00-roadmap.md) 的主题——本节只负责「技能如何被发现、如何以最省 token 的方式注入、以及如何被显式/隐式触发」这条主线。

---

## 0. 承上启下

[第 8 节](./08-tool-result-pipeline.md) 结尾，我们把从第 6 节就一直当黑盒的 `formatToolResultForMessage` 拆干净了，并在收尾时**明确埋下了本节的钩子**。原话是这样的：

> 本节解决的是「结果怎么**回喂**」——这是一个「数据往回流」的问题。下一节转向一个**正交**的问题：「能力怎么**注入**」……你会发现它和本节共享同一个底层焦虑——**上下文窗口是稀缺资源**——只是本节从「结果」这一侧节流，第 9 节从「能力注入」那一侧节流。

这就是本节的定位。让我们把这个「共享焦虑」摆到台面上，你才会明白 Skills 系统为什么要这么设计。

**先看问题的真实尺度。** 打开本节要解读的第一个真实样例 [coding-plan/SKILL.md](../../skills/coding-plan/SKILL.md)——它有 **148 行**：详尽的「4 阶段工作流」（Understanding / Design / Review / Write）、文件命名规范、`plans/<name>.md` 的结构模板、甚至连「不许用 emoji、不许用营销词」这种风格细则都写进去了。另一个样例 [deep-research-plan/SKILL.md](../../skills/deep-research-plan/SKILL.md) 也有 **144 行**。

现在设想你有 10 个这样的技能。如果按最直觉的做法——**开跑时把所有 SKILL.md 全文读出来、拼进 system prompt**——那就是 **1500 行说明书**，在**每一次对话、每一步 think、无论这次任务用不用得上**，都要原样烧掉这么多 token。用户只是想「改个拼写错误」，模型却要先读完「深度研究文章怎么写」的 144 行——纯属浪费，而且技能越多越糟，根本不可扩展。

第 8 节从「工具吐出的海量结果」这一侧防撑爆（截断策略），本节则要回答：**能力说明书这一侧，怎么防撑爆？** 而 roadmap 已经给了答案的名字——**渐进式加载（Progressive Disclosure，也译"渐进式披露"）**。它走的是第 7 节预告过的 `beforeAgentRun` + `beforeModel` 两个钩子（回想第 7 节 1.7 那张图）：

> `beforeAgentRun ──[Skills 扫描目录]` → `beforeModel ──[Skills 注入技能列表]`

打开这四个文件，我们开始拆。

---

## 1. 主题内容

### 1.1 先想清楚问题：如果让你来做「技能系统」，你会踩哪些坑？

老规矩，看代码前先自己当一次设计者。需求是：**让 Agent 能"学会"一套专门工作流（比如"进入计划模式"），但又不能把所有工作流的说明书一股脑塞进 prompt。**

**最朴素的第一版**：启动时把每个技能目录下的 `SKILL.md` 全文读出来，拼进 system prompt。

```ts
// 朴素方案（Helixent 没有这么做）
let prompt = basePrompt;
for (const skillFile of await findAllSkillFiles()) {
  prompt += "\n\n" + (await Bun.file(skillFile).text()); // 塞全文！
}
```

跑起来你会**立刻**踩四个坑：

1. **撑爆上下文**。10 个技能 ≈ 1500 行全文，system prompt 瞬间肥大。
2. **绝大多数技能用不上**。用户问「帮我改个 bug」，[deep-research-plan/SKILL.md](../../skills/deep-research-plan/SKILL.md) 那 144 行「文章大纲怎么列」完全是噪声——不仅烧 token，还稀释了模型对真正相关内容的注意力。
3. **每一步都在重烧**。回忆第 7 节：`beforeModel` 在**每一步 think 前**都会跑，而 `prompt` 是每步重建的（下面 1.5 会再钉一遍）。所以「全量注入」不是烧一次，是**每步烧一次**。
4. **不可扩展**。技能是给用户/社区往目录里丢的，越丢越多，上面三个问题只会越来越严重。

**关键洞察**在于：模型**不需要**一开始就知道每个技能的**全部细节**。它只需要知道「**有哪些技能、各自是干什么的、正文在哪个文件**」——这点信息就足够它判断「当前这个任务，该不该用某个技能」。等它判断"要用"了，**再去读那个技能的全文**。

这就是**渐进式披露**：把信息**分层**暴露。

- **第一层（常驻 prompt）**：技能的「目录条目」——名字 + 描述 + 文件路径。极小，每个技能就一行描述。
- **第二层（按需加载）**：技能的「正文」——放在磁盘上，模型判断"要用"时，用**它本来就会用的 `read_file` 工具**去读。
- **第三层（更按需）**：正文里还会引用同目录下的其他资源文件（模板、脚本、参考），**用到时再读**。

一个绝妙的类比：**一本书的「目录页」永远在你手边（prompt），「正文章节」放在图书馆（磁盘）。你看目录决定去借哪一章，而不是把整个图书馆搬进脑子。** 而且——加载正文这件事**不需要任何新机制**：技能正文就是磁盘上一个普通的 `.md` 文件，模型用读任何文件的同一个 `read_file` 工具就能读。**渐进式披露的"加载手段"是零新增成本的。**

想清楚了这一层，下面四个文件的所有设计就都顺理成章了。我们**自底向上**看：先看「目录条目」长什么样（类型），再看「怎么从磁盘读出目录条目」（reader），然后是核心的「发现 + 注入」（middleware），最后是给 UI 用的孪生函数（list-skills）。

### 1.2 数据形状：`SkillFrontmatter` —— 只有三个字段（[types/index.ts](../../src/agent/skills/types/index.ts)）

整个类型定义只有 5 行：

```ts
export interface SkillFrontmatter {
  name: string;
  description: string;
  path: string;
}
```

这三个字段，正好对应上面说的「第一层：目录条目」：

| 字段            | 含义                                                             | 谁产生                                                  |
| --------------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| `name`        | 技能名（也是斜杠命令名，如`coding-plan`）                      | 来自 SKILL.md 的 YAML frontmatter                       |
| `description` | 一句（其实往往是一大段）描述「这个技能是干什么的、什么时候该用」 | 来自 frontmatter                                        |
| `path`        | 该技能`SKILL.md` 的**绝对路径**，即"正文在哪"            | 由代码在读取时**补上**（不是 frontmatter 里写的） |

这个格式**刻意对标 [agentskills.io](https://agentskills.io/) 标准**（也就是 Anthropic 在 2025 年推广的 "Agent Skills" 约定）：一个技能 = 一个文件夹，里面有一个 `SKILL.md`，`SKILL.md` = **YAML frontmatter（元数据）+ Markdown 正文（说明书）**，正文旁边可以放任意辅助资源文件。frontmatter 就是"目录条目"，正文就是"章节内容"，同目录的其他文件就是"附录"。

**`description` 是整个系统里最重要、也最容易被低估的字段——它是"路由信息"。** 打开 [coding-plan/SKILL.md](../../skills/coding-plan/SKILL.md) 的第 3 行看它的 description（节选）：

> Enter "plan mode" for a coding task ... Use this skill whenever the user says "plan mode", "/coding-plan", "make a plan", "draft a plan first", "give me a plan before you code", "let's plan this out" ... Even casual phrasing like "don't rush, think it through first" should trigger this skill.

看到没有？它把**一大堆可能触发这个技能的用户说法**全枚举进 description 里了。这不是啰嗦——这是**故意**的。因为在渐进式披露里，模型是**靠 description 来判断"当前任务该不该加载这个技能全文"的**。description 写得越具体、越能覆盖真实用户措辞，模型的"路由"就越准。**description 的质量，直接决定技能被正确触发的概率。**

### 1.3 读取：`readSkillFrontMatter` —— gray-matter 与「无 frontmatter 也不报错」（[skill-reader.ts](../../src/agent/skills/skill-reader.ts)）

有了目标形状 `SkillFrontmatter`，下一步是「怎么从磁盘上的 `SKILL.md` 里抠出这三个字段」。整个 reader 也只有 13 行：

```ts
import matter from "gray-matter";

export async function readSkillFrontMatter(path: string): Promise<SkillFrontmatter> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`File ${path} does not exist`);
  }
  const content = await file.text();
  const parsedFile = matter(content);
  return { ...parsedFile.data, path } as SkillFrontmatter;
}
```

逐行看：

- **`Bun.file(path)` + `exists()`**：Bun 原生的文件句柄（第 21 节会讲为什么全用 Bun 原生 API）。文件不存在就**抛错**——注意，这是这个函数**唯一**会抛错的情况。
- **`matter(content)`**：调 [gray-matter](https://github.com/jonschlinkert/gray-matter) 库解析。它把一个形如
  ```
  ---
  name: coding-plan
  description: Enter "plan mode" ...
  ---

  # Plan Mode
  正文...
  ```

  的文件，拆成 `{ data: { name, description }, content: "# Plan Mode\n正文..." }`。本函数只取 `data`（frontmatter），**正文 `content` 直接丢弃**——这正是渐进式披露的体现：**读目录条目的这一步，压根不关心正文。**
- **`{ ...parsedFile.data, path }`（妙笔）**：把 gray-matter 解析出的 `data`（一个松散的 `{ [key]: any }`）展开，**再补上一个我们自己拼的 `path`**。为什么 `path` 要代码补、而不是让 SKILL.md 在 frontmatter 里自己写？因为**路径是"这个文件在磁盘的哪"，只有读它的代码知道**——让 SKILL.md 自己写路径既冗余又容易和实际位置不一致。`data` 里的字段是"作者声明的"（不可靠、可能缺失），`path` 是"运行时观测的"（可靠、一定正确）。这个「**松散数据 + 可靠补丁**」的合并模式，很值得记住。
- **`as SkillFrontmatter`**：类型断言。因为 `data` 是 `any`，这里用断言"承诺"它符合接口。

⚠️ **一个必须警惕的坑：没有 frontmatter 的 `SKILL.md` 不会报错。** 看它的测试（[skills.test.ts](../../src/agent/__tests__/skills.test.ts#L43-L50)）：

```ts
test("handles SKILL.md with no frontmatter", async () => {
  await writeFile(skillPath, "Just plain content, no frontmatter.");
  const result = await readSkillFrontMatter(skillPath);
  expect(result.name).toBeUndefined();       // ← name 是 undefined，不报错！
  expect(result.description).toBeUndefined(); // ← description 也是
  expect(result.path).toBe(skillPath);        // ← 只有 path 一定有
});
```

也就是说：这个函数是**"宽容读取"**的——只要文件存在，哪怕格式全错，它也会返回 `{ name: undefined, description: undefined, path }`，而**不是**快速失败。这个取舍的利弊，我们放到 [第 4 部分 Q5](#4-深度解释为什么这样设计不这样会怎样) 详谈。你现在只要记住：**类型签名写着 `name: string`，但运行时它可能是 `undefined`——类型系统在这里"撒了个谎"。**

### 1.4 发现：`beforeAgentRun` 扫描多目录 + 按路径去重（[skills-middleware.ts](../../src/agent/skills/skills-middleware.ts#L32-L68)）

现在进入绝对主角。`createSkillsMiddleware` 是一个**工厂函数**：你给它一组目录，它返回一个 [第 7 节](./07-middleware.md) 定义的 `AgentMiddleware`。这个中间件用了**两个钩子**——本小节看第一个 `beforeAgentRun`（负责"发现"），下一小节看 `beforeModel`（负责"注入"）。

先看函数签名和默认值：

```ts
export function createSkillsMiddleware(
  skillsDirs: string[] = [join(process.cwd(), "skills")],
): AgentMiddleware {
```

默认扫描当前工作目录下的 `skills/`。但实际装配时会传入**更多目录**（下面会讲）。

`beforeAgentRun` 钩子的完整逻辑（[skills-middleware.ts](../../src/agent/skills/skills-middleware.ts#L34-L68)）：

```ts
beforeAgentRun: async () => {
  const skills: SkillFrontmatter[] = [];
  const seenSkillFiles = new Set<string>();          // ← 去重用的"已见路径"集合

  for (let skillsDir of skillsDirs) {
    if (skillsDir.startsWith("~")) {                 // ① ~ 展开为 home 目录
      skillsDir = join(os.homedir(), skillsDir.slice(1));
    }
    if (!(await exists(skillsDir))) {                // ② 目录不存在 → 跳过（不报错）
      continue;
    }

    let folders: Dirent[];
    try {
      folders = await fs.readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue;                                      // ③ 读不动（权限等）→ 跳过（不报错）
    }

    for (const folder of folders) {
      const skillFilePath = join(skillsDir, folder.name, "SKILL.md");
      if (!folder.isDirectory()) continue;           // ④ 不是目录 → 跳过
      if (seenSkillFiles.has(skillFilePath)) continue; // ⑤ 这个路径见过了 → 跳过（去重）
      if (!(await exists(skillFilePath))) continue;  // ⑥ 没有 SKILL.md → 跳过

      seenSkillFiles.add(skillFilePath);
      const frontmatter = await readSkillFrontMatter(skillFilePath);
      skills.push(frontmatter);
    }
  }

  return { skills };   // ← Object.assign 进 agentContext.skills（第 7 节的合并协议）
},
```

**发现算法本身很直白**：遍历每个 `skillsDir` → 遍历其下每个子文件夹 → 若 `<文件夹>/SKILL.md` 存在，就读出它的 frontmatter。中间有六道关卡（①~⑥），其中最值得说的是**去重**和**宽容**两点。

**先说宽容（②③④⑥）。** 这个函数**几乎不会抛错**：目录不存在（②）、目录读不动（③）、子项不是目录（④）、没有 `SKILL.md`（⑥）——全都是 `continue` 跳过，而不是 `throw`。为什么？因为技能目录是**"有就加载、没有就算了"**的东西：`skillsDirs` 里配了 5 个候选目录（下面会看到），但一个新用户的机器上可能一个都不存在。如果任何一个不存在就崩，Agent 根本起不来。**宽容发现 = "尽力而为地加载能加载的，绝不因为技能缺失而拖垮主流程"。**（唯一的例外：`readSkillFrontMatter` 内部若文件在 `exists` 检查后、`text()` 之前被删了，会抛错——但这是极端竞态，可忽略。）

**再说去重（⑤，本节重点）。** `skills-middleware.ts` 顶部有一大段注释专门解释去重策略（[skills-middleware.ts](../../src/agent/skills/skills-middleware.ts#L20-L30)），因为它反直觉，必须讲清楚：

> - **没有"同名技能覆盖另一个"的行为。**
> - 去重**只**按 *解析后的 SKILL.md 文件路径*（完整路径字符串）来做。
>   - 如果两个不同的 `skillsDirs` 各有一个 `my-skill/SKILL.md`，它们被当作**两个不同的技能**（因为文件路径不同）。
>   - 唯一会被去重的情况，是**同一个 `SKILL.md` 路径被遇到多次**（比如 `skillsDirs` 里有重复条目、或别名指向同一目录）。

用一张表说清「什么会被去重、什么不会」：

| 场景                   | `skillsDirs`                                         | 结果                                                                                                                                         |
| ---------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 别名指向同一目录       | `["/a/skills", "/a/skills"]` 里都有 `foo/SKILL.md` | **去重**——同一个路径 `/a/skills/foo/SKILL.md`，只留一个                                                                            |
| 两个不同目录有同名技能 | `["/a/skills", "/b/skills"]` 各有 `foo/SKILL.md`   | **不去重**——`/a/.../foo/SKILL.md` 和 `/b/.../foo/SKILL.md` 是两个路径，**都保留**，于是 prompt 里会出现两个 `name="foo"` |

**换句话说：去重的粒度是"物理文件"，不是"逻辑技能名"。** 这个决策的深层原因（为什么不做"同名覆盖"）放到 [第 4 部分 Q1](#4-深度解释为什么这样设计不这样会怎样)。

**顺序（Ordering）**：技能按 `skillsDirs` 的顺序、再按每个目录 `readdir` 返回的顺序追加（注释也写明了）。这个顺序会影响它们在 prompt 里出现的先后。

**发现结果去哪了？** `return { skills }` —— 按第 7 节讲的「返回 `Partial<AgentContext>` 则 `Object.assign` 合并」协议，这个数组被写进了 `agentContext.skills`（[agent.ts](../../src/agent/agent.ts#L27-L28) 定义的字段）。**注意 `beforeAgentRun` 每轮 `stream` 只跑一次**（[agent.ts](../../src/agent/agent.ts#L147)），所以**目录扫描每次对话只做一次**——发现是"一次性"的，符合直觉。

**实际配置了哪些目录？** 看 CLI 入口 [cli/index.tsx](../../src/cli/index.tsx#L63-L69)：

```ts
const skillsDirs = [
  join(process.cwd(), "skills"),           // 项目级：仓库自带
  join(process.cwd(), ".agents/skills"),   // 项目级：约定隐藏目录
  join(Bun.env.HELIXENT_HOME!, "skills"),  // 安装级：随 Helixent 分发
  "~/.agents/skills",                      // 用户级：跨项目共享（agentskills.io 约定）
  "~/.helixent/skills",                    // 用户级：Helixent 专属
];
```

这是一个**分层技能来源**的设计：从"这个项目专属"到"这台机器上所有项目共享"，一路兜底。而库的默认装配点 [lead-agent.ts](../../src/coding/agents/lead-agent.ts#L34) 里只放了 `.agents/skills` 一个——**CLI 层负责把来源扩充成 5 个**，这也呼应了第 1 节「CLI 是最外层、负责把通用件组装成产品」的分层思想。

### 1.5 注入：`beforeModel` 把 frontmatter 渲染成 XML 追加进 prompt（[skills-middleware.ts](../../src/agent/skills/skills-middleware.ts#L70-L115)）

发现阶段把技能列表存进了 `agentContext.skills`。但**光存着没用，得让模型"看见"**。第二个钩子 `beforeModel` 就干这件事——在**每次调模型前**，把技能列表渲染成一段 XML，追加进 prompt：

```ts
beforeModel: async ({ modelContext, agentContext }) => {
  if (agentContext.skills && agentContext.skills.length > 0) {   // ① 有技能才注入
    const requestedSkill = agentContext.requestedSkillName       // ② 显式点名的技能（1.6 讲）
      ? agentContext.skills.find(
          (skill) => skill.name.toLowerCase() === agentContext.requestedSkillName?.toLowerCase(),
        )
      : null;

    const skillsXML = agentContext.skills                        // ③ 渲染技能列表
      .map((skill) => `<skill name="${skill.name}" path="${skill.path}">\n${skill.description}\n</skill>`)
      .join("\n");

    return {
      prompt: modelContext.prompt + `\n
<skill_system>
<instructions>
You have access to skills that provide optimized workflows for specific tasks. ...

**Progressive Loading Pattern:**
1. When a user query matches a skill's use case, immediately call \`read_file\` on the skill's main file using the path attribute provided in the skill tag below
2. If an explicit requested skill is provided in the system context, load that skill first even if the user message is short
3. Read and understand the skill's workflow and instructions
4. The skill file contains references to external resources under the same folder
5. Load referenced resources only when needed during execution
6. Follow the skill's instructions precisely
</instructions>

${requestedSkill ? `<explicit_skill_invocation> ... </explicit_skill_invocation>` : ""}

<skills>
${skillsXML}
</skills>
</skill_system>`,
    };
  }
},
```

这段代码是**整个渐进式披露的落地点**，有三个关键点必须钉死。

**关键点 A：只注入 frontmatter，绝不注入正文。** 看 `skillsXML` 的模板——它只放了 `name`、`path`、`description` 三个字段，**没有 `SKILL.md` 的正文**。渲染出来长这样：

```xml
<skill name="coding-plan" path="/abs/skills/coding-plan/SKILL.md">
Enter "plan mode" for a coding task ... Use this skill whenever the user says "plan mode" ...
</skill>
```

模型看到的是「**有个叫 coding-plan 的技能，管"计划模式"，正文在这个 path**」。要读正文？`<instructions>` 第 1 步白纸黑字告诉它：**"immediately call `read_file` on the skill's main file using the path attribute"**——用你本来就有的 `read_file` 工具（[read-file.ts](../../src/coding/tools/read-file.ts)，第 12 节精讲），去读 `path` 指向的文件。第 4-5 步进一步说：正文里引用的外部资源（同目录的模板/脚本），**"Load referenced resources only when needed"**（用到时再读）。**这就是"目录常驻、正文按需、附录更按需"的三层披露在 prompt 里的完整表达。**

**关键点 B：追加到 `modelContext.prompt`，而不是 `agentContext.prompt`——所以它"每步重注入但绝不累积"。** 这是最容易看漏、也最精妙的一点。回忆 [第 7 节](./07-middleware.md) 和 [第 5 节](./05-react-loop.md)：`_think` 在**每一步**都会**重新构造**一个 `modelContext`（[agent.ts](../../src/agent/agent.ts#L181-L186)）：

```ts
const modelContext: ModelContext = {
  prompt: this.prompt,   // ← 每步都从 this.prompt（原始、干净的 prompt）重新取
  messages: this.messages,
  tools: this.tools,
  signal: this._abortController?.signal,
};
await this._beforeModel(modelContext);  // ← beforeModel 在这个"每步新建"的对象上追加 skillsXML
```

`modelContext.prompt` 的初值是 `this.prompt`（即 `agentContext.prompt`，那个**从头到尾没被污染的原始系统提示词**）。Skills 的 `beforeModel` 做的是 `modelContext.prompt + skillsXML`——**改的是这个每步新建、用完即弃的临时对象**。所以：

- 第 1 步注入的 prompt = `原始 prompt + skillsXML`
- 第 2 步 `modelContext` 重建，prompt 又从干净的 `this.prompt` 开始，再 + skillsXML
- ……每一步都是 `原始 + 一份 skillsXML`，**永远不累积**。

⚠️ **反面推演**：如果偷懒写成 `agentContext.prompt = agentContext.prompt + skillsXML`（改持久对象），会怎样？第 1 步 prompt 变成 `原始 + skillsXML`；第 2 步在此基础上又加一份 → `原始 + skillsXML + skillsXML`；第 N 步就是 `原始 + N 份 skillsXML`——**prompt 雪崩式膨胀，几步就撑爆上下文**。所以"注入到临时的 `modelContext.prompt` 而非持久的 `agentContext.prompt`"不是随手一写，而是**保证渐进式披露真的省 token 的关键**。这正是第 7 节 `AgentContext`（持久）与 `ModelContext`（每步临时）分家的价值兑现。

**关键点 C：为什么"发现"放 `beforeAgentRun`（一次）、"注入"放 `beforeModel`（每步）？** 因为两件事的"生命周期"不同：

- **发现**（扫磁盘）是**昂贵**的（IO），且结果（有哪些技能）**整轮不变**，所以放在"每轮一次"的 `beforeAgentRun`，写进"持久"的 `agentContext.skills`。
- **注入**（拼字符串）是**廉价**的，但它的载体 `modelContext.prompt` 是"每步新建"的，所以**必须每步重新注入**——否则第 2 步的新 `modelContext` 里就没有技能列表了，模型会"忘记"自己有哪些技能。

**两个钩子，一个管"持久且昂贵的发现"、一个管"每步且廉价的注入"，各按其数据的生命周期就位。** 这是对第 7 节"8 个钩子对应 8 个时刻"最典型的一次运用。

### 1.6 两种触发路径：隐式（模型自己判断）vs 显式（斜杠命令）

技能列表注入 prompt 后，**谁来决定"现在该加载 coding-plan 的正文"？** Helixent 提供了**两条**触发路径。

**路径一：隐式触发（模型自主）。** 模型看到 `<skills>` 列表，**自己**根据每个技能的 `description`，判断当前用户请求是否匹配某个技能的"use case"。匹配上了，就照 `<instructions>` 第 1 步主动 `read_file` 读正文。**这条路径完全依赖 description 写得好不好**（回到 1.2 的"description 即路由"）——这也是为什么 [coding-plan/SKILL.md](../../skills/coding-plan/SKILL.md) 的 description 要枚举那么多触发短语。

**路径二：显式触发（用户点名）。** 用户在 TUI 里敲 `/coding-plan 帮我规划登录功能`，明确指定要用哪个技能。这条链路串起了好几个文件，值得完整走一遍：

1. **启动时，技能变斜杠命令**：CLI 调 [command-registry.ts](../../src/cli/tui/command-registry.ts#L44-L48) 的 `loadAvailableCommands` → 内部调 `listSkills`（见下一小节）→ 把每个技能通过 `toSkillCommand`（[command-registry.ts](../../src/cli/tui/command-registry.ts#L165-L171)）变成一个 `type: "skill"` 的斜杠命令。于是 `/coding-plan`、`/deep-research-plan` 就出现在了斜杠命令面板里（补全/展示是第 20 节的事）。
2. **用户输入被解析出"点名了谁"**：用户提交 `/coding-plan ...` 后，`buildPromptSubmission`（[command-registry.ts](../../src/cli/tui/command-registry.ts#L139-L163)）用正则抠出开头的命令 token，在命令表里找到对应的 `skill` 类型命令，产出 `{ text, requestedSkillName: "coding-plan" }`。
3. **写进 Agent 上下文**：TUI 的提交回调 [use-agent-loop.ts](../../src/cli/tui/hooks/use-agent-loop.ts#L83-L122) 在开跑前调 `agent.setRequestedSkillName(requestedSkillName)`（[agent.ts](../../src/agent/agent.ts#L117-L119)），把这个名字塞进 `agentContext.requestedSkillName`。
4. **注入时被"特别关照"**：回到 1.5 的 `beforeModel`——`requestedSkill` 被 `find` 匹配到后（②），prompt 里会**额外**注入一段 `<explicit_skill_invocation>`：

   ```xml
   <explicit_skill_invocation>
   The user explicitly selected the skill "coding-plan" from the slash command picker.
   You must read the matching skill file at "..." before answering.
   </explicit_skill_invocation>
   ```

   配合 `<instructions>` 第 2 步（"If an explicit requested skill is provided ... load that skill first **even if the user message is short**"），这就形成了一道**强指令**：哪怕用户只打了 `/coding-plan`（几乎没正文），模型也必须先读该技能。

**为什么要两条路径？** 隐式路径靠 description 概率性匹配——可能漏（用户措辞刁钻、description 没覆盖到）。显式路径给用户一个**确定性**的兜底：**"我就要用这个，别猜了。"** 两条路径共用同一套注入机制（都是往 prompt 里放技能信息），只是显式路径多注入了一段"强制先读"的指令。

### 1.7 孪生兄弟：`listSkills` 与中间件发现逻辑的「重复」（[list-skills.ts](../../src/agent/skills/list-skills.ts)）

你可能已经注意到：上一小节路径二的第 1 步，CLI 用的是 `listSkills`，**不是**中间件里的 `beforeAgentRun`。把两段代码并排看：

```ts
// list-skills.ts 的 listSkills（节选）        // skills-middleware.ts 的 beforeAgentRun（节选）
for (let skillsDir of skillsDirs) {            for (let skillsDir of skillsDirs) {
  if (skillsDir.startsWith("~")) { ... }         if (skillsDir.startsWith("~")) { ... }
  if (!(await exists(skillsDir))) continue;      if (!(await exists(skillsDir))) continue;
  folders = await fs.readdir(...);               folders = await fs.readdir(...);
  for (const folder of folders) {                for (const folder of folders) {
    // 同样的四道 continue 关卡                     // 同样的四道 continue 关卡
    skills.push(await readSkillFrontMatter(...)); skills.push(await readSkillFrontMatter(...));
  }                                              }
}                                                }
```

**这两段几乎逐行相同。** 为什么明知重复还各写一份？关键在**消费者不同、时机不同**：

|                    | `beforeAgentRun`（中间件里）                        | `listSkills`（独立函数）                                                         |
| ------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **消费者**   | **模型**——结果注入 prompt，供模型"按需读正文" | **用户/UI**——结果变成斜杠命令，供用户点选 + `/help` 展示                 |
| **触发时机** | 每次`agent.stream()` 的 `beforeAgentRun`          | CLI**启动时**调一次 [cli/index.tsx](../../src/cli/index.tsx#L83)              |
| **依赖方向** | 在 agent 层内部                                       | 被 cli 层 import（[command-registry.ts](../../src/cli/tui/command-registry.ts#L1)） |

客观地说，**这是一处"本可以 DRY 但选择不 DRY"的重复**：中间件的 `beforeAgentRun` 完全可以直接调 `listSkills(skillsDirs)`，逻辑一模一样。项目没这么做，我理解是权衡后的务实选择（两段都只 ~30 行、各自独立演化不互相牵连），但它确实是本节唯一一个"能消除的重复"。这一点的利弊，[第 4 部分 Q4](#4-深度解释为什么这样设计不这样会怎样) 会摆开讲——我不替设计者粉饰，也不夸大。

### 1.8 全景：一条「从磁盘到模型」的渐进式数据流

把四个文件 + CLI 链路串成一张图，你就能看清整个系统怎么运转：

```
                        【发现】每轮一次                    【注入】每步一次
  磁盘 skills/*/SKILL.md ──beforeAgentRun──► agentContext.skills ──beforeModel──► modelContext.prompt
       │  (只读 frontmatter,               [{name,description,path}]   (追加 <skill_system> XML,
       │   正文丢弃 → 1.3)                        │                     只含 name/path/description → 1.5)
       │                                          │                              │
       │                          【显式旁路】     │                              ▼
  用户 /coding-plan ──command-registry──► requestedSkillName ──► <explicit_skill_invocation>
       │   (listSkills 枚举成斜杠命令 → 1.7)              (setRequestedSkillName → 1.6)      │
       │                                                                                    ▼
       │                                                                        ┌──────────────────┐
       │                                                                        │  模型看到"技能目录" │
       │                                                                        │  判断是否匹配任务   │
       │                                                                        └────────┬─────────┘
       │                                                                                 │ 匹配 → 决定加载
       └──────────────────────◄── read_file(path) ◄─────────────────────────────────────┘
              (正文这时才被读进上下文，第 12 节的工具；用到附录再 read_file 更多文件)
```

**一句话总括**：**发现只读目录条目、注入只放目录条目、正文永远躺在磁盘上等模型用 `read_file` 按需取——上下文里永远只有"薄薄一层目录"，这就是渐进式披露。**

---

## 2. 亮点与关键设计

明确标注哪些是「妙笔」、哪些是「关键决策」：

1. **【核心妙笔】渐进式披露：目录常驻、正文按需、零新增加载机制。** 只把 `{name, description, path}` 注入 prompt，正文让模型用**它本就拥有的 `read_file`** 去读。既省 token（薄目录 vs 全量说明书），又"免费"（不需要新的检索/加载子系统）。这是整节的灵魂。
2. **【关键决策】`description` 即"路由信息"。** 把"何时该用这个技能"的判断权交给模型，而判断的依据就是 description。所以真实技能的 description 会**刻意枚举大量触发短语**（[coding-plan/SKILL.md](../../skills/coding-plan/SKILL.md#L3)）——description 的丰富度直接决定触发准确率。
3. **【关键决策】注入 `modelContext.prompt` 而非 `agentContext.prompt`——每步重注入但绝不累积。** 借力第 7 节"持久上下文 / 每步临时上下文"的分家，一行 `modelContext.prompt + skillsXML` 就同时拿到"模型每步都记得有哪些技能"和"prompt 不雪崩"两个好处（1.5 关键点 B）。
4. **【关键决策】两个钩子按数据生命周期分工。** 昂贵且整轮不变的"发现"放 `beforeAgentRun`（一次）；廉价但载体每步重建的"注入"放 `beforeModel`（每步）。教科书级的钩子选型（1.5 关键点 C）。
5. **【妙笔】`{ ...parsedFile.data, path }`——松散数据 + 可靠补丁。** frontmatter 字段是"作者声明的"（可缺失），`path` 是"运行时观测的"（一定对），二者合并成可靠的 `SkillFrontmatter`（1.3）。
6. **【关键决策】按物理路径去重，不做"同名覆盖"。** 去重粒度是文件而非逻辑名，让多目录分层的语义保持简单（"每个文件就是一个技能"），代价是同名技能会并存（1.4、Q1）。
7. **【关键决策】显式 + 隐式双触发。** 隐式靠 description 概率匹配、显式靠斜杠命令确定兜底，共用同一套注入机制（1.6）。
8. **【关键决策】宽容发现。** 目录不存在/读不动/无 `SKILL.md` 一律 `continue` 不 `throw`，保证"技能缺失绝不拖垮 Agent 启动"（1.4）。
9. **【对标标准】格式贴合 [agentskills.io](https://agentskills.io/)。** `SKILL.md = frontmatter + 正文 + 同目录资源`，一个文件夹一个技能——直接复用社区已成型的约定，用户从 Claude Code 等工具迁移技能几乎零成本。

---

## 3. 工业对比

对比业界方案的做法与优缺点。

### 3.1 Claude Code / Anthropic「Agent Skills」——Helixent 的直接对标

Anthropic 在 2025 年推出的 **Agent Skills** 正是"渐进式披露"这个词的出处：一个技能是一个含 `SKILL.md` 的文件夹，`SKILL.md` 有 YAML frontmatter（`name` + `description`）和 Markdown 正文，同目录可放脚本、模板等资源；运行时**只把 frontmatter 加载进上下文，正文和资源按需读取**。

**Helixent 基本是这套标准的一个精简开源实现**——连字段名（`name`/`description`）、目录约定（`~/.agents/skills`）、"progressive loading"的措辞都对齐了。差异在于：Anthropic 的实现有更完整的技能打包/分发/权限体系，Helixent 则聚焦最核心的"发现 + 注入 + 触发"三步，178 行讲清楚原理。**读懂本节，你就读懂了 Claude Code 技能系统的骨架。**

### 3.2 Cursor Rules / `.cursorrules`——"注入"而非"披露"

Cursor 的自定义规则（`.cursorrules` 或 `.cursor/rules/*.mdc`）是往模型上下文里加"项目约定/偏好"。它的加载模式和 Helixent 有本质区别：

- Cursor 规则要么**无条件全量注入**（Always 类型），要么**按文件 glob 匹配**自动附加（如"编辑 `*.tsx` 时附上 React 规则"）。
- Helixent 的技能是**"目录常驻 + 模型判断 + 按需读全文"**。

**取舍**：Cursor 的 glob 匹配更"自动"（不依赖模型判断），但粒度是"文件类型"；Helixent 的 description 路由更"语义"（按任务意图），但依赖模型判断且是概率性的。二者其实可以互补——Cursor 后来也引入了类似"按需引用"的规则类型，思路在收敛。

### 3.3 LangChain——没有"技能"原语，通常靠 RAG 或 Tool

LangChain 生态里没有直接对应"skill"的概念。想实现类似效果，一般两条路：

- **RAG**：把说明书切块、做 embedding、存向量库，运行时按相似度检索最相关的片段塞进 prompt。**重**——需要 embedding 模型 + 向量库 + 检索链，还要调 chunk 大小、top-k。
- **把每个能力包成一个 Tool**：让模型 function-calling 触发。但"一套多步工作流"塞进单个 tool 的 description 里会很别扭。

**Helixent 的取巧**：**用"模型自己 `read_file`"替代了"向量检索"**。技能正文就是磁盘文件，模型看目录（description）决定读哪个文件——**零向量库、零 embedding、零检索基础设施**。当技能数量不大（几十个）时，这种"让模型自己在文件系统里导航"比 RAG 简单得多，且正文是"精确读取全文"而非"检索到的碎片"，指令完整性更好。代价是：技能规模极大（成千上万）时，"全靠 description 路由"不如向量检索精准——但那不是 Coding Agent 的典型场景。

### 3.4 MCP（Model Context Protocol）——正交，甚至互补

容易混淆，所以点一下：**MCP 是"工具与资源的传输协议"（模型怎么连到外部工具/数据源），Skill 是"工作流说明书"（教模型怎么把已有工具用好）。** 两者正交——一个技能的正文里完全可以写"第一步，调用某个 MCP 提供的工具……"。Skill 管"怎么做事的知识"，MCP 管"能连到哪些能力"。

### 3.5 一览表

| 方案                       | 加载模式                            | 是否分层披露      | 基础设施成本             | 触发方式                        |
| -------------------------- | ----------------------------------- | ----------------- | ------------------------ | ------------------------------- |
| **Helixent Skills**  | 目录常驻 + 按需`read_file` 读全文 | ✅ 是（核心卖点） | 极低（复用文件读取）     | description 隐式 + 斜杠命令显式 |
| Claude Code Agent Skills   | 同上（标准出处）                    | ✅ 是             | 低~中（含打包分发）      | 类似                            |
| Cursor Rules               | 无条件 / glob 匹配注入              | ⚠️ 部分         | 低                       | 文件类型自动                    |
| LangChain + RAG            | 向量检索片段注入                    | ⚠️ 检索式       | 高（向量库 + embedding） | 相似度                          |
| GPTs / Custom Instructions | 全量注入                            | ❌ 否             | 低                       | 无条件                          |

---

## 4. 深度解释：为什么这样设计？不这样会怎样？

用 Q&A 形式讲清几个"为什么"，以及"不这样会出什么问题"。

### Q1：为什么按「文件路径」去重，而不是按「技能名」去重？"同名覆盖"不是更符合直觉吗？

**先说不这样（按名覆盖）会引入什么复杂度。** 一旦决定"同名技能后者覆盖前者"，你立刻要回答一串问题：谁覆盖谁？是 `skillsDirs` 靠后的覆盖靠前的，还是反过来？如果同一个目录里（理论上不会，但代码得防）出现同名怎么办？覆盖是"整个替换"还是"字段级合并"？——**"覆盖"这个词一旦引入，就必须定义一套优先级规则，而任何优先级规则都是新的复杂度和新的 bug 温床。**

**再说这样（按路径去重）的好处。** 路径是**天然唯一且可靠**的标识（文件系统保证同一路径指向同一文件）。语义变得极简：**"每一个物理 `SKILL.md` 文件 = 一个技能"**，没有"逻辑技能"这个中间概念，也就没有"哪个逻辑技能生效"的仲裁问题。去重仅用于处理"同一路径被扫到多次"（`skillsDirs` 配了重复条目/别名）这种纯技术性重复。

**代价与批判**：两个不同目录的同名技能会**同时**注入 prompt，于是模型会看到两个 `name="coding-plan"`。这确实是个小瑕疵——模型可能不确定该读哪个 `path`。不过实践中：① 分层目录里同名技能很罕见；② 真撞了，两个 path 都在 prompt 里，模型读任一个都能拿到一份可用的正文（顶多多读一次）。**设计者用"允许罕见的同名并存"换来了"发现逻辑零仲裁规则"**——在"简单"和"完备"之间选了简单。这是个合理但非唯一的取舍；如果技能生态做大，加一层"同名时按 skillsDirs 优先级去重"的逻辑也不难。

### Q2：为什么注入到 `modelContext.prompt`（临时）而不是 `agentContext.prompt`（持久）？

因为**载体的生命周期决定了注入必须是"每步幂等"的**。`modelContext` 每步由 `_think` 重建（[agent.ts](../../src/agent/agent.ts#L181-L186)），其 `prompt` 每步都从干净的 `this.prompt` 重新起算——所以每步"追加一份 skillsXML"的净效果永远是 `原始 + 一份`，天然幂等、绝不累积（1.5 关键点 B 详证）。

**不这样（改持久的 `agentContext.prompt`）会怎样**：每步在上一步已污染的 prompt 上再追加，`原始 + N 份 skillsXML`，几步就把上下文撑爆——**恰好违背了本节"省 token"的初衷**。这就是第 7 节坚持把 `AgentContext`（持久）和 `ModelContext`（每步临时）分成两个对象的价值：**它让"我想每次调模型都注入、但不想让注入物在历史里堆积"这个需求，变成一行自然的代码。**

### Q3：在 `beforeModel`（每步）注入，不怕每步重复烧 token 吗？只在第一步注入不行吗？

**"每步烧"的量其实很小。** 注入的是 frontmatter——每个技能就一行 `description`。10 个技能也就十几行 + 一段固定的 `<instructions>`。相比"每步注入全量正文（1500 行）"，这点开销可以忽略。真正的省 token 来自"正文不进 prompt"，而不是"少注入几次目录"。

**只在第一步注入会坏事。** 因为 `modelContext` 每步重建，第 2 步的新 `modelContext.prompt` 里就没有技能列表了——模型会**"失忆"**：它在第 1 步知道有 `coding-plan`，第 2 步就忘了。让技能列表"每步都在场"，模型才能在任意一步决定"现在我需要读某个技能"。**每步注入 = 让"技能目录"成为一个稳定的、每步都可见的锚点**，这点小 token 花得值。

### Q4：`listSkills` 和 `beforeAgentRun` 的发现逻辑几乎逐行重复，这不是坏味道吗？

**是，这确实是可消除的重复**——中间件的 `beforeAgentRun` 大可以直接调 `listSkills(skillsDirs)`，两者的扫描/去重/读取逻辑完全一致。我不替它辩护成"精心设计"。

**但也说清楚为什么它没到"必须重构"的程度**：① 两段都很短（~30 行）、逻辑稳定，重复的维护成本低；② 消费者和依赖方向不同（一个在 agent 层给模型、一个被 cli 层 import 给 UI），合并后需要中间件反过来依赖一个"看起来像 CLI 辅助函数"的东西，或者把公共逻辑再抽到第三个文件——**抽象本身也有成本**。这是一个典型的"重复 vs 抽象"权衡点：当前规模下"容忍两份 30 行"是可接受的；但如果发现逻辑将来变复杂（比如要支持技能优先级、缓存、监听目录变化），**这两份就该合并了**——那时"改一处忘改另一处"的风险会盖过"抽象成本"。**读源码时能识别出这种"暂时容忍的重复"并知道它何时该还债，比单纯判"好/坏"更重要。**

### Q5：没有 frontmatter 的 `SKILL.md` 不报错、返回 `undefined` 字段，这不是隐患吗？

**是个真实的健壮性缺口。** 1.3 讲过，`readSkillFrontMatter` 对"文件存在但没有/写错 frontmatter"是宽容的，会返回 `{ name: undefined, description: undefined, path }`。这个坏数据会一路流到 `beforeModel`，渲染出 `<skill name="undefined" path="...">undefined</skill>`——一个对模型毫无用处、甚至有干扰的条目。

**为什么设计成宽容而非快速失败**：技能来自用户/社区的目录，Helixent 采取的是"**尽力加载，别因为一个坏技能拖垮整个 Agent**"的容错哲学（和 1.4 的宽容发现一脉相承，也和第 8 节"工具错误就地压成文本而非抛出"的容错基调一致）。如果改成"遇到无 frontmatter 就 throw"，那用户目录里一个手滑写错的 `SKILL.md` 就会让 Agent 直接起不来——体验更差。

**更稳妥的做法（当前代码没做，可作为改进）**：在 `beforeAgentRun` push 之前加一道校验，`name`/`description` 缺失就 `continue` 跳过（或打个 warning）。这样既保持"不崩"，又不让坏数据污染 prompt。**当前实现是"宽容到底"，把"过滤坏技能"的责任隐式留给了"写对 SKILL.md 的人"**——在受信任的本地技能目录场景下够用，但不算严密。

### Q6：技能正文全靠模型"自觉" `read_file`，万一它就是不读呢？

**这是渐进式披露的固有权衡：省 token 换来了"加载是概率性的"。** 隐式路径下，模型可能因为 description 没匹配上、或自己"觉得不用读"而跳过加载。系统用两道防线降低这个风险：① `<instructions>` 里用**强指令措辞**（"immediately call `read_file`"）；② 显式路径下额外注入 `<explicit_skill_invocation>` + "load first even if the user message is short"，把"是否加载"从"模型自由裁量"收紧成"近乎强制"。

但本质上，**只要正文不在 prompt 里，就没有 100% 的加载保证**——这是"省 token"必然付出的代价。对比"全量注入"方案：它 100% 保证模型看到了正文，但代价是 100% 烧掉了所有技能的 token。**渐进式披露选择了"用一点点'可能不读'的风险，换取巨大的 token 节省"**，对 Coding Agent 这种"大部分任务用不到大部分技能"的场景，这笔交易非常划算。真要 100% 保证某技能生效？——那就用显式斜杠命令。

---

## 5. 参考资料

**本节精讲的源码（四个主角 + 样例）**：

- 技能中间件（绝对主角）：[skills-middleware.ts](../../src/agent/skills/skills-middleware.ts)（发现 [beforeAgentRun](../../src/agent/skills/skills-middleware.ts#L34-L68)、注入 [beforeModel](../../src/agent/skills/skills-middleware.ts#L70-L115)、去重策略注释 [L11-L31](../../src/agent/skills/skills-middleware.ts#L11-L31)）
- frontmatter 读取器：[skill-reader.ts](../../src/agent/skills/skill-reader.ts)
- 给 CLI 用的技能枚举器：[list-skills.ts](../../src/agent/skills/list-skills.ts)
- 类型定义：[types/index.ts](../../src/agent/skills/types/index.ts)
- 真实技能样例：[coding-plan/SKILL.md](../../skills/coding-plan/SKILL.md)、[deep-research-plan/SKILL.md](../../skills/deep-research-plan/SKILL.md)

**装配与调用链**：

- 库默认装配：[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L34)（`skillsDirs` 默认值）、[L66](../../src/coding/agents/lead-agent.ts#L66)（把 `createSkillsMiddleware` 装进中间件数组）
- CLI 扩充技能来源：[cli/index.tsx](../../src/cli/index.tsx#L63-L69)（5 个目录）、[L83](../../src/cli/index.tsx#L83)（`loadAvailableCommands`）
- 显式触发链路：[command-registry.ts](../../src/cli/tui/command-registry.ts#L139-L163)（`buildPromptSubmission`）、[use-agent-loop.ts](../../src/cli/tui/hooks/use-agent-loop.ts#L83-L122)（`setRequestedSkillName`）
- 上下文字段与 setter：[agent.ts `AgentContext`](../../src/agent/agent.ts#L20-L31)、[agent.ts `setRequestedSkillName`](../../src/agent/agent.ts#L117-L119)、[agent.ts `modelContext` 每步重建](../../src/agent/agent.ts#L181-L186)
- 正文加载工具（第 12 节精讲）：[read-file.ts](../../src/coding/tools/read-file.ts)

**测试（可作为"可执行的规格说明"对照阅读）**：

- [skills.test.ts](../../src/agent/__tests__/skills.test.ts)（`readSkillFrontMatter` 的"无 frontmatter 不报错" [L43-L50](../../src/agent/__tests__/skills.test.ts#L43-L50)、`listSkills` 的发现/跳过/去重行为 [L53-L105](../../src/agent/__tests__/skills.test.ts#L53-L105)）

**上游依赖章节**：

- [第 4 节 · Tool 工具系统](./04-tool.md)（`read_file` 是 `defineTool` 定义的工具）
- [第 7 节 · Middleware 中间件系统](./07-middleware.md)（`beforeAgentRun`/`beforeModel` 钩子、`Object.assign` 合并协议、`AgentContext` vs `ModelContext` 分家）
- [第 8 节 · 工具结果处理管线](./08-tool-result-pipeline.md)（同源的"上下文是稀缺资源"焦虑、容错哲学）

**外部资料**：

- Anthropic Engineering · "Agent Skills" 与 progressive disclosure（本节格式的直接来源）：[https://www.anthropic.com/engineering](https://www.anthropic.com/engineering)
- agentskills.io（`SKILL.md` 社区约定）：[https://agentskills.io/](https://agentskills.io/)
- gray-matter（frontmatter 解析库）：[https://github.com/jonschlinkert/gray-matter](https://github.com/jonschlinkert/gray-matter)
- YAML frontmatter 约定：[https://jekyllrb.com/docs/front-matter/](https://jekyllrb.com/docs/front-matter/)

---

## 6. 小结与下一节预告

本节我们拆开了 Helixent 的 Skills 系统，看清了它**如何用不到 180 行代码，让 Agent "按需学会"任意多的专门工作流，却几乎不占用上下文**：

- **渐进式披露（核心）**：只把技能的**目录条目**（`{name, description, path}`）常驻 prompt，**正文**留在磁盘，模型判断"要用"时才用**它本就拥有的 `read_file`** 去读——薄目录常驻、全文按需、附录更按需。加载手段零新增成本。
- **发现（`beforeAgentRun`，每轮一次）**：多目录扫描 + `~` 展开 + **宽容跳过**（缺目录/无 `SKILL.md` 不崩）+ **按物理路径去重**（不做同名覆盖，语义极简）。结果写进持久的 `agentContext.skills`。
- **注入（`beforeModel`，每步一次）**：把 frontmatter 渲染成 `<skill_system>` XML，**追加到每步重建的 `modelContext.prompt`**——每步重注入却绝不累积，这是"省 token"真正落地的关键。
- **双触发**：隐式（模型靠 `description` 自主路由）+ 显式（斜杠命令 → `requestedSkillName` → `<explicit_skill_invocation>` 强制先读），概率匹配与确定兜底并存。
- **两个"孪生"函数**：`beforeAgentRun` 给模型、`listSkills` 给 UI——一处可消除的重复，我们也诚实地把它标了出来（Q4）。

至此，插在第 7 节"中间件插座"上的**第二个插件**讲完了。回头看：第 8 节从"结果回喂"这一侧给上下文节流，本节从"能力注入"那一侧给上下文节流——**两个正交的插件，共享同一个"上下文窗口是稀缺资源"的底层焦虑**，这正是 roadmap 把它们并列安排的用意。

**承上启下（启下）**：Skills 让 Agent "**会得更多**"——它现在能临时调用任意专门工作流了。但"会得多"带来一个新问题：**在一个动辄几十步的长任务里，模型很容易"跑偏"或"忘事"**——做着做着忘了最初的目标，或漏掉了三件待办里的第二件。怎么让它在长任务中**始终保持专注、记得自己的计划**？

答案是插在同一个"中间件插座"上的**第三个、也是最后一个插件——Todos 计划模式**。它比前两个插件更进一步：**同时是"一个工具 + 一个中间件"，二者共享同一份闭包状态**；还有一个基于"距上次写入步数"的**智能提醒**机制，专治模型的"注意力涣散"。这就是 [第 10 节](./00-roadmap.md) 的主题。

> 预告一个钩子：Todos 的中间件同样在 `beforeModel` 注入内容——回想第 7 节 1.5 讲的"链式叠加"：Skills 先改 `prompt`、Todos 在其成果上**再追加**待办提醒。第 10 节你会亲眼看到这两个插件如何在同一个 `modelContext.prompt` 上"接力"。

👉 下一节 **第 10 节：Todos 计划模式 —— 工具 + 中间件的组合拳**。

准备好后，对我说「**生成第 10 节**」即可。
