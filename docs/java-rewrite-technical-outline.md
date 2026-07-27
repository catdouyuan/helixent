# Helixent Java 重写技术文档大纲

> 状态：讨论稿\
> 源码基线：`ec6e188`\
> 建议 Java 基线：**JDK 17 LTS**（低于 Java 20）\
> 参考材料：[源码精读路线图](./tutorial/00-roadmap.md)、[项目总览](./tutorial/01-overview.md)、[工程实践](./tutorial/21-testing-conventions-build-release.md)

> **强制约束（代码落地目录）：** Java 重写的**所有代码只能写入** `/Users/bytedance/Desktop/heli/helixent_java/`，包括全部 Maven 模块、`pom.xml`、测试、fixture、构建脚本、CI 配置和分发产物脚本。
>
> - 原 TypeScript 项目 `/Users/bytedance/Desktop/heli/helixent/` **只读**，仅作为行为基线与对照来源，禁止在其中新增或修改 Java 代码。
> - 本文档中出现的 `helixent-java/` 根目录，一律指 `/Users/bytedance/Desktop/heli/helixent_java/`。
> - 本文档中所有形如 `mvn -pl <module> ...` 的命令，工作目录默认均为 `/Users/bytedance/Desktop/heli/helixent_java/`。
> - 跨仓库对照（如 golden fixture 比对）可以**读取**原 TypeScript 仓库，但生成的 Java 侧文件必须落在上述目录内。

## 0. 结论先行

Helixent 适合重写为 Java，但不适合逐文件、逐语句翻译。正确方式是保留项目的行为契约和分层边界，再用 Java 的类型系统、并发模型和终端生态重新实现。

建议结论如下：

1. **采用 JDK 17 LTS，不采用 Java 8。** Java 17 仍满足“Java 20 以下”，同时提供 records、sealed types、标准 `HttpClient`、`Flow`、`ProcessHandle` 和 `jpackage`。Java 8 可以实现，但会明显增加 DTO、HTTP、流式处理和打包成本。
2. **保持四层架构和 provider 适配区。** `foundation <- agent <- coding <- cli`，OpenAI/Anthropic provider 只依赖 `foundation`。
3. **不使用 Spring Boot。** 本项目是嵌入式 Agent 库和本地 CLI，Spring Boot 会放大启动时间、包体、反射和配置复杂度。
4. **不使用 LangChain4j 接管核心 Agent Loop。** 可以参考或局部集成其 provider 能力，但不能让它替代当前的 Message、Tool、Middleware、Agent Loop，否则重写会变成行为不同的另一个项目。
5. **模型协议优先直接实现。** 使用 JDK `HttpClient`、Jackson 和自有 SSE 解码器，保留 OpenAI 兼容端点、非标准 `reasoning_content`、Anthropic thinking signature 和累计快照语义。
6. **TUI 使用 JLine 3 重写。** 保留输入历史、斜杠命令、审批、提问、活动消息区和 scrollback，但不追求 Ink/React 的像素级一致。
7. **第一交付物是 shaded JAR 和启动脚本。** 使用 `jpackage` 生成分平台安装包；GraalVM Native Image 仅作为后续可选项，不作为首版阻塞条件。

## 1. 原项目理解与重写边界

### 1.1 项目规模与当前技术栈

当前源码约 10,088 行 TypeScript/TSX，`src` 下 141 个源码文件、34 个测试文件。实测基线为：

```text
223 pass
0 fail
351 expect() calls
```

当前主要技术栈：

| 领域       | 当前实现                         | 主要职责                          |
| -------- | ---------------------------- | ----------------------------- |
| 语言与运行时   | TypeScript 5、Bun             | 类型、运行、文件 I/O、子进程、测试、打包        |
| Agent    | 自研 ReAct Loop                | think/act/observe、并行工具、中间件、取消 |
| Schema   | Zod 4                        | 参数校验、TS 类型推导、JSON Schema 生成   |
| 模型       | OpenAI SDK、Anthropic SDK     | 普通调用、流式调用、消息和工具转换             |
| CLI      | Commander                    | 子命令和参数解析                      |
| TUI      | Ink、React 19                 | 状态驱动终端 UI、输入、审批、提问            |
| 配置       | YAML、Zod                     | 模型配置、默认模型                     |
| Settings | JSON、Zod                     | 用户/项目/本地三层权限配置                |
| Skills   | gray-matter                  | `SKILL.md` frontmatter 读取     |
| Markdown | ink-markdown、marked-terminal | 终端 Markdown 渲染                |
| 测试       | `bun:test`                   | 单元测试和文件系统测试                   |
| 分发       | `bun build --compile`、npm    | 单文件二进制和 npm 包                 |

### 1.2 功能清单

Java 重写需要覆盖以下功能面：

- Foundation：
  - 四类 Message：system、user、assistant、tool。
  - 五类 Content：text、image URL、thinking、tool use、tool result。
  - Model 与 ModelProvider 抽象。
  - Tool 定义、参数 Schema、调用和结构化结果。
- Agent：
  - ReAct 多步循环，默认最多 100 步。
  - 模型流式累计快照。
  - 同一步多个工具并发执行。
  - 工具结果按完成顺序逐条回写。
  - 八个中间件生命周期钩子。
  - 统一结果归一化、错误分类和长度控制。
  - Skills 渐进式加载。
  - Todo 工具和提醒中间件。
- Coding：
  - 自动加载项目根目录 `AGENTS.md`。
  - 编码 Agent 系统提示词和工具装配。
  - `bash`、`read_file`、`write_file`、`str_replace`。
  - `list_files`、`glob_search`、`grep_search`、`file_info`。
  - `mkdir`、`move_path`、`apply_patch`。
  - 危险工具审批和项目级 allow list。
  - `ask_user_question` 阻塞式人机提问。
- Provider：
  - OpenAI Chat Completions 及兼容端点。
  - Anthropic Messages API。
  - text、thinking、tool call、tool result、token usage。
  - SSE/事件流累积和取消。
- CLI/TUI：
  - 首次运行模型配置向导。
  - model add/list/remove/set-default。
  - 交互式会话、输入历史、斜杠命令和 Skills 命令。
  - 审批表单、多问题单选/多选表单、Todo 展示。
  - Token 用量和终端 scrollback。

### 1.3 必须保持的行为契约

这些契约比类名和文件名更重要，迁移测试必须直接覆盖：

1. `Message` 是跨层唯一会话数据源，provider wire DTO 不得泄漏到 Agent 层。
2. provider 的每次流式产出是**完整累计快照**，不是单个增量 token。
3. Agent 只有在最终 AssistantMessage 不含 `tool_use` 时正常停止。
4. 同一步工具并发启动，但 ToolMessage 按完成顺序写入 transcript。
5. 每个 tool use 生成独立 ToolMessage，并通过 ID 与调用关联。
6. 单个工具失败转成 ToolResult，不得使整组工具调用失败。
7. 中间件按注册顺序串行执行。
8. `beforeToolUse` 可以短路工具，并提供替代结果。
9. 取消必须贯穿模型 HTTP 请求、工具 Future 和子进程。
10. Skills 只把元数据注入 prompt，正文由模型按需读取。
11. 危险操作只有“单次允许”“项目永久允许”“拒绝”三种决定。
12. tool result 回喂模型前必须执行按工具分类的截断策略。

### 1.4 非目标

首版 Java 重写不包含：

- 把 CLI 改造成 Web 服务或桌面应用。
- 引入数据库、分布式任务或远程 Agent。
- 增加原项目不存在的 MCP、RAG、向量库、多 Agent 调度。
- 改成 Spring Bean 驱动的应用框架。
- 保证 TypeScript 公共 API 的源码兼容。
- 首版即支持 Windows 的全部 shell 行为。
- 首版即产出所有平台通用的单个原生可执行文件。

## 2. Java 版本决策

### 2.1 建议版本：Java 17

