# Ambiente dev (cuenta AWS separada de staging/prod). Estado remoto en S3 con locking nativo.
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "s3" {
    # bucket/key/region se pasan con -backend-config=backend.hcl (no versionado).
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "ragsis", Environment = var.env, ManagedBy = "terraform" }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}
variable "env" {
  type    = string
  default = "dev"
}
variable "image_tag" { type = string }
variable "certificate_arn" { type = string }
variable "public_base_url" { type = string }
variable "signature_email_from" {
  type    = string
  default = ""
}
variable "signature_email_identity_arn" {
  type    = string
  default = ""
}
variable "oidc_issuer" { type = string }
variable "oidc_audience" { type = string }
variable "alarm_email" { type = string }
variable "monthly_budget_usd" {
  type    = number
  default = 500
}
variable "bedrock_model_arns" {
  type        = list(string)
  description = "Verificar disponibilidad regional antes de habilitar (sección 08 del plan)"
}

locals {
  name = "ragsis-${var.env}"
}

module "network" {
  source     = "../../modules/network"
  name       = local.name
  cidr       = "10.20.0.0/16"
  azs        = ["${var.region}a", "${var.region}b"]
  single_nat = true
}

module "security" {
  source = "../../modules/security"
  name   = local.name
}

module "storage" {
  source      = "../../modules/storage"
  name        = local.name
  kms_key_arn = module.security.kms_key_arn
  web_origins = [var.public_base_url]
}

module "compute" {
  source             = "../../modules/compute"
  name               = local.name
  region             = var.region
  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids
  certificate_arn    = var.certificate_arn
  kms_key_arn        = module.security.kms_key_arn
  app_secret_arn     = module.security.app_secret_arn
  db_endpoint        = module.database.endpoint
  bucket_name        = module.storage.bucket_name
  bucket_arn         = module.storage.bucket_arn
  ingest_queue_url   = module.storage.ingest_queue_url
  ingest_queue_arn   = module.storage.ingest_queue_arn
  ingest_queue_name  = module.storage.ingest_queue_name
  public_base_url    = var.public_base_url

  signature_email_from         = var.signature_email_from
  signature_email_identity_arn = var.signature_email_identity_arn

  oidc_issuer        = var.oidc_issuer
  oidc_audience      = var.oidc_audience
  image_tag          = var.image_tag
  bedrock_model_arns = var.bedrock_model_arns
}

module "database" {
  source                     = "../../modules/database"
  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [module.compute.tasks_security_group_id]
  kms_key_arn                = module.security.kms_key_arn
  multi_az                   = false
  deletion_protection        = true
}

module "edge" {
  source  = "../../modules/edge"
  name    = local.name
  alb_arn = module.compute.alb_arn
}

module "observability" {
  source             = "../../modules/observability"
  name               = local.name
  alarm_email        = var.alarm_email
  alb_arn_suffix     = regex("loadbalancer/(.+)$", module.compute.alb_arn)[0]
  dlq_name           = module.storage.ingest_dlq_name
  db_instance_id     = module.database.instance_id
  monthly_budget_usd = var.monthly_budget_usd
}

output "alb_dns_name" { value = module.compute.alb_dns_name }
output "ecr_repositories" { value = module.compute.ecr_repositories }
output "documents_bucket" { value = module.storage.bucket_name }
