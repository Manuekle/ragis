# KMS por ambiente (CMK por cliente en el template dedicated_tenant) y secretos de aplicación.
variable "name" { type = string }

data "aws_caller_identity" "current" {}

resource "aws_kms_key" "data" {
  description             = "${var.name} datos de clientes (S3, RDS, SQS, Secrets, Logs)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.amazonaws.com" }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
      }
    ]
  })
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "random_password" "app_db" {
  length  = 40
  special = false
}

resource "random_password" "worker_db" {
  length  = 40
  special = false
}

resource "random_password" "internal" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name       = "${var.name}/app"
  kms_key_id = aws_kms_key.data.arn
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    RAGSIS_APP_DB_PASSWORD    = random_password.app_db.result
    RAGSIS_WORKER_DB_PASSWORD = random_password.worker_db.result
    INTERNAL_SERVICE_SECRET   = random_password.internal.result
  })
}

output "kms_key_arn" { value = aws_kms_key.data.arn }
output "app_secret_arn" { value = aws_secretsmanager_secret.app.arn }