Java 17 是本项目最合适的“20 以下”版本：

| 能力                      | Java 8 | Java 11 | Java 17 |
| ----------------------- | ------ | ------- | ------- |
| LTS                     | 是      | 是       | 是       |
| 标准 HTTP Client          | 否      | 是       | 是       |
| `Flow` Reactive Streams | 否      | 是       | 是       |
| records                 | 否      | 否       | 是       |
| sealed types            | 否      | 否       | 是       |
| pattern matching 基础能力   | 否      | 否       | 是       |
| `ProcessHandle`         | 否      | 是       | 是       |
| `jpackage`              | 否      | 否       | 是       |
| 对 Message 联合类型的表达力      | 弱      | 弱       | 强       |
| 建议                      | 不建议    | 可行但不优   | **推荐**  |

### 2.2 为什么不选 Java 8

Java 8 并非不能实现，但会产生以下额外成本：

- 所有 Message/Content 变体都需要普通 POJO、visitor 或手工类型标记。
- 需要额外 HTTP 库和 SSE 库。
- 没有 sealed type，穷举处理依赖约定和测试。
- 没有 `jpackage`，分发只能依赖外部 JRE、脚本或第三方打包器。
- 取消和进程管理能力更弱。
- 代码量预计增加 20% 至 30%，核心模型也更容易出现非法状态。

如果组织环境硬性限定 Java 8，应单独形成兼容性分支，而不是让主实现同时兼容 8/17。

### 2.3 编译和运行约束

- Maven Compiler 使用 `<release>17</release>`。
- CI 使用 Temurin 17。
- 禁止依赖 Java 18/19/20 API。
- 不启用 preview features。
- 构建产物必须在干净的 JRE 17 环境验证。

## 3. 目标架构

### 3.1 Maven 多模块结构

> 根目录固定为 `/Users/bytedance/Desktop/heli/helixent_java/`，下述所有模块与文件均创建在该目录内（见文档顶部“代码落地目录”约束）。

```text
helixent-java/                      # = /Users/bytedance/Desktop/heli/helixent_java/
├── pom.xml
├── helixent-foundation/
├── helixent-agent/
├── helixent-coding/
├── helixent-provider-openai/
├── helixent-provider-anthropic/
├── helixent-cli/
├── helixent-test-support/
└── distribution/
```

模块职责：

| Java 模块                       | 对应源码                      | 职责                                |
| ----------------------------- | ------------------------- | --------------------------------- |
| `helixent-foundation`         | `src/foundation`          | Message、Model、Tool、Schema、基础结果    |
| `helixent-agent`              | `src/agent`               | Agent Loop、中间件、Skills、Todos、结果管线  |
| `helixent-coding`             | `src/coding`              | Coding Agent、文件/搜索/命令工具、审批和提问     |
| `helixent-provider-openai`    | `src/community/openai`    | OpenAI 兼容协议和流式累积                  |
| `helixent-provider-anthropic` | `src/community/anthropic` | Anthropic 协议和流式事件累积               |
| `helixent-cli`                | `src/cli`                 | 配置、命令、TUI、应用装配                    |
| `helixent-test-support`       | 无直接对应                     | fake provider、SSE fixture、临时工作区辅助 |
| `distribution`                | `package.json` 构建脚本       | shaded JAR、脚本、jpackage            |

### 3.2 依赖方向

```text
                        helixent-cli
                 /          |           \
                v           v            v
    helixent-coding   provider-openai   provider-anthropic
          |   \             |                  |
          |    v            |                  |
          | helixent-agent  |                  |
          |       |         |                  |
          +-------+---------+------------------+
                          |
                          v
                 helixent-foundation
```

约束：

- `foundation` 不依赖任何上层模块。
- `agent` 不得依赖 `coding`、provider 或 CLI。
- provider 不得依赖 `agent`、`coding` 或 CLI。
- `coding` 可以依赖 `agent` 与 `foundation`。
- 只有 CLI 负责最终装配。
- 使用 ArchUnit 将以上规则变为自动化测试。

### 3.3 建议 Java 包名

```text
io.github.magiccube.helixent.foundation
io.github.magiccube.helixent.agent
io.github.magiccube.helixent.coding
io.github.magiccube.helixent.provider.openai
io.github.magiccube.helixent.provider.anthropic
io.github.magiccube.helixent.cli
```

最终 groupId 需要项目所有者确认；在确认前不要把临时 groupId 发布到 Maven Central。

## 4. 关联技术栈

### 4.1 生产依赖

具体补丁版本应在 Provider/TUI PoC 后通过 Maven BOM 锁定；下表先锁定技术路线和主版本范围。

| 领域           | 建议技术                                                              | 替代对象                              | 选择理由                                |
| ------------ | ----------------------------------------------------------------- | --------------------------------- | ----------------------------------- |
| JDK          | Temurin/OpenJDK 17                                                | Bun Runtime                       | LTS、标准 HTTP、records/sealed、jpackage |
| 构建           | Maven 3.9 + Maven Wrapper                                         | Bun package scripts               | 多模块、发布、依赖管理成熟                       |
| CLI          | Picocli 4.x                                                       | Commander                         | 子命令、校验、帮助和 completion 成熟            |
| Terminal     | JLine 3.x                                                         | Ink、React、ink-text-input          | 原始终端、行编辑、历史、补全、ANSI                 |
| JSON         | Jackson 2.x                                                       | `JSON.parse/stringify`            | tree model、record 绑定、未知字段透传         |
| YAML         | Jackson YAML 或 SnakeYAML Engine 2.x                               | `yaml`                            | `config.yaml` 读写和校验                 |
| Bean 校验      | Jakarta Validation 3.x + Hibernate Validator 8.x                  | Zod runtime validation            | record/DTO 参数约束                     |
| JSON Schema  | victools jsonschema-generator 4.x                                 | Zod `toJSONSchema()`              | 从 Java 输入类型生成 tool schema           |
| Markdown AST | commonmark-java 0.2x                                              | gray-matter、marked                | Markdown 解析和可控 ANSI 渲染              |
| Frontmatter  | commonmark YAML frontmatter extension 或 SnakeYAML                 | gray-matter                       | 读取 `SKILL.md` 元数据                   |
| HTTP         | `java.net.http.HttpClient`                                        | OpenAI/Anthropic JS SDK transport | 零额外运行时、支持异步与取消                      |
| SSE          | 自有小型 SSE decoder，基于 `Flow.Subscriber<String>`                     | SDK async iterable                | 保留厂商事件和兼容端点扩展字段                     |
| 并发           | `ExecutorService`、`ExecutorCompletionService`、`CompletableFuture` | Promise、Promise.race              | Java 17 下实现有界并发和完成顺序                |
| Reactive API | `java.util.concurrent.Flow`                                       | AsyncGenerator                    | 标准化 stream、backpressure、cancel      |
| 日志           | SLF4J 2.x + Logback                                               | console warn/error                | 避免日志破坏 TUI，可写入文件                    |

### 4.2 测试与质量依赖

| 领域      | 建议技术                              | 用途                            |
| ------- | --------------------------------- | ----------------------------- |
| 单元测试    | JUnit Jupiter 5                   | 对应 `bun:test`                 |
| 断言      | AssertJ                           | 结构化对象和集合断言                    |
| Mock    | Mockito，仅限协作者边界                   | Model、Persistence、UI callback |
| 异步断言    | Awaitility                        | 队列、取消和事件时序                    |
| HTTP 测试 | MockWebServer 或 JDK 本地 HttpServer | SSE 和 provider wire fixture   |
| 文件测试    | JUnit `@TempDir`                  | 替代 `mkdtemp`/cleanup          |
| 架构测试    | ArchUnit                          | 模块和包依赖方向                      |
| 覆盖率     | JaCoCo                            | 趋势检查，不以 100% 为目标              |
| 格式化     | Spotless + google-java-format     | 确定性格式                         |
| 静态分析    | Maven Enforcer、SpotBugs           | JDK/依赖约束和常见缺陷                 |
| CI      | GitHub Actions                    | `mvn verify`、多系统冒烟            |

