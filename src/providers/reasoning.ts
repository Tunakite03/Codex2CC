import { z } from "zod";
import { ApiProviderSchema, type ApiProvider } from "./config.js";

const PREFIX = "codex2cc.api.reasoning.v1:";
const Envelope = z.object({
  provider: ApiProviderSchema,
  protocol: z.enum(["responses", "anthropic-messages"]),
  model: z.string(),
  value: z.string().min(1),
});
export type ReasoningScope = { readonly provider: ApiProvider; readonly protocol: "responses" | "anthropic-messages"; readonly model: string };

export function encodeProviderReasoning(scope: ReasoningScope, value: string): string {
  return PREFIX + Buffer.from(JSON.stringify({ ...scope, value }), "utf8").toString("base64url");
}

/** Never replay Codex, another provider's, or another model's opaque reasoning into this backend. */
export function decodeProviderReasoning(scope: ReasoningScope, signature: string | undefined): string | undefined {
  if (!signature?.startsWith(PREFIX)) return undefined;
  try {
    const parsed = Envelope.safeParse(JSON.parse(Buffer.from(signature.slice(PREFIX.length), "base64url").toString("utf8")));
    if (!parsed.success) return undefined;
    const data = parsed.data;
    return data.provider === scope.provider && data.protocol === scope.protocol && data.model === scope.model ? data.value : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
