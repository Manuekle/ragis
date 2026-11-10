# RDS PostgreSQL 17 + pgvector: privado, cifrado con KMS, backups y Performance Insights.
# Los roles ragsis_app / ragsis_worker (sin BYPASSRLS) se crean con el runbook de bootstrap de BD.
variable "name" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "allowed_security_group_ids" { type = list(string) }
variable "kms_key_arn" { type = string }
variable "instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "multi_az" {
  type    = bool
  default = false
}
variable "allocated_storage" {
  type    = number
  default = 50
}
variable "backup_retention_days" {
  type    = number
  default = 14
}
variable "deletion_protection" {
  type    = bool
  default = true
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-db"
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "db" {
  name   = "${var.name}-db"
  vpc_id = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "db" {
  for_each                     = toset(var.allowed_security_group_ids)
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-pg17"
  family = "postgres17"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "2000"
  }
}

resource "aws_db_instance" "this" {
  identifier                          = "${var.name}-pg"
  engine                              = "postgres"
  engine_version                      = "17"
  instance_class                      = var.instance_class
  allocated_storage                   = var.allocated_storage
  max_allocated_storage               = var.allocated_storage * 4
  storage_type                        = "gp3"
  storage_encrypted                   = true
  kms_key_id                          = var.kms_key_arn
  db_name                             = "ragsis"
  username                            = "ragsis_owner"
  manage_master_user_password         = true
  master_user_secret_kms_key_id       = var.kms_key_arn
  db_subnet_group_name                = aws_db_subnet_group.this.name
  vpc_security_group_ids              = [aws_security_group.db.id]
  parameter_group_name                = aws_db_parameter_group.this.name
  multi_az                            = var.multi_az
  publicly_accessible                 = false
  backup_retention_period             = var.backup_retention_days
  copy_tags_to_snapshot               = true
  deletion_protection                 = var.deletion_protection
  skip_final_snapshot                 = false
  final_snapshot_identifier           = "${var.name}-pg-final"
  performance_insights_enabled        = true
  performance_insights_kms_key_id     = var.kms_key_arn
  auto_minor_version_upgrade          = true
  enabled_cloudwatch_logs_exports     = ["postgresql"]
  iam_database_authentication_enabled = true
}

output "endpoint" { value = aws_db_instance.this.address }
output "master_secret_arn" { value = aws_db_instance.this.master_user_secret[0].secret_arn }
output "instance_id" { value = aws_db_instance.this.identifier }