### 4.3 构建和分发

- `mvnw verify`：编译、格式检查、单测、架构测试。
- `mvnw package`：生成库 JAR 和 CLI shaded JAR。
- Unix 启动脚本：`bin/helixent`。
- Windows 启动脚本：可在 Windows 支持阶段增加 `helixent.cmd`。
- `jpackage`：分别产出 macOS、Linux、Windows 安装包或 app image。
- Maven Central：发布 foundation、agent、coding 和 provider 模块。
- GraalVM Native Image：后续评估，不能影响首版 API 设计。

### 4.4 明确不采用的栈

| 技术               | 不采用原因                                            |
| ---------------- | ------------------------------------------------ |
| Spring Boot      | CLI 场景过重；启动、包体、反射和日志接管成本高                        |
| LangChain4j 作为核心 | 会替换而非重写当前 Agent/Tool/Message 契约                  |
| Reactor 作为公共 API | 增加额外响应式抽象；JDK Flow 足够表达当前需求                      |
| JavaFX/Swing     | 目标是终端产品，不是桌面 GUI                                 |
| 数据库              | 当前状态只需会话内存和本地配置文件                                |
| 首版强制 GraalVM     | 终端、反射 Schema、Jackson 和动态 DTO 会提高 native-image 成本 |

## 5. 核心对象设计

### 5.1 Message 与 Content

使用 sealed interface + record 表达 TypeScript discriminated union：

```java
public sealed interface Message
    permits SystemMessage, UserMessage, AssistantMessage, ToolMessage {}

public sealed interface Content
    permits TextContent, ImageUrlContent, ThinkingContent,
            ToolUseContent, ToolResultContent {}
```

设计要求：

- 内部字段使用 camelCase。
- snake\_case 只存在于 provider wire DTO。
- `AssistantMessage` 持有 `List<AssistantContent>`、`TokenUsage` 和 `streaming`。
- 列表在构造时 defensive copy，避免 provider 快照被后续累积器修改。
- thinking signature 使用通用 opaque metadata 保存，例如
  `Map<String, JsonNode> providerMetadata`，不在 foundation 定义 Anthropic 专有字段。
- Jackson 多态注解只用于必要的持久化或测试 fixture；内部运行不依赖反序列化魔法。

### 5.2 Model 与 Provider

建议契约：

```java
public interface ModelProvider {
    CompletionStage<AssistantMessage> invoke(ModelProviderRequest request);
    Flow.Publisher<AssistantMessage> stream(ModelProviderRequest request);
}
```

`Model` 继续负责：

- 把 prompt 转成首条 SystemMessage。
- 拼接 transcript。
- 传递 tools、options 和 CancellationToken。
- 不包含任何厂商协议判断。

`ModelOptions` 应同时提供：

- 常用强类型字段：maxTokens、temperature、thinking。
- `Map<String, JsonNode> extensions`：保留 provider-specific 透传能力。

### 5.3 Tool、参数校验和 JSON Schema

Zod 在原项目中同时承担类型推导、运行时校验、JSON Schema 生成。Java 需组合实现：

```java
public interface Tool<I> {
    String name();
    String description();
    Class<I> inputType();
    JsonNode inputSchema();
    CompletionStage<?> invoke(I input, CancellationToken cancellation);
}
```

调用过程：

1. provider 把 tool input 解析为 `JsonNode`。
2. ToolRegistry 按 name 查找工具。
3. Jackson 将 `JsonNode` 映射为输入 record。
4. Hibernate Validator 执行约束校验。
5. 调用工具并返回 raw result。
6. ToolResultRuntime 归一化并序列化。

约束：

- 每个工具输入定义独立 record。
- `description` 仍是第一个声明字段。
- Schema 在启动时生成并缓存。
- 启动时检查工具名唯一、Schema 可生成、输入类型可反序列化。
- 未知字段是否拒绝需全局一致，建议首版拒绝以尽早暴露模型错误。

### 5.4 CancellationToken

不能只依赖 `Future.cancel()`。需要一个项目级取消对象，负责注册清理动作：

- 取消 `Flow.Subscription`。
- 取消 HTTP `CompletableFuture`。
- 中断等待线程。
- `Process.destroy()`，超时后 `destroyForcibly()`。
- 从 approval/question queue 中移除未响应请求。

取消必须幂等，且统一抛出 `AgentCancelledException`，CLI 将其视为正常停止而不是错误消息。

## 6. 详细文档章节大纲

以下章节沿用原 21 节源码路线，改为“Java 目标设计 + 迁移验收”的写法。每章均应包含：原行为、Java 设计、关键接口、时序、异常、测试、与前后章节的依赖。

> **强制约束（每章完成即验证）：** 本大纲的每一章都必须给出一组“章节完成验证（Definition of Done）”步骤。规则如下：
>
> 1. 每章结尾的“章节完成验证”必须是**可执行命令**或**可观察结果**，不得只写“已完成/基本支持”这类主观结论。
> 2. 验证步骤要能被独立运行：优先给出 `mvn -pl <module> test`、具体测试类名、CLI 命令或 fixture 对照方式。
> 3. 只有当该章的验证步骤全部通过时，才允许标记该章完成并进入下一章；未通过时必须留在本章修复。
> 4. 每章验证必须包含**回归项**：运行到当前为止已完成模块的测试，确保新章节没有破坏既有行为（即 `mvn verify` 或等价命令保持全绿）。
> 5. 验证结果需登记到第 12.3 节的 Parity Matrix，并标记 `Exact` / `Compatible` / `Changed(C-xx)` / `Deferred` 之一。
>
> 下文每章的“章节完成验证”即为该章的最小验收门槛，执行方式统一遵循以上五条。

> **强制约束（每章先出改动文档）：** 每开始实现一章，必须**先**在 `helixent_java/distribution/change-notes/` 下生成该章的技术文档，再写实现代码。规则如下：
>
> 1. 文件命名：`chapter-NN-<topic-slug>.md`（如 `chapter-03-model-and-modelprovider.md`），`NN` 为两位章号。
> 2. 文档中引用代码/文件时，必须写成**可点击的 Markdown 相对链接** `[显示名](相对路径)`，而非仅用反引号包裹的纯文本路径。规则：
>    - 相对路径基准为该文档所在目录 `helixent_java/distribution/change-notes/`；指向工程内文件通常以 `../../` 开头（如 `[Model.java](../../helixent-foundation/src/main/java/.../model/Model.java)`）。
>    - 参考项目内可正常跳转的范例写法：`../helixent/docs/tutorial/00-roadmap.md` 中的相对链接。
>    - 文件清单表格里的每个文件名都应是链接；正文散文中首次出现的关键文件也尽量链接化。
>    - 经验教训：纯反引号文本（如 `` `Model.java` ``）在 IDE/预览里不可点击；链接显示名不要写成带省略号的截断路径（如 `.../Model.java`），否则部分渲染器不会生成可点击热区。
> 3. 文档必须包含以下小节：
>    - 本章目标回顾；
>    - 主要改动点（新增/修改的文件清单 + 职责，文件名以相对链接给出）；
>    - 与原 TypeScript 的不同点、为什么这样写、以及每处改动的优点与缺点/风险；
>    - 测试与桩的设计说明；
>    - 验收结果（对应本章“章节完成验证”的命令与结论）；
>    - 遗留衔接点（供后续章节注意）。
> 4. 实现完成后必须回填文档：核对文中引用的相对链接**全部真实存在且可点击跳转**（可用脚本按 `../../` 解析逐一验证目标文件存在），并补齐验收结果。
> 5. 该文档是本章交付物的一部分；缺失、路径失真或链接不可点击视为本章未完成。

### 第一部分：重写全景

#### 第 1 章：项目全景、重写目标与四层架构

