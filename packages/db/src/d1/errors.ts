// Constraint-violation detection for D1.
//
// SQLite reports a violated uniqueness constraint as an error message, not a
// code: D1 surfaces `D1_ERROR: UNIQUE constraint failed: <table>.<column>`
// (and `… : PRIMARY KEY constraint failed` for the implicit index). There is
// no SQLSTATE to compare against, so the message is the signal.
//
// Repositories use this to turn a losing insert into a `conflict` result
// instead of a 500 — the shape callers already branch on.

function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message ?? "");
  }
  return "";
}

/** True when the error is SQLite refusing a duplicate key. */
export function isUniqueViolation(err: unknown): boolean {
  return /(UNIQUE|PRIMARY KEY) constraint failed/i.test(messageOf(err));
}

/** True when the error is SQLite refusing a write that breaks a foreign key. */
export function isForeignKeyViolation(err: unknown): boolean {
  return /FOREIGN KEY constraint failed/i.test(messageOf(err));
}

/** True when the error is SQLite refusing a write that breaks a CHECK or
 *  NOT NULL constraint — a caller-supplied value the schema rejects. */
export function isCheckViolation(err: unknown): boolean {
  return /(CHECK|NOT NULL) constraint failed/i.test(messageOf(err));
}
