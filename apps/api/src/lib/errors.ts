export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
  }
}

const NETWORK_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "EHOSTUNREACH", "EPIPE"]);
/** Postgres: 57P01-57P03 admin shutdown / starting up, 08xxx connection exceptions. */
const PG_DOWN = /^(57P0[123]|08\w{3})$/;
const POOL_MESSAGES = /Connection terminated|timeout exceeded when trying to connect|server closed the connection|the database system is (starting up|shutting down)/i;

/**
 * True when the error means a backing service (Postgres, S3, SQS) cannot be reached, as opposed to a bug.
 * Callers answer 503 so the UI can say "try again" instead of a bare "internal error".
 */
export function isDependencyDown(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (typeof code === "string" && (NETWORK_CODES.has(code) || PG_DOWN.test(code))) return true;
    if (typeof message === "string" && POOL_MESSAGES.test(message)) return true;
  }
  return false;
}

export const notFound =(what = "resource") => new ApiError(404, "not_found", `${what} not found`);
export const forbidden = (msg = "action not allowed") => new ApiError(403, "forbidden", msg);
export const badRequest = (msg: string, details?: unknown) => new ApiError(400, "bad_request", msg, details);
export const conflict = (msg: string) => new ApiError(409, "conflict", msg);
export const quotaExceeded = (msg: string) => new ApiError(429, "quota_exceeded", msg);