- 说明现有 Bun/TypeScript 项目的产品边界。
- 给出一次用户请求在 Java 模块中的完整数据流。
- 明确 Maven 模块、包名、依赖方向和公开 API。
- 说明库入口与 CLI 入口的区别。
- 产物：目标架构图、模块 POM、ArchUnit 规则。
- 章节完成验证：
  - `mvn -q -DskipTests package` 能构建全部空模块骨架。
  - `mvn -pl helixent-foundation test` 运行 ArchUnit 规则，验证 `foundation` 不依赖任何其他模块。
  - `mvn verify` 运行 `helixent-cli` 内的完整分层规则（校验 `agent`/`coding`/provider/`cli` 的方向，其中 provider 只依赖 `foundation`）。
  - 依赖方向违规时构建必须失败（故意加一条反向依赖做一次红灯验证）。
  - 分层校验拆两处的原因：`foundation` 是最底层，其类路径看不到上层模块，无法在其中判断 provider/agent 的依赖；完整分层规则放在依赖全部模块的 `helixent-cli`，由 `mvn verify` 覆盖。
  - 执行结果（基线 `ec6e188`，JDK 17.0.17 / Maven 3.9.11）：
    - 验证①：`BUILD SUCCESS`，产出 7 个模块 JAR。
    - 验证②：`helixent-foundation` 1 条规则通过；`mvn verify` 追加 `helixent-cli` 3 条规则全绿。
    - 验证③：临时加入 `provider-openai -> agent` 反向依赖后 `BUILD FAILURE`，ArchUnit 精确定位违规；还原后 `mvn clean verify` 恢复全绿。

### 第二部分：Foundation

#### 第 2 章：Message 类型系统

- 将 role/type 双层联合映射为 sealed interface + record。
- 定义 text、image URL、thinking、tool use、tool result。
- 定义 TokenUsage、streaming 和 provider opaque metadata。
- 定义不可变性、equals/hashCode、序列化边界。
- 章节完成验证：
  - `mvn -pl helixent-foundation test -Dtest=MessageTypeTest` 覆盖四类 Message、五类 Content 的构造与穷举访问。
  - 断言 sealed 层次穷举 `switch` 无 default 分支仍能编译（编译期即校验完整性）。
  - 用一条测试断言 provider wire DTO 类型不出现在 `foundation` 公开 API 中。
  - 回归：`mvn -pl helixent-foundation test` 全绿。

#### 第 3 章：Model 与 ModelProvider

- 定义 invoke 和 stream 两条调用路径。
- 规定累计快照、最终帧和空流错误。
- 定义 ModelContext、ModelOptions、CancellationToken。
- 说明系统 prompt 的拼装位置。
- 章节完成验证：
  - `mvn -pl helixent-foundation test -Dtest=FakeProviderTest` 断言 `stream` 的最后一帧与 `invoke` 返回值逐字段相等。
  - 断言每次 `stream` 产出都是完整累计快照（后一帧包含前一帧全部内容）。
  - 断言空流抛出预期异常、系统 prompt 出现在消息序列首位。
  - 回归：`mvn -pl helixent-foundation test` 全绿。

#### 第 4 章：Tool、Schema 与结构化结果

- 定义 Tool、ToolRegistry 和 ToolInvoker。
- 说明 record + validation + JSON Schema 的组合。
- 定义 success/error 两类 ToolResult。
- 保留错误码命名、description 第一字段和 provider tool schema。
- 章节完成验证：
  - `mvn -pl helixent-foundation test -Dtest=ToolSchemaTest` 验证 record → JSON Schema 生成、参数校验和调用链路。
  - 对每个内置工具生成的 JSON Schema 与保存的 golden 文件比对（首版可先落 1 个示例工具）。
  - 断言 `description` 为参数首字段、错误码为 SCREAMING\_SNAKE，异常被转为 error ToolResult 而非抛出。
  - 回归：`mvn -pl helixent-foundation test` 全绿。

### 第三部分：Agent

#### 第 5 章：ReAct 主循环

- 定义 AgentSession、AgentContext、AgentEvent。
- 描述 append user -> before run -> step -> model -> tool -> next step。
- 保留非重入检查、maxSteps=100 和 transcript 单一来源。
- 说明 Publisher 的订阅、背压和终止。
- 章节完成验证：
  - `mvn -pl helixent-agent test -Dtest=ReactLoopTest` 覆盖：无 tool\_use 即停止、有 tool\_use 继续、达到 maxSteps=100 熔断、空模型流报错。
  - 断言重入调用 `stream` 抛出“已在运行”异常。
  - 断言 transcript 为唯一状态源（循环结束后消息序列可完整回放）。
  - 回归：`mvn -pl helixent-foundation,helixent-agent test` 全绿。

#### 第 6 章：并行工具调度和完成顺序

- 使用有界 ExecutorService 和 ExecutorCompletionService。
- 工具任务并发提交，完成一个发布一个 ToolMessage。
- 单任务异常转 ToolResult，其他任务继续。
- 取消时撤销未完成 Future 和子进程。
- 章节完成验证：
  - `mvn -pl helixent-agent test -Dtest=ParallelToolTest`：注入人工延迟工具，断言 ToolMessage 按**完成顺序**而非提交顺序写入。
  - 断言单个工具抛异常时其结果转为 error ToolResult，其余工具仍完成。
  - 断言每个 tool\_use 生成独立 ToolMessage 且 ID 对应。
  - 取消用例：断言取消后未完成 Future 被 cancel、无残留线程/子进程。
  - 回归：`mvn -pl helixent-foundation,helixent-agent test` 全绿。

#### 第 7 章：Middleware 生命周期

- 定义 4 对 8 个 hook。
- 保留顺序执行。
- 用强类型 ContextPatch 代替 `Object.assign`。
- `beforeToolUse` 返回 Continue 或 Skip(result)。
- 说明 middleware 异常策略。
- 章节完成验证：
  - `mvn -pl helixent-agent test -Dtest=MiddlewareTest`：断言多个 middleware 按注册顺序串行执行（记录调用序列）。
  - 断言 ContextPatch 合并语义与 `Object.assign` 一致（返回空即无操作）。
  - 断言 `beforeToolUse` 返回 Skip 时跳过真实工具并回填替代结果。
  - 断言 middleware 异常按既定策略传播（不被静默吞掉）。
  - 回归：`mvn -pl helixent-foundation,helixent-agent test` 全绿。

#### 第 8 章：Tool Result 管线

- 移植 normalize、error kind、policy 和 summary。
- 保留 read\_file 裸文本特例。
- 保留 1000/4000/12000 等长度策略。
- 确保所有截断结果仍是合法 JSON。
- 章节完成验证：
  - `mvn -pl helixent-agent test -Dtest=ToolResultPipelineTest`，用例直接移植原 `tool-result-runtime` / `tool-result-policy` / `tool-result-summary` 断言。
  - 断言 `read_file` 裸文本特例、error kind 前后缀推断、1000/4000/12000 截断策略。
  - 对超长输入断言截断后仍能 `JSON.parse` 成功。
  - 回归：`mvn -pl helixent-foundation,helixent-agent test` 全绿。

#### 第 9 章：Skills 渐进式加载

- 扫描多个目录、展开 `~`、按解析后的 SKILL.md 路径去重。
- 解析 name、description、path。
- 每次 run 发现 Skills，每次 model 调用注入元数据。
- 显式 `/skill` 优先加载。
- 章节完成验证：
  - `mvn -pl helixent-agent test -Dtest=SkillDiscoveryTest`：用临时目录覆盖同名不同路径、重复目录、缺失 SKILL.md、无权限目录场景。
  - 断言只有 frontmatter（name/description/path）被注入 prompt，正文不注入。
  - 断言显式 `/skill` 请求时该技能被优先加载。
  - 回归：`mvn -pl helixent-foundation,helixent-agent test` 全绿。

#### 第 10 章：Todos

