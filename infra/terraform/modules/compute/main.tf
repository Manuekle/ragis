# ECS Fargate (CPU) para web, api, rag-engine e ingest-worker. Sin K8s prematuro (ADR-001).
# GPU (MinerU/VLM/LLM local) se agrega como capacity provider EC2 g5/g6 en F3, no aquí.
locals {
  services = ["web", "api", "rag-engine", "ingest-worker"]
  image    = { for s in local.services : s => "${aws_ecr_repository.this[s].repository_url}:${var.image_tag}" }
  common_env = [
    { name = "RAGSIS_ENV", value = "production" },
    { name = "AWS_REGION", value = var.region },
    { name = "S3_BUCKET", value = var.bucket_name },
    { name = "SQS_INGEST_QUEUE_URL", value = var.ingest_queue_url },
    { name = "PGHOST", value = var.db_endpoint },
    { name = "PGDATABASE", value = "ragsis" },
    { name = "PGSSLMODE", value = "require" },
    { name = "AI_EMBEDDING_MODEL", value = var.ai.embedding_model },
    { name = "AI_GENERATION_MODEL", value = var.ai.generation_model },
    { name = "AI_RERANK_MODEL", value = var.ai.rerank_model },
    { name = "OCR_PROVIDER", value = var.ocr_provider },
    { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = var.otel_endpoint },
  ]
  secret = { for k in ["RAGSIS_APP_DB_PASSWORD", "RAGSIS_WORKER_DB_PASSWORD", "INTERNAL_SERVICE_SECRET"] :
  k => "${var.app_secret_arn}:${k}::" }
}

resource "aws_ecr_repository" "this" {
  for_each             = toset(local.services)
  name                 = "${var.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

resource "aws_service_discovery_http_namespace" "this" {
  name = "${var.name}.internal"
}

resource "aws_cloudwatch_log_group" "svc" {
  for_each          = toset(local.services)
  name              = "/ragsis/${var.name}/${each.key}"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn
}

# ------------------------------------------------------------------ IAM
data "aws_iam_policy_document" "assume_ecs" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.app_secret_arn },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arn },
    ]
  })
}

resource "aws_iam_role" "task" {
  for_each           = toset(local.services)
  name               = "${var.name}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs.json
}

locals {
  objects = "${var.bucket_arn}/tenants/*"
  # RAG-04: activos derivados (figuras) bajo tenants/<org>/assets/<doc>/<ver>/.
  assets = "${var.bucket_arn}/tenants/*/assets/*"
  bedrock = {
    Effect   = "Allow"
    Action   = ["bedrock:InvokeModel", "bedrock:Converse", "bedrock:Rerank", "bedrock:InvokeModelWithResponseStream"]
    Resource = var.bedrock_model_arns
  }
  task_policies = {
    web = []
    api = concat([
      { Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject"], Resource = local.objects },
      { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = var.ingest_queue_arn },
      { Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = var.kms_key_arn },
      ], var.signature_email_from == "" ? [] : [
      {
        Effect    = "Allow"
        Action    = ["ses:SendEmail"]
        Resource  = var.signature_email_identity_arn
        Condition = { StringEquals = { "ses:FromAddress" = var.signature_email_from } }
      },
    ])
    # VLM-enhanced: el rag-engine solo lee imágenes de figuras ya autorizadas por RLS/ACL.
    "rag-engine" = [
      local.bedrock,
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = local.assets },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arn },
    ]
    "ingest-worker" = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:DeleteObject"], Resource = local.objects },
      { Effect = "Allow", Action = ["s3:PutObject"], Resource = local.assets },
      # Purga por prefijo de los activos de un documento borrado.
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = var.bucket_arn,
        Condition = { StringLike = { "s3:prefix" = ["tenants/*/assets/*"] } } },
      { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"], Resource = var.ingest_queue_arn },
      { Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = var.kms_key_arn },
      # Textract asíncrono lee el objeto S3 con la identidad del worker (s3:GetObject + kms:Decrypt arriba).
      { Effect = "Allow", Action = ["textract:StartDocumentTextDetection", "textract:GetDocumentTextDetection"], Resource = "*" },
      local.bedrock,
    ]
  }
}

resource "aws_iam_role_policy" "task" {
  for_each = { for k, v in local.task_policies : k => v if length(v) > 0 }
  role     = aws_iam_role.task[each.key].id
  policy   = jsonencode({ Version = "2012-10-17", Statement = each.value })
}

# ------------------------------------------------------------------ red
resource "aws_security_group" "alb" {
  name   = "${var.name}-alb"
  vpc_id = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "alb_out" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 8080
}

resource "aws_security_group" "tasks" {
  name   = "${var.name}-tasks"
  vpc_id = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 4000
}

resource "aws_vpc_security_group_ingress_rule" "tasks_internal" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 4000
  to_port                      = 8080
}

resource "aws_vpc_security_group_egress_rule" "tasks_out" {
  security_group_id = aws_security_group.tasks.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "tasks_db" {
  security_group_id = aws_security_group.tasks.id
  cidr_ipv4         = "10.0.0.0/8"
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
}

resource "aws_vpc_security_group_egress_rule" "tasks_internal" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 4000
  to_port                      = 8080
}

# ------------------------------------------------------------------ ALB
resource "aws_lb" "this" {
  name                       = "${var.name}-alb"
  load_balancer_type         = "application"
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = true
}

resource "aws_lb_target_group" "web" {
  name        = "${var.name}-web"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check { path = "/login" }
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name}-api"
  port        = 4000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check { path = "/healthz" }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition {
    path_pattern { values = ["/v1/*", "/healthz"] }
  }
}

