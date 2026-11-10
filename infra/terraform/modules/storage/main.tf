# S3 privado (versionado, SSE-KMS, sin acceso público) + SQS de ingesta con DLQ.
variable "name" { type = string }
variable "kms_key_arn" { type = string }
variable "web_origins" { type = list(string) }
variable "noncurrent_version_days" {
  type    = number
  default = 90
}

resource "aws_s3_bucket" "documents" {
  bucket_prefix = "${var.name}-documents-"
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_policy" "tls_only" {
  bucket = aws_s3_bucket.documents.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    id     = "noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = var.noncurrent_version_days }
    abort_incomplete_multipart_upload { days_after_initiation = 2 }
  }
}

resource "aws_s3_bucket_cors_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  cors_rule {
    allowed_methods = ["PUT", "GET"]
    allowed_origins = var.web_origins
    allowed_headers = ["content-type"]
    max_age_seconds = 600
  }
}

resource "aws_sqs_queue" "ingest_dlq" {
  name                      = "${var.name}-ingest-dlq"
  message_retention_seconds = 1209600
  kms_master_key_id         = var.kms_key_arn
}

resource "aws_sqs_queue" "ingest" {
  name                       = "${var.name}-ingest"
  visibility_timeout_seconds = 300
  receive_wait_time_seconds  = 20
  message_retention_seconds  = 345600
  kms_master_key_id          = var.kms_key_arn
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ingest_dlq.arn
    maxReceiveCount     = 4
  })
}

output "bucket_name" { value = aws_s3_bucket.documents.bucket }
output "bucket_arn" { value = aws_s3_bucket.documents.arn }
output "ingest_queue_url" { value = aws_sqs_queue.ingest.url }
output "ingest_queue_arn" { value = aws_sqs_queue.ingest.arn }
output "ingest_queue_name" { value = aws_sqs_queue.ingest.name }
output "ingest_dlq_arn" { value = aws_sqs_queue.ingest_dlq.arn }
output "ingest_dlq_name" { value = aws_sqs_queue.ingest_dlq.name }
