import { z } from "zod";
import { BridgeError, encodeReasoningSignature, readSse, toOpenAIRequest, type EffortLevel, type MessageRequest, type OpenAIEvent, type OpenAIRequest, type FunctionTool } from "./bridge.js";
import type { ApiModel, ApiProvider } from "../providers/config.js";
import { decodeProviderReasoning, encodeProviderReasoning } from "../providers/reasoning.js";

export type PublicResponsesRequest = Omit<OpenAIRequest, "reasoning" | "include" | "tools"> & {
  max_output_tokens: number;
  tools?: Array<FunctionTool & { strict: false }>;
  include?: ["reasoning.encrypted_content"];
  reasoning?: { effort?: Exclude<EffortLevel, "max">; summary?: "auto" };
};

/** Public Responses uses the same content protocol as Codex, not its auth or implicit reasoning policy. */
export function toResponsesRequest(request: MessageRequest, provider: ApiProvider, model: ApiModel, defaultEffort: EffortLevel | undefined): PublicResponsesRequest {
  const scope = { provider, protocol: "responses" as const, model: model.slug };
  // The legacy Codex signature format delimits model names with ':'. A local key avoids
  // ambiguity for API model slugs containing ':' while the public envelope binds the real slug.
  const conversionModel = Buffer.from(model.slug, "utf8").toString("base64url");
  const messages = request.messages.map((message) => ({
    ...message,
    content: typeof message.content === "string" ? message.content : message.content.map((block) => {
      if (block.type !== "thinking" && block.type !== "redacted_thinking") return block;
      const value = block.type === "thinking" ? block.signature : block.data;
      const encrypted = decodeProviderReasoning(scope, typeof value === "string" ? value : undefined);
      const signature = encrypted === undefined ? "" : encodeReasoningSignature(conversionModel, encrypted);
      return block.type === "thinking" ? { ...block, signature } : { ...block, data: signature };
    }),
  }));
  const converted = toOpenAIRequest({ ...request, messages }, conversionModel);
  const { include, reasoning, tools, ...body } = converted;
  for (const tool of tools ?? []) {
    if (!z.record(z.string(), z.json()).safeParse(tool.parameters).success) {
      throw new BridgeError(400, "invalid_tool_schema", `Tool "${tool.name}" requires a JSON object schema.`);
    }
  }
  const requestedEffort = request.output_config?.effort ?? request.reasoning_effort ?? defaultEffort;
  const effort = requestedEffort === "max" ? "xhigh" : requestedEffort;
  return {
    ...body,
    model: model.slug,
    ...(model.reasoning === "none" ? { input: body.input.filter((item) => !("type" in item && item.type === "reasoning")) } : {}),
    // Responses strict mode otherwise rewrites optional tool arguments and rejects common agent schemas.
    ...(tools ? { tools: tools.map((tool) => ({ ...tool, strict: false as const })) } : {}),
    max_output_tokens: request.max_tokens,
    ...(model.reasoning === "openai" ? {
      include,
      ...(effort || request.thinking?.type !== "disabled" ? {
        reasoning: { ...(effort ? { effort } : {}), ...(request.thinking?.type !== "disabled" ? { summary: "auto" } : {}) },
      } : {}),
    } : {}),
  };
}

const Usage = z.object({ input_tokens: z.number().nonnegative().optional(), output_tokens: z.number().nonnegative().optional(), input_tokens_details: z.object({ cached_tokens: z.number().nonnegative().optional() }).optional() });
const ResponseEvent = z.object({
  type: z.string(),
  response: z.object({
    id: z.string().optional(), usage: Usage.optional(),
    error: z.object({ code: z.string().optional(), message: z.string().optional() }).nullable().optional(),
    incomplete_details: z.object({ reason: z.string().optional() }).nullable().optional(),
  }).optional(),
  output_index: z.number().int().nonnegative().optional(),
  summary_index: z.number().int().nonnegative().optional(),
  item: z.object({
    type: z.string().optional(), call_id: z.string().optional(), name: z.string().optional(), arguments: z.string().optional(),
    summary: z.array(z.object({ type: z.string().optional(), text: z.string().optional() })).optional(),
    encrypted_content: z.string().nullable().optional(),
  }).optional(),
  delta: z.string().optional(), arguments: z.string().optional(), text: z.string().optional(), code: z.string().optional(), message: z.string().optional(),
});

export async function readResponsesSse(body: ReadableStream<Uint8Array>, accept: (event: OpenAIEvent) => void, provider: ApiProvider, model: string): Promise<void> {
  await readSse(body, (input) => {
    const event = ResponseEvent.parse(input);
    const encrypted = event.item?.encrypted_content;
    const normalized = {
      ...event,
      ...(event.response ? { response: {
        ...event.response,
        ...(event.response.error === null ? { error: undefined } : {}),
        ...(event.response.incomplete_details === null ? { incomplete_details: undefined } : {}),
      } } : {}),
      ...(event.item ? { item: {
        ...event.item,
        encrypted_content: undefined,
        ...(event.item.type === "reasoning" ? { signature: encrypted ? encodeProviderReasoning({ provider, protocol: "responses", model }, encrypted) : "" } : {}),
      } } : {}),
    };
    // Zod optional fields explicitly include undefined; consumers treat absent and undefined identically.
    accept(normalized as OpenAIEvent);
  });
}
