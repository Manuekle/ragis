/** Bootstrap local idempotente: crea el bucket S3 de desarrollo. En AWS lo crea Terraform. */
import { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";

const bucket = process.env.S3_BUCKET ?? "ragsis-documents";
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
});

try {
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`bucket ${bucket} already exists`);
} catch {
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`bucket ${bucket} creado`);
}
try {
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [{ AllowedOrigins: ["http://localhost:3000"], AllowedMethods: ["PUT", "GET"], AllowedHeaders: ["*"], MaxAgeSeconds: 600 }],
      },
    }),
  );
} catch (err) {
  console.warn("CORS de bucket no soportado por el backend S3 local:", (err as Error).message);
}
