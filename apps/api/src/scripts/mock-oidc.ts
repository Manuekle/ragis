/**
 * IdP OIDC mínimo para desarrollo y pruebas (NO usar en producción).
 * Implementa discovery, JWKS, authorize (aprobación automática), token (PKCE S256) y logout.
 *
 *   MOCK_OIDC_PORT=9000 MOCK_OIDC_EMAIL=ana@empresa.test npx tsx src/scripts/mock-oidc.ts
 *
 * El email del usuario puede elegirse por request con `login_hint`.
 */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

export interface MockOidc {
  issuer: string;
  close(): Promise<void>;
  sign(claims: Record<string, unknown>, opts?: { audience?: string; issuer?: string }): Promise<string>;
}

export async function startMockOidc(opts: { port?: number; clientId: string; defaultEmail?: string }): Promise<MockOidc> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "mock-1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; nonce?: string; email: string }>();
  let issuer = "";

  const sign = (claims: Record<string, unknown>, o: { audience?: string; issuer?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "mock-1" })
      .setIssuer(o.issuer ?? issuer)
      .setAudience(o.audience ?? opts.clientId)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url.pathname === "/.well-known/jwks.json") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      if (p.get("client_id") !== opts.clientId || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) {
        return json(400, { error: "invalid_request" });
      }
      const code = randomBytes(16).toString("hex");
      codes.set(code, {
        clientId: opts.clientId,
        redirectUri: p.get("redirect_uri")!,
        challenge: p.get("code_challenge")!,
        nonce: p.get("nonce") ?? undefined,
        email: p.get("login_hint") ?? opts.defaultEmail ?? "dev@ragsis.test",
      });
      const to = new URL(p.get("redirect_uri")!);
      to.searchParams.set("code", code);
      if (p.get("state")) to.searchParams.set("state", p.get("state")!);
      res.writeHead(302, { location: to.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const f = new URLSearchParams(raw);
      const entry = codes.get(f.get("code") ?? "");
      codes.delete(f.get("code") ?? "");
      const verifier = f.get("code_verifier") ?? "";
      if (!entry || entry.redirectUri !== f.get("redirect_uri") || entry.clientId !== f.get("client_id")
        || createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) {
        return json(400, { error: "invalid_grant" });
      }
      const id_token = await sign({
        sub: `mock|${entry.email}`, email: entry.email, email_verified: true, token_use: "id",
        ...(entry.nonce ? { nonce: entry.nonce } : {}),
      });
      return json(200, { id_token, token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname === "/logout") {
      res.writeHead(302, { location: url.searchParams.get("post_logout_redirect_uri") ?? "/" });
      return res.end();
    }
    json(404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  issuer = `http://localhost:${port}`;
  return { issuer, sign, close: () => new Promise((r) => server.close(() => r())) };
}

if (process.argv[1]?.endsWith("mock-oidc.ts") || process.argv[1]?.endsWith("mock-oidc.js")) {
  const idp = await startMockOidc({
    port: Number(process.env.MOCK_OIDC_PORT ?? 9000),
    clientId: process.env.MOCK_OIDC_CLIENT_ID ?? "ragsis-web",
    defaultEmail: process.env.MOCK_OIDC_EMAIL,
  });
  console.log(`mock OIDC issuer: ${idp.issuer} (client_id=${process.env.MOCK_OIDC_CLIENT_ID ?? "ragsis-web"})`);
}
