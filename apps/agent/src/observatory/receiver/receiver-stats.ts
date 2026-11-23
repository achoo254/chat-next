// The OTLP receiver's counters since the agent started, for
// `tunelo observatory status`. Counts only, never content.

export type ReceiverStats = {
  /** Requests answered 200. */
  requests: number;
  /** Records kept and passed on. */
  received: number;
  /** Requests refused for their token (401). */
  unauthorized: number;
  /** Requests refused before their body was read for any other reason (Origin, Host, preflight, path, method, type). */
  refused: number;
  /** Records of another service than Claude Code. */
  otherService: number;
  /** Records too large, and requests whose body passed the limit. */
  tooLarge: number;
  /** Requests dropped because the processing queue was full. */
  queueFull: number;
  /** Records of events not kept. */
  ignored: number;
  /** Bodies or records that could not be read. */
  malformed: number;
  /** Requests that came with the previous token (sessions started before the last rotation): when 0 for long enough, it can be revoked. */
  previousToken: number;
  /** When the previous token was last used (Unix ms). */
  previousTokenLastAt: number | undefined;
};

export function emptyReceiverStats(): ReceiverStats {
  return { requests: 0, received: 0, unauthorized: 0, refused: 0, otherService: 0, tooLarge: 0, queueFull: 0, ignored: 0, malformed: 0, previousToken: 0, previousTokenLastAt: undefined };
}
