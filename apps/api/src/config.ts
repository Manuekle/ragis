import { z } from "zod";

const optionalText = z.preprocess((value) => value === "" ? undefined : value, z.string().optional());

const Env = z.object({
  RAGSIS_ENV: z.string().default("local"),
  PORT: z.coerce.number().default(4000),
  // Vacío => node-postgres usa PGHOST/PGUSER/PGPASSWORD/PGDATABASE (secretos inyectados por ECS).
  DATABASE_URL: z.string().optional(),
  RAG_ENGINE_URL: z.string().url().default("http://localhost:8080"),
  INTERNAL_SERVICE_SECRET: z.string().min(32, "INTERNAL_SERVICE_SECRET debe tener >= 32 caracteres"),
  AUTH_MODE: z.enum(["dev", "oidc"]).default("dev"),
  JWT_DEV_SECRET: z.string().optional(),
  OIDC_ISSUER: z.string().optional(),
  OIDC_AUDIENCE: z.string().optional(),
  AWS_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: z.string().optional(),
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().default("ragsis-documents"),
  SQS_ENDPOINT: z.string().optional(),
  SQS_INGEST_QUEUE_URL: z.string().default(""),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().default(600),
  DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().default(120),
  /** Base pública de la web para enlaces compartidos (/s/<token>). */
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  ESIGN_PROVIDER: z.enum(["native", "local", "disabled"]).default("native"),
  ESIGN_WEBHOOK_SECRET: z.string().min(32).optional(),
  SIGNATURE_SEAL_SECRET: z.preprocess((value) => value === "" ? undefined : value, z.string().min(32).optional()),
  SIGNATURE_EMAIL_FROM: z.preprocess((value) => value === "" ? undefined : value, z.email().optional()),
  // CON-01 (ADR-025). Apps OAuth de cada proveedor; sin client_id el proveedor aparece como "no configurado".
  GOOGLE_CLIENT_ID: optionalText,
  GOOGLE_CLIENT_SECRET: optionalText,
  SLACK_CLIENT_ID: optionalText,
  SLACK_CLIENT_SECRET: optionalText,
  CLICKUP_CLIENT_ID: optionalText,
  CLICKUP_CLIENT_SECRET: optionalText,
  /** Clave AES-256 (base64, 32 bytes) de los tokens de conectores. Fuera de producción se deriva de INTERNAL_SERVICE_SECRET. */
  CONNECTOR_ENCRYPTION_KEY: optionalText,
  /** Proveedores simulados en memoria (sin cuentas reales). Solo desarrollo/demo; prohibido en producción. */
  CONNECTORS_DEMO: z.preprocess((value) => value === "1" || value === "true", z.boolean()).default(false),
  /** false en réplicas que no deben sincronizar (p. ej. si un worker dedicado lo hace). */
  CONNECTOR_SYNC_ENABLED: z.preprocess((value) => value !== "0" && value !== "false", z.boolean()).default(true),
  CONNECTOR_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = Env.parse(env);
  if (cfg.AUTH_MODE === "dev") {
    if (!cfg.JWT_DEV_SECRET || cfg.JWT_DEV_SECRET.length < 32) {
      throw new Error("AUTH_MODE=dev requiere JWT_DEV_SECRET (>= 32 caracteres)");
    }
    if (cfg.RAGSIS_ENV === "production") {
      throw new Error("AUTH_MODE=dev is forbidden in production");
    }
  } else if (!cfg.OIDC_ISSUER || !cfg.OIDC_AUDIENCE) {
    throw new Error("AUTH_MODE=oidc requiere OIDC_ISSUER y OIDC_AUDIENCE");
  }
  if (cfg.ESIGN_PROVIDER === "local" && cfg.RAGSIS_ENV === "production") {
    throw new Error("ESIGN_PROVIDER=local is a development provider and is forbidden in production");
  }
  if (cfg.SIGNATURE_EMAIL_FROM && cfg.RAGSIS_ENV === "production" && new URL(cfg.PUBLIC_BASE_URL).protocol !== "https:") {
    throw new Error("SIGNATURE_EMAIL_FROM in production requires an HTTPS PUBLIC_BASE_URL");
  }
  if (cfg.RAGSIS_ENV === "production") {
    if (cfg.CONNECTORS_DEMO) throw new Error("CONNECTORS_DEMO is a development mode and is forbidden in production");
    const anyConnector = cfg.GOOGLE_CLIENT_ID || cfg.SLACK_CLIENT_ID || cfg.CLICKUP_CLIENT_ID;
    if (anyConnector && !cfg.CONNECTOR_ENCRYPTION_KEY) throw new Error("connectors in production require CONNECTOR_ENCRYPTION_KEY");
  }
  if (cfg.CONNECTOR_ENCRYPTION_KEY && Buffer.from(cfg.CONNECTOR_ENCRYPTION_KEY, "base64").length !== 32) {
    throw new Error("CONNECTOR_ENCRYPTION_KEY must be 32 bytes encoded in base64");
  }
  return cfg;
}
