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

export const notFound = (what = "resource") => new ApiError(404, "not_found", `${what} not found`);
export const forbidden = (msg = "action not allowed") => new ApiError(403, "forbidden", msg);
export const badRequest = (msg: string, details?: unknown) => new ApiError(400, "bad_request", msg, details);
export const conflict = (msg: string) => new ApiError(409, "conflict", msg);
export const quotaExceeded = (msg: string) => new ApiError(429, "quota_exceeded", msg);
