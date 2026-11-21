// The errors of the Observatory store. Observatory never stops the agent: a
// caller that gets one of these logs a line and turns Observatory off (or
// drops the batch), and the agent carries on.

/** Any failure of the Observatory store that callers may report and carry on from. */
export class ObservatoryStoreError extends Error {
  override readonly name: string = "ObservatoryStoreError";
}

/** The database was written by a newer agent: it is left untouched. */
export class ObservatorySchemaTooNew extends ObservatoryStoreError {
  override readonly name = "ObservatorySchemaTooNew";

  constructor(
    readonly found: number,
    readonly supported: number,
    readonly path: string,
  ) {
    super(`the Observatory database ${path} has schema version ${found}; this agent knows up to ${supported} and leaves it untouched`);
  }
}

/** A write whose own data is wrong (a missing required value, a value of the wrong type, an unknown kind): only that write is at fault. */
export class ObservatoryInvalidWrite extends ObservatoryStoreError {
  override readonly name = "ObservatoryInvalidWrite";
}

/** Another connection held the database's lock past the busy timeout; nothing of the call was written. */
export class ObservatoryStoreBusy extends ObservatoryStoreError {
  override readonly name = "ObservatoryStoreBusy";

  constructor(cause: unknown) {
    super("the Observatory database is locked by another connection", { cause });
  }
}

/**
 * wipe() could not delete the database (on Windows: another process has it
 * open). The store was opened again and works on; the data is still there.
 */
export class ObservatoryWipeFailed extends ObservatoryStoreError {
  override readonly name = "ObservatoryWipeFailed";

  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`the Observatory database ${path} could not be deleted (${cause instanceof Error ? cause.message : String(cause)}); is another program using it?`, { cause });
  }
}

/** The store was used after close() or wipe(). */
export class ObservatoryStoreClosed extends ObservatoryStoreError {
  override readonly name = "ObservatoryStoreClosed";

  constructor() {
    super("the Observatory store is closed");
  }
}
