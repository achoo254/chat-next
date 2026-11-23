// Reading an OTLP request's body with a size limit and a deadline. A body
// past the limit is read on and thrown away (so the client gets the 413
// instead of a reset mid-send), for the deadline at most; a body that does
// not arrive in time is given up (the caller answers 408 and cuts the
// connection).
import type { IncomingMessage } from "node:http";

export type BodyOutcome = { kind: "body"; body: Buffer } | { kind: "too-large" } | { kind: "timeout" } | { kind: "aborted" };

/** Reads `req`'s body: at most `maxBytes`, within `timeoutMs`. */
export function readOtlpBody(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<BodyOutcome> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (outcome: BodyOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const discard = (): void => {
      req.removeAllListeners("data");
      req.resume();
      const cut = setTimeout(() => req.destroy(), timeoutMs);
      cut.unref?.();
      req.once("close", () => clearTimeout(cut));
      finish({ kind: "too-large" });
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    timer.unref?.();
    if (Number(req.headers["content-length"] ?? 0) > maxBytes) return discard();
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) return discard();
      chunks.push(chunk);
    });
    req.on("end", () => finish({ kind: "body", body: Buffer.concat(chunks, size) }));
    req.on("error", () => finish({ kind: "aborted" }));
  });
}