- TodoStore 代替闭包数组。
- TodoTool 和 TodoReminderMiddleware 共享同一个 session store。
- 保留 merge/replace、四种状态和 10 步提醒阈值。
- 保留 UI 从 tool input 重建 snapshot 的能力。
- 章节完成验证：
  - `mvn -pl helixent-agent test -Dtest=TodoSystemTest`：移植原 todos 用例（merge/replace、四状态计数、空列表）。
  - 断言 10 步未写入触发提醒、写入后计数归零。
  - 断言从 tool input 可重建与 store 一致的 snapshot。
  - 回归：`mvn -pl helixent-foundation,helixent-agent test` 全绿。

### 第四部分：Coding

#### 第 11 章：Coding Agent 装配

- 读取 `AGENTS.md` 并作为 seed UserMessage 注入。
- 移植系统 prompt 和工具顺序。
- 装配 Skills、Todos、Approval middleware。
- 注入 cwd、question handler 和 persistence。
- 章节完成验证：
  - `mvn -pl helixent-coding test -Dtest=CodingAgentAssemblyTest`：断言有/无 `AGENTS.md` 时 seed 消息的注入行为。
  - 断言工具装配顺序、三个 middleware 顺序与原 `lead-agent` 一致。
  - 断言不传交互回调时可构建“无审批/无提问”的可运行 Agent。
  - 回归：`mvn -pl helixent-foundation,helixent-agent,helixent-coding test` 全绿。

#### 第 12 章：文件读写工具

- Java NIO 实现绝对路径校验、目录校验和文本截断。
- `read_file` 保留整文件裸文本、范围读取行号和 12000 字符上限。
- `write_file` 自动建父目录并覆盖。
- `str_replace` 按源码实际行为支持全部或 count 次替换。
- 章节完成验证：
  - `mvn -pl helixent-coding test -Dtest=ReadFileTest,WriteFileTest,StrReplaceTest`，移植原 happy path、错误码、范围与边界用例。
  - 断言 `read_file` 整文件裸文本、范围行号、12000 上限；`write_file` 自动建父目录；`str_replace` 全部/count 次语义。
  - 用临时目录 + 用后清理执行文件系统测试，断言相对路径返回 `INVALID_PATH`。
  - 回归：`mvn -pl helixent-foundation,helixent-agent,helixent-coding test` 全绿。

#### 第 13 章：搜索与系统工具

- `list_files` 使用 `Files.walkFileTree`，保持排序、深度、数量限制。
- `glob_search` 使用 PathMatcher，并定义支持的 glob 子集。
- `grep_search` 首选外部 `rg`，保留 exit code 0/1 语义。
- `bash` 使用 `ProcessBuilder`，首版 Unix shell 为 `zsh -c`。
- `file_info`、`mkdir`、`move_path` 使用 NIO。
- 章节完成验证：
  - `mvn -pl helixent-coding test -Dtest=ListFilesTest,GlobSearchTest,GrepSearchTest,BashToolTest,FileInfoTest,MkdirTest,MovePathTest`。
  - `bash`/`grep_search` 用例用 `assumeTrue`（等价原 `skipIf`）在缺少 zsh/rg 时跳过而非失败。
  - 断言 `grep_search` 保留 exit code 0/1 语义、rg 缺失返回 `RG_NOT_FOUND`；断言进程可被取消、无残留子进程。
  - 回归：`mvn -pl helixent-foundation,helixent-agent,helixent-coding test` 全绿。

#### 第 14 章：apply\_patch

- 原样移植 PatchFile、PatchHunk、HunkLine 数据模型。
- 保留 hunk count 校验、context/delete 逐行硬比对。
- 保留绝对路径要求和不支持 `/dev/null` 删除。
- 明确 CRLF、末尾换行、多文件补丁和部分写入策略。
- 章节完成验证：
  - `mvn -pl helixent-coding test -Dtest=ApplyPatchTest`：移植原 3 个用例（简单补丁、拒绝 `/dev/null`、hunk 计数不匹配）。
  - 补充多 hunk、多文件、CRLF、末尾换行和“中途失败”的写入行为用例。
  - 断言绝对路径要求、context/delete 逐行硬比对导致的漂移检测。
  - 回归：`mvn -pl helixent-foundation,helixent-agent,helixent-coding test` 全绿。

#### 第 15 章：Human-in-the-Loop

- 提取通用 SingleActiveRequestQueue，但保留 Approval/Question 类型边界。
- 队列上限 20。
- 审批溢出默认 deny，提问溢出返回错误。
- 支持取消移除、超时和订阅解绑。
- 三层 settings 合并并持久化项目 local allow list。
- 章节完成验证：
  - `mvn -pl helixent-coding test -Dtest=ApprovalManagerTest,AskUserQuestionTest,SettingsTest`：断言 FIFO、单活跃、空队列通知 null、订阅解绑。
  - 断言审批溢出默认 deny、提问溢出返回错误、取消可移除排队请求。
  - 断言三层 settings 合并、`allow_always_project` 持久化到 project-local，且持久化失败不影响主流程。
  - 回归：`mvn -pl helixent-foundation,helixent-agent,helixent-coding test` 全绿。

### 第五部分：Provider

#### 第 16 章：OpenAI 兼容 Provider

- 继续使用 Chat Completions，不在首版切 Responses API。
- system/user/assistant/tool 消息逐类转换。
- thinking 映射非标准 `reasoning_content`。
- tool input 分段 JSON 累积，解析成功前不暴露 tool use。
- 最终帧同时识别 usage 和 `[DONE]`，修复兼容端点不返回 usage 的问题。
- 支持自定义 base URL、API key、options 和 timeout。
- 章节完成验证：
  - `mvn -pl helixent-provider-openai test`：用保存的 SSE fixture 断言消息/工具双向转换、`reasoning_content` 映射。
  - 断言分段 tool JSON 解析成功前不暴露 tool\_use、最终帧兜底空 input。
  - 断言最终帧识别 usage 与 `[DONE]`（构造一个不返回 usage 的兼容端点 fixture 验证结束判定）。
  - 全程不调用真实模型；回归：`mvn -pl helixent-foundation,helixent-provider-openai test` 全绿。

#### 第 17 章：Anthropic Provider

- system prompt 使用顶层 system 字段。
- ToolMessage 转换成 user/tool\_result block。
- thinking signature 往返保存。
- thinking 启用时默认 budget 为 maxTokens 的 80%。
- 按 block index 保持内容顺序。
- 章节完成验证：
  - `mvn -pl helixent-provider-anthropic test`：用事件 fixture 断言 text、image URL、thinking、tool\_use、usage 转换。
  - 断言 thinking signature 往返保留、thinking 启用时 budget 默认 = maxTokens 的 80%。
  - 断言按 block index 保持顺序、残缺 tool JSON 暂返回空 input。
  - 全程不调用真实模型；回归：`mvn -pl helixent-foundation,helixent-provider-anthropic test` 全绿。

### 第六部分：CLI/TUI

#### 第 18 章：CLI、配置和持久化

- Picocli 实现 config model 四个子命令。
- `HELIXENT_HOME` 默认 `~/.helixent`。
- `config.yaml` 保持字段兼容：models、defaultModel、provider。
- 配置使用临时文件 + atomic move。
- settings 保持 user/project/project-local 三层合并。
- history 保留 100 条和相邻去重。
- 章节完成验证：
  - `mvn -pl helixent-cli test -Dtest=ConfigCommandTest,SettingsMergeTest`：断言 model add/list/remove/set-default 行为。
  - 用一份原 TypeScript 版生成的 `config.yaml` fixture，断言 Java 端能原样读取（models/defaultModel/provider 字段兼容）。
  - 断言配置写入走临时文件 + atomic move、history 保留 100 条并相邻去重。
  - 回归：`mvn verify`（截至第 18 章的全部模块）全绿。

#### 第 19 章：TUI 状态机

