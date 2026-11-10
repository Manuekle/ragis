variable "name" { type = string }
variable "region" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "private_subnet_ids" { type = list(string) }
variable "certificate_arn" {
  type        = string
  description = "Certificado ACM para el listener HTTPS del ALB"
}
variable "kms_key_arn" { type = string }
variable "app_secret_arn" { type = string }
variable "db_endpoint" { type = string }
variable "bucket_name" { type = string }
variable "bucket_arn" { type = string }
variable "ingest_queue_url" { type = string }
variable "ingest_queue_arn" { type = string }
variable "ingest_queue_name" { type = string }
variable "public_base_url" {
  type        = string
  description = "URL pública de la web (CORS / cookies)"
}
variable "signature_email_from" {
  type        = string
  default     = ""
  description = "Remitente de Ragsis Sign, verificado en SES en esta región. Vacío habilita firmas internas."
}
variable "signature_email_identity_arn" {
  type        = string
  default     = ""
  description = "ARN de la identidad SES autorizada para enviar desde signature_email_from."
  validation {
    condition     = (var.signature_email_from == "") == (var.signature_email_identity_arn == "")
    error_message = "Configure el remitente y su ARN de identidad SES juntos."
  }
}
variable "oidc_issuer" { type = string }
variable "oidc_audience" { type = string }
variable "image_tag" {
  type        = string
  description = "Tag inmutable (git sha) desplegado en todos los servicios"
}
variable "ai" {
  type = object({
    embedding_model  = string
    generation_model = string
    rerank_model     = string
  })
  default = {
    embedding_model  = "bedrock-titan-embed-v2-1024@v1"
    generation_model = "bedrock-nova-lite@v1"
    rerank_model     = "local-lexical-rerank@v1"
  }
}
variable "bedrock_model_arns" {
  type        = list(string)
  description = "ARNs de foundation models / inference profiles permitidos (allowlist IAM)"
}
variable "sizes" {
  type = map(object({ cpu = number, memory = number, min = number, max = number }))
  default = {
    web    = { cpu = 512, memory = 1024, min = 1, max = 4 }
    api    = { cpu = 512, memory = 1024, min = 1, max = 6 }
    rag    = { cpu = 1024, memory = 2048, min = 1, max = 6 }
    worker = { cpu = 2048, memory = 4096, min = 0, max = 8 }
  }
}
variable "clamav_image" {
  type    = string
  default = "clamav/clamav:stable"
}
variable "ocr_provider" {
  type        = string
  default     = "textract"
  description = "none | textract (Textract solo para tenants cuya política lo permita)"
}
variable "otel_endpoint" {
  type        = string
  default     = ""
  description = "Endpoint OTLP/HTTP (p. ej. ADOT collector). Vacío = trazas desactivadas"
}
