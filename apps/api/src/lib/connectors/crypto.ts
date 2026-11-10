/**
 * Cifrado de tokens de conectores: AES-256-GCM con AAD = "<org>:<connector>" (un token copiado a otra fila no descifra).
 * Formato: v1.<iv>.<tag>.<data> en base64url. En producción la clave viene de Secrets Manager (CONNECTOR_ENCRYPTION_KEY);
 * en desarrollo se deriva de INTERNAL_SERVICE_SECRET con HKDF.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { Config } from "../../config.js";
import type { TokenSet } from "./types.js";

export class TokenCipher {
  private readonly key: Buffer;

  constructor(cfg: Pick<Config, "CONNECTOR_ENCRYPTION_KEY" | "INTERNAL_SERVICE_SECRET">) {
    this.key = cfg.CONNECTOR_ENCRYPTION_KEY
      ? Buffer.from(cfg.CONNECTOR_ENCRYPTION_KEY, "base64")
      : Buffer.from(hkdfSync("sha256", cfg.INTERNAL_SERVICE_SECRET, "ragsis-connectors", "connector-token-key-v1", 32));
  }

  seal(tokens: TokenSet, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
  }

  open(sealed: string, aad: string): TokenSet {
    const [v, iv, tag, data] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || !data) throw new Error("unsupported token envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as TokenSet;
  }
}