- 使用单 UI event loop，Agent 在后台 Executor 运行。
- 定义 Idle、Streaming、AwaitingApproval、AwaitingQuestion、Stopping。
- AgentEvent 进入 UI queue，禁止后台线程直接写终端。
- 已完成消息写入 scrollback，活动消息用 JLine Display 重绘。
- 审批和提问互斥显示。
- 章节完成验证：
  - `mvn -pl helixent-cli test -Dtest=TuiStateMachineTest`：断言 Idle/Streaming/AwaitingApproval/AwaitingQuestion/Stopping 状态迁移。
  - 断言后台线程只经 UI queue 更新界面（并发投递大量事件后顺序稳定、无数据竞争）。
  - PTY 冒烟：脚本化启动 → 输入 → 触发审批 → Ctrl-C 取消 → 恢复输入 → 退出；断言取消被当作正常停止。
  - 回归：`mvn verify` 全绿。

#### 第 20 章：输入、命令和渲染

- JLine LineReader 提供编辑、history 和 completion。
- 保留 `/clear`、`/exit`、`/quit`、`/help`。
- Skills 动态注册为 slash command。
- 审批保留 y/a/n 与方向键。
- 提问保留 1 至 4 个问题、2 至 4 个选项、单选/多选和确认页。
- Markdown 支持标题、段落、列表、行内代码、代码块、强调和链接文本。
- 章节完成验证：
  - `mvn -pl helixent-cli test -Dtest=CommandRegistryTest,InputEditorTest,MarkdownRenderTest`：以纯函数测试覆盖命令解析、补全、光标编辑与 Markdown 子集渲染。
  - 断言 `/clear`、`/exit`、`/quit`、`/help` 与 Skills 动态命令均可解析；审批保留 y/a/n 与方向键。
  - PTY 冒烟：输入斜杠命令触发补全、提交单选/多选提问并确认。
  - 回归：`mvn verify` 全绿。

### 第七部分：工程与迁移

#### 第 21 章：测试、规范、构建和发布

- 把当前 223 个测试映射为 JUnit 测试清单。
- 新增 Agent 主循环、取消、provider HTTP 和 TUI state tests。
- `mvn verify` 作为唯一质量门。
- GitHub Actions 在 macOS/Linux 验证 JDK 17。
- 输出 shaded JAR、Maven artifacts 和 jpackage。
- 章节完成验证：
  - 干净环境下 `mvn -q verify` 一条命令跑通类型编译、全部单元/组件测试与 ArchUnit 规则。
  - CI 在 macOS 与 Linux + Temurin 17 上均为绿；故意破坏一处依赖方向验证 CI 会红。
  - `java -jar helixent-cli/target/helixent-cli-shaded.jar --help` 可运行；`jpackage` 产物在目标平台安装后可启动。
  - 输出“223 个原测试 → JUnit 用例”的映射表，标记每项 `迁移/新增/暂缓`。

#### 第 22 章：双轨迁移、验收和切换

- 定义 TypeScript/Java golden fixture。
- 对同一消息、工具 Schema、provider event 比较输出。
- 先库后 CLI，先 OpenAI 后 Anthropic，最后 TUI。
- 定义灰度、回退和旧配置兼容策略。
- 形成发布检查表和遗留问题清单。
- 章节完成验证：
  - 运行双轨对照脚本：对同一 Message、工具 Schema、provider event，比较 TypeScript 与 Java 输出并生成差异报告（差异项必须映射到某个 `C-xx` 或列为缺陷）。
  - 完成第 12.3 节 Parity Matrix：所有功能项状态为 `Exact/Compatible/Changed/Deferred` 之一，无 `未知/基本支持`。
  - 用旧 `~/.helixent` 配置执行一次端到端真实任务冒烟；验证回退流程可切回 TypeScript 版本。
  - 交付发布检查表与遗留问题清单。

## 7. 难以替换的点

### 7.1 Zod 的“一处定义，三处受益”

**原能力：** 一个 Zod schema 同时提供 TypeScript 类型、运行时校验和 JSON Schema。\
**难点：** Java 的编译期类型、Bean Validation 和 JSON Schema 生成属于不同系统。\
**方案：** 使用输入 record 作为类型源，Jakarta Validation 负责运行时约束，victools 负责 Schema，启动时做一致性自检。\
**风险：** optional/default、联合类型和自定义 refine 不能保证完全自动映射。复杂工具需要手写 Schema override。\
**验证：** 对全部工具保存 JSON Schema golden files，与原 Zod 输出做语义比较。

### 7.2 AsyncGenerator 和累计快照

**原能力：** provider 与 Agent 都能 `yield`，上层使用 `for await` 自然消费。\
**难点：** Java `Flow.Publisher` 的订阅、背压、完成、异常和取消都更显式。\
**方案：** provider 发布累计 AssistantMessage；Agent 自有 Publisher 串联模型流和工具结果。\
**风险：** 错误终止、无订阅消费、慢消费者和取消时可能泄漏线程。\
**验证：** 使用只请求一个元素的 Subscriber 测试背压，并检测测试结束后无活动 worker。

### 7.3 `Promise.race` 完成顺序

**原能力：** 多工具并发，谁先完成谁先回写。\
**难点：** `CompletableFuture.allOf` 只适合全部完成，不表达逐个完成顺序。\
**方案：** `ExecutorCompletionService` 或 completion queue。\
**风险：** 工具数过多、审批阻塞占满线程池。\
**验证：** 有界线程池、每步工具数上限、延迟工具时序测试。

### 7.4 AbortSignal 全链路取消

**原能力：** 一个 AbortController 贯穿模型和工具，Bun 子进程可 kill。\
**难点：** Java HTTP、Flow、Future、阻塞队列和 Process 的取消接口不统一。\
**方案：** 自有 CancellationToken 注册清理回调，统一协调全部资源。\
**风险：** `Process.destroy()` 不一定杀掉整个子进程树。\
**验证：** 使用会派生子进程的测试脚本，并基于 ProcessHandle descendants 清理。

### 7.5 Ink/React TUI

**原能力：** React state、hook、组件和 Ink diff renderer 组合成声明式终端 UI。\
**难点：** Java 没有等价且成熟度相同的 Ink/React 生态。\
**方案：** JLine Terminal + Display + 单线程 UI 状态机，业务状态与渲染器分离。\
**风险：** scrollback、宽字符、终端 resize、光标位置和 IDE 内置终端差异。\
**验证：** 纯状态机测试、PTY 冒烟测试、macOS Terminal/iTerm2/IDE Terminal 人工矩阵。

### 7.6 Provider 的非标准字段

**原能力：** OpenAI provider 扩展 `reasoning_content`；Anthropic 保存 thinking signature。\
**难点：** 官方 Java SDK 的强类型 DTO 可能丢弃兼容端点或非标准字段。\
**方案：** provider 内使用 Jackson tree DTO 和自有 wire model，foundation 只存 opaque metadata。\
**风险：** 厂商协议升级需要维护转换器。\
**验证：** 固定真实响应脱敏 fixture，并对未知字段做容忍性测试。

### 7.7 Bun 单文件编译

**原能力：** `bun build --compile` 直接得到单文件二进制。\
**难点：** 标准 JDK 没有等价的跨平台单文件原生编译。\
**方案：** shaded JAR 为通用产物，jpackage 为带 runtime 的平台产物。\
**风险：** 包体显著增大，平台产物需要分别构建。\
**验证：** 在无预装 JDK 环境测试 jpackage，在 JRE 17 环境测试 shaded JAR。

### 7.8 Bun.Glob 与文件系统语义

**原能力：** `Bun.Glob.scan` 支持现有 glob 行为。\
**难点：** Java NIO glob 对 `**`、隐藏文件、分隔符和符号链接的细节可能不同。\
**方案：** 明确支持的 pattern 子集，统一路径标准化并建立跨平台 fixture。\
**风险：** 少数 pattern 的匹配集合与原实现不同。\
**验证：** 对 `**/*.ts`、`src/**/*.tsx`、隐藏文件和符号链接做对照测试。

