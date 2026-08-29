import type { ChatCompletionContentPart, ChatCompletionTool } from "openai/resources";

import type { AssistantMessage, Message, TokenUsage, Tool } from "@/foundation";

import type {
  OpenAIAssistantMessageParam,
  OpenAIChatCompletionMessage,
  OpenAIChatCompletionMessageParam,
} from "./types";

/**
 * Converts the messages to OpenAI ChatCompletionMessageParam messages.
 * @param messages - The messages to convert.
 * @returns The OpenAI ChatCompletionMessageParam messages.
 */
export function convertToOpenAIMessages(messages: Message[]): OpenAIChatCompletionMessageParam[] {
  const openaiMessages: OpenAIChatCompletionMessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "user") {
      openaiMessages.push(message);
    } else if (message.role === "assistant") {
      const assistantMessage: OpenAIAssistantMessageParam = {
        role: "assistant",
        content: [],
      };
      assistantMessage.reasoning_content = "";
      for (const content of message.content) {
        if (content.type === "thinking") {
          assistantMessage.reasoning_content = content.thinking;
        } else if (content.type === "tool_use") {
          if (!assistantMessage.tool_calls) {
            assistantMessage.tool_calls = [];
          }
          assistantMessage.tool_calls.push({
            type: "function",
            id: content.id,
            function: {
              name: content.name,
              arguments: JSON.stringify(content.input),
            },
          });
        } else {
          (assistantMessage.content as ChatCompletionContentPart[]).push(content);
        }
      }
      if (assistantMessage.content?.length === 0) {
        assistantMessage.content = "";
      }
      openaiMessages.push(assistantMessage);
    } else if (message.role === "tool") {
      for (const content of message.content) {
        if (content.type === "tool_result") {
          openaiMessages.push({
            role: "tool",
            tool_call_id: content.tool_use_id,
            content: content.content,
          });
        }
      }
    }
  }
  return openaiMessages;
}

/**
 * Parses the assistant message from the OpenAI ChatCompletionMessage.
 * @param message - The message to parse.
 * @returns The parsed assistant message.
 */
export function parseAssistantMessage(message: OpenAIChatCompletionMessage, usage?: TokenUsage): AssistantMessage {
  const result: AssistantMessage = {
    role: "assistant",
    content: [],
    usage,
  };
  if (typeof message.reasoning_content === "string") {
    result.content.push({ type: "thinking", thinking: message.reasoning_content });
  }
  if (typeof message.content === "string") {
    result.content.push({ type: "text", text: message.content });
  }
  if (message.tool_calls) {
    for (const tool_call of message.tool_calls) {
      if (tool_call.type === "function") {
        result.content.push({
          type: "tool_use",
          id: tool_call.id,
          name: tool_call.function.name,
          input: JSON.parse(tool_call.function.arguments),
        });
      }
    }
  }
  return result;
}

/**
 * Converts the tools to OpenAI ChatCompletionTool messages.
 * Prefers the raw `inputSchema` when present (MCP passthrough), falling back to
 * `parameters.toJSONSchema()` otherwise.
 * @param tools - The tools to convert.
 * @returns The OpenAI ChatCompletionTool messages.
 */
export function convertToOpenAITools(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: toolInputSchema(tool) },
  }));
}

function toolInputSchema(tool: Tool): Record<string, unknown> {
  const inputSchema = tool.inputSchema;
  if (inputSchema && typeof inputSchema === "object" && inputSchema.type === "object") {
    return inputSchema;
  }
  return tool.parameters.toJSONSchema() as unknown as Record<string, unknown>;
}
