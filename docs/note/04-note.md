# 工具

## 定义

一个工具有四大要素

1. name
2. 描述
3. param
4. 具体实现

## zod

3和4要保持一致并不容易，比如下面，一个参数规格实现了两次，很容易两个出现不一致的情况，比如有一个忘记改了，为了解决下面这个问题，引入zod来解决

```
// ❌ 反面教材：同一份参数规格，写了两遍
const jsonSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
type ReadFileInput = { path: string };   // ← 和上面那份 schema 是两份「真相」
```

```
        defineTool({ name, description, parameters, invoke })
                                    │
                    parameters: 一份 Zod schema（z.object({...}))
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
   ① 编译期 TS 类型              ② 运行期 JSON Schema          ③ 人类可读描述
   z.infer<P>                   parameters.toJSONSchema()     每个字段的 .describe(...)
        │                           │                           │
        ▼                           ▼                           ▼
   invoke(input) 的 input        community 层翻译成             作为 JSON Schema 里的
   拥有完整静态类型               OpenAI / Anthropic 的         "description" 字段，
   （IDE 补全 + tsc 校验）        工具声明，喂给模型             模型据此理解每个参数
```

<br />