### 7.9 动态 options 和运行时对象

**原能力：** TypeScript 用 `Record<string, unknown>` 透传任意 provider 参数，并可给 thinking 对象动态附加 signature。\
**难点：** Java 强类型 DTO 不适合任意属性。\
**方案：** 常用字段强类型化，扩展字段使用 `Map<String, JsonNode>`；provider metadata 同理。\
**风险：** 同名扩展字段覆盖强类型字段。\
**验证：** 合并时定义明确优先级并拒绝保留字段冲突。

## 8. 建议接受的妥协与前后变化

本节中的条目必须在实现前评审。任何新增妥协都要追加到此处，不能埋在实现细节里。

### 8.1 C-01：最低版本从“可能 Java 8”收敛为 Java 17

**为什么妥协：** Java 8 会迫使项目额外引入 HTTP、SSE、不可变 DTO 和打包基础设施，并削弱联合类型表达。\
**变更前：** 用户预期 Java 20 以下，Java 8 只是示例。\
**变更后：** 明确最低 JDK/JRE 为 17，仍满足版本低于 20。\
**影响：** 无功能损失，但不能运行在仅有 Java 8/11 的环境。\
**后续讨论点：** 是否存在必须部署到 Java 8 的真实场景；若有，单独评估兼容分支。

### 8.2 C-02：TUI 保持功能，不保证视觉逐像素一致

**为什么妥协：** JLine 是命令行编辑和终端控制库，不具备 React/Ink 完全相同的布局与 diff 算法。\
**变更前：** Ink 组件、Box 布局、React hook、50ms state batching。\
**变更后：** JLine 单线程状态机、ANSI renderer、活动区重绘。\
**保持：** 命令、历史、审批、提问、Todo、流式状态、scrollback。\
**变化：** 边框、颜色、换行、动画、窗口 resize 后布局可能不同。

### 8.3 C-03：基础分发不再是通用单文件原生二进制

**为什么妥协：** 标准 Java 17 无法生成一个跨 macOS/Linux/Windows 通用的原生文件。\
**变更前：** Bun 编译单文件可执行程序并通过 npm 分发。\
**变更后：** 通用 shaded JAR + 启动脚本；各平台用 jpackage 生成带 runtime 的产物。\
**影响：** JAR 模式要求 JRE 17；jpackage 模式包体更大。\
**后续讨论点：** 是否值得为启动速度和单文件体验引入 GraalVM。

### 8.4 C-04：首版完整支持 macOS/Linux，Windows 延后

**为什么妥协：** 原项目明确调用 `zsh -c`、`/dev/tty` 和 `rg`，本身已经偏 Unix。\
**变更前：** Bun 项目实际以 macOS/Unix 行为为主。\
**变更后：** 首版显式声明 Unix 支持；Windows 只保证非 shell 模块可运行。\
**影响：** Windows 首版不承诺 `bash`、TTY 交互和 jpackage 安装体验。\
**后续讨论点：** Windows 使用 PowerShell 还是 Git Bash，以及命令语义是否允许变化。

### 8.5 C-05：Markdown 先支持稳定子集

**为什么妥协：** `ink-markdown` 的所有视觉细节无法低成本复制。\
**变更前：** 由 Ink Markdown 组件渲染。\
**变更后：** 基于 CommonMark AST 渲染标题、列表、强调、代码、链接文本等常用结构。\
**影响：** 表格、复杂嵌套、HTML 和少见扩展可能先按纯文本显示。\
**后续讨论点：** 根据真实会话样本决定是否扩展 renderer。

### 8.6 C-06：非法 Skill 元数据改为跳过并告警

**为什么妥协：** 原实现允许无 frontmatter 的文件产生 undefined name/description，Java 强类型实现不应制造非法 Skill。\
**变更前：** 文件存在即可被发现，缺字段可能继续注入 prompt。\
**变更后：** 缺少 name 或 description 时跳过，并向日志输出文件路径和原因。\
**影响：** 某些格式不完整但以前“勉强可见”的 Skill 将不再加载。\
**后续讨论点：** 是否需要 strict/lenient 两种模式。

### 8.7 C-07：Glob 兼容承诺限定为已文档化子集

**为什么妥协：** Bun.Glob 与 Java NIO glob 的边界语义不同。\
**变更前：** 直接接受 Bun 支持的 pattern。\
**变更后：** 首版承诺 `*`、`?`、`**` 和常见扩展名模式，其他语法返回明确错误。\
**影响：** 极少数高级 glob pattern 需要改写。\
**后续讨论点：** 是否引入额外 glob 库换取更高兼容度。

## 9. 不应当妥协的部分

- 不删除 OpenAI 或 Anthropic provider。
- 不把流式调用退化为等待完整响应。
- 不把并行工具退化为串行执行。
- 不取消危险工具审批。
- 不删除 `apply_patch` 的上下文校验。
- 不把 tool result 全量无上限地回喂模型。
- 不把 Skills 全文一次性注入 prompt。
- 不用 provider SDK 类型替代内部 Message。
- 不因 TUI 重写而改变 Agent、Coding 或 Provider 的公共契约。

## 10. 原项目中需要先确认的差异与风险

这些不是 Java 带来的问题，但重写时必须决定“复制现状”还是“顺便修正”。

| 编号   | 现状                                        | Java 建议                       |
| ---- | ----------------------------------------- | ----------------------------- |
| R-01 | `str_replace` 文档强调 old 唯一，源码实际可替换多次       | 以源码为兼容基线，并修正文档                |
| R-02 | `apply_patch` 多文件写入非事务，中途失败可能部分生效         | 首版先完整解析和验证后再写；记录回滚方案          |
| R-03 | `isWithinDirectory` 已实现但工具未使用，绝对路径可越出 cwd | 保持兼容但增加可配置 workspace-only 模式  |
| R-04 | API Key 明文存入 `config.yaml`                | 先兼容旧文件，再支持环境变量引用或系统 keychain  |
| R-05 | OpenAI 最终帧依赖 usage；部分兼容服务不返回 usage        | Java 同时用 `[DONE]` 判定结束        |
| R-06 | Agent 主循环缺少直接单测                           | Java 重写必须补 fake provider 集成测试 |
| R-07 | 审批 allow list 只按工具名，不区分命令和路径              | 首版兼容，后续扩展规则型权限                |
| R-08 | `AGENTS.md` seed 会被 `/clear` 一并清空         | 明确 `/clear` 是清全部还是恢复 seed     |
| R-09 | Skills 发现和 `listSkills` 存在重复实现            | Java 抽成一个 SkillDiscovery 服务   |
| R-10 | 配置/设置写入的原子性不完全一致                          | Java 两类配置统一临时文件 + atomic move |
| R-11 | 文档宣称 `.githooks/pre-commit`，实际钩子位于根目录     | Java 仓库重新建立可验证的 hook/CI 说明    |

## 11. 迁移实施阶段

### 阶段 0：冻结行为基线

- 固定 TypeScript commit。
- 导出 223 个测试的映射表。
- 保存工具 Schema、Message、provider request/response、SSE event golden fixture。
- 记录 CLI 配置和 settings 样本。
- 决定第 10 节 R-01 至 R-11 的处理结论。

退出条件：所有关键行为有源码位置、测试或 fixture 作为证据。

### 阶段 1：Foundation

- 建立 Maven 多模块、JDK 17 和质量门。
- 实现 Message、Model、Tool、Schema、结果类型。
- 实现 fake provider 和 test support。

退出条件：foundation API 和工具 Schema PoC 通过评审。

### 阶段 2：Agent

- 实现主循环、Publisher、并行工具、中间件、取消。
- 实现结果管线、Skills、Todos。
- 补齐原项目缺失的 Agent Loop 测试。

退出条件：无真实网络情况下完成多步 tool loop。

