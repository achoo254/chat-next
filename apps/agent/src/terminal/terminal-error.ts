// A refused Term* request as a device gets it (link/connection.ts errorBody).
import type { ErrorCode, ErrorReason } from "@achoo254/chat-proto/remote/remote";

export class TerminalError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly reason: ErrorReason,
    message: string,
    readonly subject = "",
  ) {
    super(message);
    this.name = "TerminalError";
  }
}
