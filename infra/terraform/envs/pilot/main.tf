terraform {
  required_version = ">= 1.9.8"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "aws_account_id" {
  type        = string
  description = "Cuenta autorizada para este piloto."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Usa un identificador de cuenta AWS de 12 dígitos."
  }
}

variable "pilot_hostname" {
  type        = string
  description = "Subdominio público para HTTPS y Cognito, sin protocolo ni ruta."

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.pilot_hostname))
    error_message = "Usa un nombre DNS como piloto.example.com."
  }
}

locals {
  name        = "ragsis-pilot"
  region      = "us-east-2"
  origin      = "https://${var.pilot_hostname}"
  registry    = "${var.aws_account_id}.dkr.ecr.${local.region}.amazonaws.com"
  image_names = toset(["api", "ingest-worker", "rag-engine", "web"])
}

provider "aws" {
  region              = local.region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = { Project = "ragsis", Environment = "pilot", ManagedBy = "terraform" }
  }
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

resource "aws_security_group" "web" {
  name        = "${local.name}-web"
  description = "Entrada HTTP y HTTPS para Caddy"
  vpc_id      = data.aws_vpc.default.id
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each          = toset(["80", "443"])
  security_group_id = aws_security_group.web.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
}

resource "aws_vpc_security_group_egress_rule" "web" {
  security_group_id = aws_security_group.web.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_kms_key" "data" {
  description             = "Cifrado de documentos y colas de Ragsis piloto"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

module "storage" {
  source      = "../../modules/storage"
  name        = local.name
  kms_key_arn = aws_kms_key.data.arn
  web_origins = [local.origin]
}

resource "aws_ecr_repository" "app" {
  for_each             = local.image_names
  name                 = "${local.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_iam_role" "host" {
  name = "${local.name}-ec2"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "runtime" {
  name = "${local.name}-runtime"
  role = aws_iam_role.host.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = module.storage.bucket_arn
        Condition = {
          StringLike = { "s3:prefix" = "tenants/*" }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${module.storage.bucket_arn}/tenants/*"
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"]
        Resource = module.storage.ingest_queue_arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = aws_kms_key.data.arn
        Condition = {
          StringEquals = { "kms:ViaService" = ["s3.${local.region}.amazonaws.com", "sqs.${local.region}.amazonaws.com"] }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
        Resource = [for repo in aws_ecr_repository.app : repo.arn]
      }
    ]
  })
}

resource "aws_iam_instance_profile" "host" {
  name = aws_iam_role.host.name
  role = aws_iam_role.host.name
}

resource "aws_instance" "pilot" {
  ami                         = nonsensitive(data.aws_ssm_parameter.ubuntu.value)
  instance_type               = "m7i-flex.large"
  subnet_id                   = sort(data.aws_subnets.default.ids)[0]
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.web.id]
  iam_instance_profile        = aws_iam_instance_profile.host.name

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    encrypted   = true
    volume_type = "gp3"
    volume_size = 30
  }

  user_data = <<-BOOT
    #!/bin/bash
    set -eu
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y docker.io docker-compose-v2 amazon-ecr-credential-helper
    install -d -m 0700 /root/.docker /opt/ragsis/postgres
    umask 077
    printf '%s\n' '{"credHelpers":{"${local.registry}":"ecr-login"}}' > /root/.docker/config.json
    systemctl enable --now docker
  BOOT

  lifecycle {
    # Actualiza la AMI de forma deliberada después de respaldar el volumen.
    ignore_changes = [ami]
  }

  tags = { Name = local.name }
}

resource "aws_eip" "pilot" {
  domain   = "vpc"
  instance = aws_instance.pilot.id
  tags     = { Name = local.name }
}

resource "aws_cognito_user_pool" "pilot" {
  name                     = local.name
  user_pool_tier           = "LITE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

resource "aws_cognito_user_pool_client" "web" {
  name                                 = "${local.name}-web"
  user_pool_id                         = aws_cognito_user_pool.pilot.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["${local.origin}/api/auth/callback"]
  logout_urls                          = ["${local.origin}/login"]
  prevent_user_existence_errors        = "ENABLED"
}

resource "aws_cognito_user_pool_domain" "pilot" {
  domain                = "${local.name}-${var.aws_account_id}"
  user_pool_id          = aws_cognito_user_pool.pilot.id
  managed_login_version = 1
}

output "instance_id" { value = aws_instance.pilot.id }
output "dns_ipv4" { value = aws_eip.pilot.public_ip }
output "user_pool_id" { value = aws_cognito_user_pool.pilot.id }
output "ecr_repositories" { value = { for name, repo in aws_ecr_repository.app : name => repo.repository_url } }

output "runtime" {
  value = {
    AWS_REGION           = local.region
    PILOT_HOSTNAME       = var.pilot_hostname
    S3_BUCKET            = module.storage.bucket_name
    SQS_INGEST_QUEUE_URL = module.storage.ingest_queue_url
    OIDC_ISSUER          = "https://${aws_cognito_user_pool.pilot.endpoint}"
    OIDC_AUDIENCE        = aws_cognito_user_pool_client.web.id
  }
}
