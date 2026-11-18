import { randomUUID } from "node:crypto";

const MAX_REQUESTS = 12;
const MAX_STAGE_LENGTH = 512 * 1024;
export type PayloadStage = "claudeRequest" | "chatgptRequest" | "chatgptResponse" | "claudeResponse";
export type CapturePayload = (stage: PayloadStage, text: string) => void;

type PayloadTrace = {
  readonly id: string;
  readonly started: string;
  revision: number;
  readonly stages: Record<PayloadStage, string>;
};

/** Each gateway owns its capture history. Stopping capture also invalidates in-flight writers. */
export class PayloadTraces {
  private enabled = false;
  private readonly history = new Map<string, PayloadTrace>();

  start(): void { this.enabled = true; }

  stop(): void {
    this.enabled = false;
    this.clear();
  }

  clear(): void { this.history.clear(); }

  index() {
    return {
      enabled: this.enabled,
      requests: Array.from(this.history.values(), ({ id, started, revision }) => ({ id, started, revision })).reverse(),
    };
  }

  get(id: string): PayloadTrace | undefined { return this.history.get(id); }

  begin(): CapturePayload | undefined {
    if (!this.enabled) return undefined;
    const oldest = this.history.keys().next().value;
    if (this.history.size >= MAX_REQUESTS && oldest !== undefined) this.history.delete(oldest);
    const id = randomUUID();
    this.history.set(id, { id, started: new Date().toISOString(), revision: 0,
      stages: { claudeRequest: "", chatgptRequest: "", chatgptResponse: "", claudeResponse: "" } });
    return (stage, text) => {
      const trace = this.history.get(id);
      if (!trace || !text) return;
      const remaining = MAX_STAGE_LENGTH - trace.stages[stage].length;
      if (remaining < 0) return;
      trace.stages[stage] += text.length > remaining
        ? text.slice(0, remaining) + "\n[Capture truncated]"
        : text;
      trace.revision++;
    };
  }
}
