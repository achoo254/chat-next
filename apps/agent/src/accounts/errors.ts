// Why an account request was refused; devices word it in the user's language
// (link/connection.ts maps each kind to an ErrorReason).
export type AccountErrorKind = "damaged" | "not-found" | "default-permanent" | "in-use" | "sign-out-failed" | "cli-missing" | "switch-blocked";

export class AccountError extends Error {
  constructor(
    message: string,
    readonly kind: AccountErrorKind,
    /** The variable part the kind names (an account id, what holds the AI), when it has one. */
    readonly subject = "",
  ) {
    super(message);
  }
}
