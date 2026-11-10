# AWS WAF en el ALB: reglas administradas + rate limit por IP. CloudFront se agrega delante
# cuando haya assets cacheables o múltiples regiones (decisión documentada en ADR).
variable "name" { type = string }
variable "alb_arn" { type = string }
variable "rate_limit_per_5min" {
  type    = number
  default = 2000
}

resource "aws_wafv2_web_acl" "this" {
  name  = "${var.name}-waf"
  scope = "REGIONAL"
  default_action {
    allow {}
  }

  dynamic "rule" {
    for_each = { AWSManagedRulesCommonRuleSet = 10, AWSManagedRulesKnownBadInputsRuleSet = 20, AWSManagedRulesAmazonIpReputationList = 30 }
    content {
      name     = rule.key
      priority = rule.value
      override_action {
        none {}
      }
      statement {
        managed_rule_group_statement {
          name        = rule.key
          vendor_name = "AWS"
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.key
        sampled_requests_enabled   = true
      }
    }
  }

  rule {
    name     = "rate-limit-ip"
    priority = 40
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.rate_limit_per_5min
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-waf"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = var.alb_arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}
