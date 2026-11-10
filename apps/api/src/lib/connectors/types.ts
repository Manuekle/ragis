/** Contratos comunes de conectores (CON-01, ADR-025). */

export const PROVIDERS = ["gmail", "slack", "clickup"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export type ConnectorScope = "personal" | "organization";

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  /** epoch ms; ausente = no caduca (Slack sin rotación, ClickUp). */
  expires_at?: number;
  scope?: string;
}

export interface ExternalAccount {
  id: string;
  label: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export type Fetch = typeof fetch;

/** Un elemento del origen convertido en documento. `sourceId` es único dentro del conector. */
export interface SyncItem {
  sourceId: string;
  /** Canal, espacio o hilo al que pertenece: permite retirar elementos por selección o por hilo. */
  container: string;
  title: string;
  filename: string;
  contentType: string;
  body: Buffer;
  /** Marca de versión del origen (fecha de edición, historyId…), para no volver a descargar lo que no cambió. */
  sourceUpdatedAt?: string;
  classification?: "internal" | "confidential";
  effectiveFrom?: string;
}

export type UpsertResult = "created" | "updated" | "unchanged" | "skipped";

export interface KnownItem {
  contentSha256: string | null;
  sourceUpdatedAt: string | null;
}

/** Operaciones que el motor ofrece a cada proveedor durante una sincronización. */
export interface SyncSink {
  upsert(item: SyncItem): Promise<UpsertResult>;
  /** Marca como visto sin descargar contenido (reconciliación). */
  touch(sourceIds: string[]): Promise<void>;
  touchContainers(containers: string[]): Promise<void>;
  known(sourceId: string): Promise<KnownItem | null>;
  remove(sourceIds: string[]): Promise<number>;
  /** Retira del contenedor todo lo que no esté en `keep`. */
  retain(container: string, keep: string[]): Promise<number>;
  /** Retira los elementos cuyo contenedor (con ese prefijo) ya no está seleccionado. */
  keepContainers(prefix: string, containers: string[]): Promise<number>;
  /** Retira los elementos con ese prefijo de sourceId no vistos desde `since`. */
  sweep(sourcePrefix: string, since: Date): Promise<number>;
  checkpoint(cursor: Record<string, unknown>): Promise<void>;
  /** true cuando se agotó el presupuesto de esta pasada (tiempo o elementos): guardar cursor y salir. */
  shouldYield(): boolean;
}

export interface SyncRun<S> {
  tokens: TokenSet;
  settings: S;
  cursor: Record<string, unknown>;
  sink: SyncSink;
  http: ProviderHttp;
  now: Date;
  /** Tamaño máximo de archivo del plan (adjuntos mayores se omiten). */
  maxBytes: number;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface SyncOutcome {
  /** true = queda trabajo pendiente: programar otra pasada enseguida. */
  more: boolean;
}

export interface OptionGroup {
  key: string;
  label: string;
  multiple: boolean;
  options: { id: string; label: string; detail?: string; private?: boolean }[];
}

export interface ProviderHttp {
  json<T = any>(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | URLSearchParams; token?: string; tokenPrefix?: string }): Promise<T>;
  bytes(url: string, init?: { token?: string; tokenPrefix?: string }): Promise<Buffer>;
}

export interface ProviderAdapter<S = Record<string, unknown>> {
  id: ProviderId;
  name: string;
  scope: ConnectorScope;
  /** Estado inicial tras conectar: needs_setup obliga a elegir canales/espacios antes de sincronizar. */
  initialStatus: "active" | "needs_setup";
  authorizeUrl(a: { client: OAuthClient; redirectUri: string; state: string; codeChallenge: string }): string;
  exchange(http: ProviderHttp, a: { client: OAuthClient; code: string; redirectUri: string; codeVerifier: string }): Promise<{ tokens: TokenSet; account: ExternalAccount }>;
  refresh?(http: ProviderHttp, client: OAuthClient, tokens: TokenSet): Promise<TokenSet>;
  revoke?(http: ProviderHttp, client: OAuthClient, tokens: TokenSet): Promise<void>;
  parseSettings(raw: unknown): S;
  defaultSettings(): S;
  /** Cambios de selección que invalidan el cursor (p. ej. filtro de etiquetas de Gmail). */
  needsResync?(prev: S, next: S): boolean;
  /** Cursor tras un cambio de selección que obliga a recargar (por defecto vacío). */
  resetCursor?(cursor: Record<string, unknown>): Record<string, unknown>;
  /** false = falta configurar algo (p. ej. elegir canales) antes de sincronizar. */
  ready?(settings: S): boolean;
  options(http: ProviderHttp, tokens: TokenSet, settings: S): Promise<OptionGroup[]>;
  sync(run: SyncRun<S>): Promise<SyncOutcome>;
}
