import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "../config.js";

export interface Storage {
  presignPut(key: string, contentType: string, ttl: number): Promise<string>;
  presignGet(key: string, filename: string, ttl: number, disposition?: "attachment" | "inline", contentType?: string): Promise<string>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  /** Escritura/lectura de servidor (evidencias de firma, documentos a firmar). Nunca expuesta al cliente. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

export interface Queue {
  send(body: Record<string, unknown>): Promise<void>;
}

export function createStorage(cfg: Config): Storage {
  const opts = (endpoint?: string) => ({
    region: cfg.AWS_REGION,
    // Sin checksum por defecto: en URLs prefirmadas el SDK fijaría el CRC32 de un cuerpo vacío.
    requestChecksumCalculation: "WHEN_REQUIRED" as const,
    responseChecksumValidation: "WHEN_REQUIRED" as const,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
  const internal = new S3Client(opts(cfg.S3_ENDPOINT));
  // La firma incluye el host: las URLs para el navegador se firman con el endpoint público.
  const publicClient = new S3Client(opts(cfg.S3_PUBLIC_ENDPOINT ?? cfg.S3_ENDPOINT));
  return {
    presignPut: (key, contentType, ttl) =>
      getSignedUrl(publicClient, new PutObjectCommand({ Bucket: cfg.S3_BUCKET, Key: key, ContentType: contentType }), {
        expiresIn: ttl,
      }),
    presignGet: (key, filename, ttl, disposition = "attachment", contentType) =>
      getSignedUrl(
        publicClient,
        new GetObjectCommand({
          Bucket: cfg.S3_BUCKET,
          Key: key,
          ResponseContentDisposition: `${disposition}; filename="${filename.replace(/[^\w.\- ]/g, "_")}"`,
          ...(contentType ? { ResponseContentType: contentType } : {}),
        }),
        { expiresIn: ttl },
      ),
    head: async (key) => {
      try {
        const r = await internal.send(new HeadObjectCommand({ Bucket: cfg.S3_BUCKET, Key: key }));
        return { size: Number(r.ContentLength ?? 0) };
      } catch (err: unknown) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
    delete: async (key) => {
      await internal.send(new DeleteObjectCommand({ Bucket: cfg.S3_BUCKET, Key: key }));
    },
    put: async (key, body, contentType) => {
      await internal.send(new PutObjectCommand({ Bucket: cfg.S3_BUCKET, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: cfg.S3_ENDPOINT ? undefined : "aws:kms" }));
    },
    get: async (key) => {
      try {
        const r = await internal.send(new GetObjectCommand({ Bucket: cfg.S3_BUCKET, Key: key }));
        return Buffer.from(await r.Body!.transformToByteArray());
      } catch (err: unknown) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
  };
}

export function createQueue(cfg: Config): Queue {
  const sqs = new SQSClient({ region: cfg.AWS_REGION, ...(cfg.SQS_ENDPOINT ? { endpoint: cfg.SQS_ENDPOINT } : {}) });
  return {
    send: async (body) => {
      // Solo IDs y referencias; nunca secretos ni contenido del archivo.
      await sqs.send(new SendMessageCommand({ QueueUrl: cfg.SQS_INGEST_QUEUE_URL, MessageBody: JSON.stringify(body) }));
    },
  };
}
