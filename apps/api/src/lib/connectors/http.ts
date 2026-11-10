/** Cliente HTTP de proveedores: timeouts, reintentos con backoff/Retry-After y errores clasificados (sin filtrar tokens). */
import type { Fetch, ProviderHttp } from "./types.js";

export type ProviderErrorCode = "auth_revoked" | "rate_limited" | "not_found" | "forbidden" | "provider_error";

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
    /** Código de error del proveedor (Slack `error`, Google `error`), útil para el adaptador. */
    public readonly providerCode?: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfter(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return s * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function classify(status: number, code?: string): ProviderErrorCode {
  if (status === 401 || code === "invalid_grant" || code === "invalid_auth" || code === "token_revoked" || code === "account_inactive") return "auth_revoked";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status === 403) return "forbidden";
  return "provider_error";
}

export interface HttpOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  /** Esperas de Retry-After más largas que esto se devuelven como rate_limited para reprogramar la pasada. */
  maxInlineWaitMs?: number;
  retries?: number;
}

export function providerHttp(opts: HttpOptions = {}): ProviderHttp {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxWait = opts.maxInlineWaitMs ?? 15_000;
  const retries = opts.retries ?? 3;

  async function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string | URLSearchParams; token?: string; tokenPrefix?: string }) {
    const headers: Record<string, string> = { accept: "application/json", ...(init.headers ?? {}) };
    if (init.token) headers.authorization = `${init.tokenPrefix ?? "Bearer "}${init.token}`;
    if (init.body instanceof URLSearchParams) headers["content-type"] = "application/x-www-form-urlencoded";
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, { method: init.method ?? "GET", headers, body: init.body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        if (attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new ProviderError("provider_error", `network error: ${(err as Error).name}`);
      }
      if (res.ok) return res;
      const wait = retryAfter(res);
      const transient = res.status === 429 || res.status >= 500;
      if (transient && attempt < retries) {
        const ms = wait ?? 1000 * 2 ** attempt;
        if (ms <= maxWait) {
          await sleep(ms);
          continue;
        }
      }
      let code: string | undefined;
      try {
        const body = (await res.json()) as { error?: string | { status?: string; message?: string }; err?: string; ECODE?: string };
        code = typeof body.error === "string" ? body.error : body.error?.status ?? body.ECODE;
      } catch {}
      const host = new URL(url).host;
      throw new ProviderError(classify(res.status, code), `${host} responded ${res.status}${code ? ` (${code})` : ""}`, res.status, wait, code);
    }
  }

  return {
    async json(url, init = {}) {
      const res = await request(url, init);
      return res.status === 204 ? ({} as never) : res.json();
    },
    async bytes(url, init = {}) {
      const res = await request(url, init);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
