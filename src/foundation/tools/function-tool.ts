import type { z } from "zod";

/**
 * A function tool that can be used to invoke a function.
 * @param P - The parameters of the tool.
 * @param R - The result of the tool.
 */
export interface FunctionTool<
  P extends z.ZodSchema<Record<string, unknown>> = z.ZodSchema<Record<string, unknown>>,
  R = unknown,
> {
  /** The name of the tool. */
  name: string;
  /** The description of the tool. */
  description: string;
  /** The parameters of the tool. */
  parameters: P;
  /**
   * Optional raw JSON Schema sent directly to providers.
   * Takes precedence over `parameters.toJSONSchema()` so MCP input schemas
   * (`$ref`, `anyOf`, `additionalProperties`, ...) pass through losslessly.
   */
  inputSchema?: Record<string, unknown>;
  /** The function to invoke when the tool is called. */
  // eslint-disable-next-line no-unused-vars
  invoke: (input: z.infer<P>, signal?: AbortSignal) => Promise<R>;
}

/**
 * Defines a function tool.
 * @param name - The name of the tool.
 * @param description - The description of the tool.
 * @param parameters - The parameters of the tool.
 * @param inputSchema - Optional raw JSON Schema that takes precedence over `parameters.toJSONSchema()`.
 * @param invoke - The function to invoke when the tool is called.
 * @returns The function tool.
 */
export function defineTool<P extends z.ZodSchema<Record<string, unknown>>, R>({
  name,
  description,
  parameters,
  inputSchema,
  invoke,
}: {
  name: string;
  description: string;
  parameters: P;
  inputSchema?: Record<string, unknown>;
  // eslint-disable-next-line no-unused-vars
  invoke: (input: z.infer<P>, signal?: AbortSignal) => Promise<R>;
}): FunctionTool<P, R> {
  return { name, description, parameters, ...(inputSchema ? { inputSchema } : {}), invoke } as FunctionTool<P, R>;
}