### 阶段 3：Coding Tools

- 按风险从 NIO 小工具到 Process、apply\_patch 迁移。
- 移植现有工具测试和错误码。
- 接入审批、提问、settings persistence。

退出条件：工具 parity matrix 全绿，取消不会残留进程。

### 阶段 4：Provider

- 先 OpenAI 兼容协议，再 Anthropic。
- 使用本地 HTTP/SSE fixture 测试。
- 最后用专用测试账号做非默认 smoke test。

退出条件：两家 invoke/stream/tool call/thinking/usage 全链路通过。

### 阶段 5：CLI/TUI

- Picocli 配置命令。
- 先实现简易 line mode，验证 Agent 全链路。
- 再实现 JLine 活动区、审批、问题表单和 Todo。
- 验证旧配置文件兼容。

退出条件：用户可从首次配置完成一轮真实 Coding Agent 任务。

### 阶段 6：分发与切换

- shaded JAR、启动脚本、jpackage。
- macOS/Linux CI 和安装冒烟。
- TypeScript/Java 双轨试用。
- 收集兼容差异，完成发布说明和回退方案。

退出条件：Java CLI 可替代主要日常使用，TypeScript 版本进入维护窗口。

## 12. 测试与验收策略

### 12.1 测试金字塔

- 单元测试：
  - Message、Schema、工具、结果管线、命令解析。
  - Provider 转换器和 StreamAccumulator。
- 组件测试：
  - Agent + fake provider + fake tools。
  - Approval/Question queue。
  - Config/Settings repository。
- 协议测试：
  - 本地 HTTP Server 回放 OpenAI/Anthropic SSE。
- PTY 冒烟：
  - 启动 CLI、输入文本、审批、取消、退出。
- 真实 API 冒烟：
  - 手动或定时执行，不进入默认 PR gate。

### 12.2 必补测试

原项目现有测试之外，Java 重写必须新增：

- Agent 非重入。
- maxSteps。
- 模型流为空。
- 多工具完成顺序。
- 单工具异常不影响其他工具。
- model/tool/process/queue 全链路取消。
- middleware 顺序和 patch 合并。
- OpenAI 无 usage 但有 `[DONE]`。
- 多文件 patch 中途失败。
- 符号链接和 workspace 边界。
- TUI state transition 和 terminal resize。

### 12.3 Parity Matrix

每个功能必须标记：

- `Exact`：输出和行为应一致。
- `Compatible`：语义一致，表现形式不同。
- `Changed`：已接受妥协，链接到 C-xx。
- `Deferred`：不在首版，必须有目标版本。

禁止用“基本支持”作为验收状态。

登记表（随各章完成滚动更新；状态取值：`Exact` / `Compatible` / `Changed(C-xx)` / `Deferred`）：

| 章节    | 功能项                             | 状态         | 验证方式                                                                                   | 备注                                                           |
| ----- | ------------------------------- | ---------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 第 1 章 | 四层架构与单向依赖（Maven 多模块 + ArchUnit） | Compatible | `mvn -q -DskipTests package`；`mvn verify`（foundation 1 + cli 3 条 ArchUnit 规则）；反向依赖红灯验证 | 已通过。原 TS 用目录约定+人工评审表达单向依赖，Java 用模块边界+ArchUnit 自动校验，语义一致、形式不同 |
| 第 2 章 | Message 类型系统（4 role + 5 content 的双层可辨识联合） | Compatible | `mvn -pl helixent-foundation test`（MessageTypeTest 18 + WireDtoLeakTest 1，全绿）；删 case 的无 default `switch` 编译失败红灯验证 | 已通过。TS 双层字符串联合 → Java sealed interface + record + enum 判别；wire/internal casing 分界保留；Anthropic thinking signature 以 `providerMetadata` 不透明承载，wire DTO 不入 foundation |
| 第 3 章 | Model / ModelProvider / ModelContext（invoke + stream 累计快照） | Compatible | `mvn -pl helixent-foundation test -Dtest=FakeProviderTest`（6 用例：最终帧=invoke、累计快照前缀性、空流异常、system prompt 首位、取消传播）；`mvn clean verify` 回归全绿 | 已通过。TS `AsyncGenerator<AssistantMessage>` → Java `ModelStream`(惰性 `Iterable`)，`last()` 消费最终帧；`AbortSignal` → `CancellationToken`/`CancellationTokenSource`；`options` → `ModelOptions`；system prompt 仍由 `Model` 拼装，provider 不感知 |

### 12.4 性能基线

建议指标：

- CLI 冷启动：shaded JAR 模式目标小于 1.5 秒。
- 首次 UI 可输入：小于 2 秒。
- Agent 本地调度额外延迟：单步小于 20ms，不含模型和工具。
- 1000 条 transcript 的 UI 状态更新不出现明显卡顿。
- 工具线程池有界，不随会话步骤持续增长。
- 取消后 2 秒内无残留 HTTP 请求和子进程。

## 13. 安全与运维要求

### 13.1 文件和命令

- 所有路径用 `Path.toAbsolutePath().normalize()`。
- 明确符号链接是否允许越出 workspace。
- `bash` 参数显示时截断，但执行前审批必须显示完整命令或提供展开能力。
- 进程输出设置最大字节数，避免内存耗尽。
- 工具线程池、队列和单步工具数设置上限。

### 13.2 密钥

- 日志禁止输出 API Key。
- CLI list 只显示末尾 4 位。
- 文件权限在 POSIX 下尽量设为仅当前用户可读写。
- 后续支持 `env:OPENAI_API_KEY` 形式，避免密钥落盘。

### 13.3 日志

- TUI 模式不直接向 stdout/stderr 打业务日志。
- 默认日志写入 `${HELIXENT_HOME}/logs/helixent.log`。
- 日志包含 session ID、provider、model、step、tool name、duration。
- 不记录完整 prompt、文件内容、tool result 和 API Key。
- debug 日志必须显式开启。

## 14. 待评审决策

在开始编码前，至少需要确认：

1. Maven groupId 和 Java 新仓库位置。
2. Java 17 是否可作为唯一最低版本。
3. 是否接受 C-01 至 C-07。
4. Java 版本是否继续叫 `helixent`，还是并行命名。
5. OpenAI 首版是否继续只使用 Chat Completions。
6. 是否默认启用 workspace-only 文件访问。
7. `/clear` 是否恢复 `AGENTS.md` seed。
8. 是否首版支持 API Key 环境变量引用。
9. 是否要求 Windows 首发。
10. shaded JAR、jpackage、GraalVM 三种分发的优先级。
11. provider options 的强类型字段范围。
12. 是否允许对 apply\_patch 增加预验证和回滚，改变部分写入行为。

## 15. 最终交付物清单

- Java 重写总体设计文档。
- 22 章详细设计文档或等价 ADR 集合。
- Maven 多模块工程。
- TypeScript -> Java 行为映射表。
- 技术栈和依赖 BOM。
- API/Message/Tool Schema 文档。
- Provider wire fixture 和协议测试。
- 223 个现有测试的迁移追踪表。
- 新增 Agent/取消/TUI 测试。
- CLI 配置兼容说明。
- 妥协与变更记录。
- 安全风险清单。
- shaded JAR、启动脚本和 jpackage。
- 安装、升级、回退和发布说明。

## 16. 推荐的下一步

先做两个独立 PoC，再冻结详细设计：

1. **Provider PoC：** JDK HttpClient + SSE + Jackson，验证 OpenAI tool call 增量 JSON、无 usage 的 `[DONE]`、Anthropic thinking signature。
2. **TUI PoC：** JLine Display + scrollback + 后台 Agent event queue，验证输入、流式活动区、审批切换和 Ctrl-C 取消。

这两个 PoC 覆盖本次重写风险最高的部分。PoC 通过后，Foundation、Agent 和普通文件工具都属于可预测的工程实现，不需要再改变总体架构。