# ------------------------------------------------------------------ tareas
locals {
  defs = {
    web = {
      port = 3000, size = var.sizes.web, lb = aws_lb_target_group.web.arn
      env = [
        { name = "API_URL", value = "http://api:4000" },
        { name = "SESSION_COOKIE_SECURE", value = "true" },
        { name = "PUBLIC_BASE_URL", value = var.public_base_url },
        { name = "AUTH_MODE", value = "oidc" },
        { name = "OIDC_ISSUER", value = var.oidc_issuer },
        { name = "OIDC_CLIENT_ID", value = var.oidc_audience },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = var.otel_endpoint },
      ]
      sec = []
      cmd = null
    }
    api = {
      port = 4000, size = var.sizes.api, lb = aws_lb_target_group.api.arn
      env = concat(local.common_env, [
        { name = "PORT", value = "4000" },
        { name = "PGUSER", value = "ragsis_app" },
        { name = "RAG_ENGINE_URL", value = "http://rag-engine:8080" },
        { name = "AUTH_MODE", value = "oidc" },
        { name = "OIDC_ISSUER", value = var.oidc_issuer },
        { name = "OIDC_AUDIENCE", value = var.oidc_audience },
        { name = "CORS_ORIGINS", value = var.public_base_url },
        { name = "PUBLIC_BASE_URL", value = var.public_base_url },
        { name = "SIGNATURE_EMAIL_FROM", value = var.signature_email_from },
      ])
      sec = [{ name = "PGPASSWORD", valueFrom = local.secret.RAGSIS_APP_DB_PASSWORD },
      { name = "INTERNAL_SERVICE_SECRET", valueFrom = local.secret.INTERNAL_SERVICE_SECRET }]
      cmd = null
    }
    "rag-engine" = {
      port = 8080, size = var.sizes.rag, lb = null
      env  = concat(local.common_env, [{ name = "PGUSER", value = "ragsis_app" }])
      sec = [{ name = "PGPASSWORD", valueFrom = local.secret.RAGSIS_APP_DB_PASSWORD },
      { name = "INTERNAL_SERVICE_SECRET", valueFrom = local.secret.INTERNAL_SERVICE_SECRET }]
      cmd = null
    }
    "ingest-worker" = {
      port = null, size = var.sizes.worker, lb = null
      env  = concat(local.common_env, [{ name = "PGUSER", value = "ragsis_worker" }, { name = "MALWARE_SCANNER", value = "clamav" }, { name = "CLAMAV_HOST", value = "127.0.0.1" }])
      sec  = [{ name = "PGPASSWORD", valueFrom = local.secret.RAGSIS_WORKER_DB_PASSWORD }]
      cmd  = null
    }
  }
}

resource "aws_ecs_task_definition" "this" {
  for_each                 = local.defs
  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.size.cpu
  memory                   = each.value.size.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode(concat([{
    name                   = each.key
    image                  = local.image[each.key]
    essential              = true
    readonlyRootFilesystem = each.key != "web"
    stopTimeout            = 30
    environment            = each.value.env
    secrets                = each.value.sec
    portMappings           = each.value.port == null ? [] : [{ name = each.key, containerPort = each.value.port, protocol = "tcp" }]
    mountPoints            = each.key == "ingest-worker" ? [{ sourceVolume = "tmp", containerPath = "/tmp" }] : []
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.svc[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
    }], each.key == "ingest-worker" ? [{
    # Sidecar antimalware (clamd INSTREAM en 127.0.0.1:3310). Fijar por digest en producción.
    name         = "clamav"
    image        = var.clamav_image
    essential    = true
    portMappings = [{ containerPort = 3310, protocol = "tcp" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.svc[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "clamav"
      }
    }
  }] : []))
  dynamic "volume" {
    for_each = each.key == "ingest-worker" ? [1] : []
    content { name = "tmp" }
  }
}

resource "aws_ecs_service" "this" {
  for_each               = local.defs
  name                   = each.key
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.this[each.key].arn
  desired_count          = each.value.size.min
  launch_type            = "FARGATE"
  enable_execute_command = false
  propagate_tags         = "SERVICE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  dynamic "load_balancer" {
    for_each = each.value.lb == null ? [] : [each.value.lb]
    content {
      target_group_arn = load_balancer.value
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.this.arn
    dynamic "service" {
      for_each = each.value.port == null ? [] : [each.value.port]
      content {
        port_name = each.key
        client_alias {
          port     = service.value
          dns_name = each.key
        }
      }
    }
  }

  lifecycle { ignore_changes = [desired_count] }
}

# ------------------------------------------------------------------ autoscaling
resource "aws_appautoscaling_target" "this" {
  for_each           = local.defs
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = each.value.size.min
  max_capacity       = each.value.size.max
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each           = { for k, v in local.defs : k => v if k != "ingest-worker" }
  name               = "${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.this[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.this[each.key].scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
  }
}

# Workers escalan por profundidad de cola (backpressure), hasta cero en reposo.
resource "aws_appautoscaling_policy" "worker_queue" {
  name               = "ingest-worker-queue-depth"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.this["ingest-worker"].resource_id
  scalable_dimension = aws_appautoscaling_target.this["ingest-worker"].scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value = 10
    customized_metric_specification {
      metric_name = "ApproximateNumberOfMessagesVisible"
      namespace   = "AWS/SQS"
      statistic   = "Average"
      dimensions {
        name  = "QueueName"
        value = var.ingest_queue_name
      }
    }
  }
}

output "alb_arn" { value = aws_lb.this.arn }
output "alb_dns_name" { value = aws_lb.this.dns_name }
output "tasks_security_group_id" { value = aws_security_group.tasks.id }
output "cluster_name" { value = aws_ecs_cluster.this.name }
output "ecr_repositories" { value = { for k, r in aws_ecr_repository.this : k => r.repository_url } }
