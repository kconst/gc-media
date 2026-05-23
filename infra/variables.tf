variable "aws_region" {
  description = "AWS region for the media bucket."
  type        = string
  default     = "us-west-2"
}

variable "project" {
  description = "Project name prefix for resource names/tags."
  type        = string
  default     = "gc-media"
}

variable "bucket_name" {
  description = "Globally-unique S3 bucket name for media. Leave empty to auto-generate from project + random suffix."
  type        = string
  default     = ""
}

variable "web_origins" {
  description = "Allowed CORS origins for the media bucket (your Vercel URLs + localhost for dev)."
  type        = list(string)
  default     = ["http://localhost:3000"]
}

# ---------------------------------------------------------------------------
# Optional processor EC2 instance (runs the loader control panel in the cloud).
# Off by default so the base apply is unaffected; set enable_processor=true.
# Secrets are read at boot from SSM Parameter Store (NOT stored in tfstate):
#   <ssm_param_prefix>/ANTHROPIC_API_KEY      (SecureString)
#   <ssm_param_prefix>/GOOGLE_MAPS_API_KEY    (SecureString or String)
#   <ssm_param_prefix>/GOOGLE_MAPS_MAP_ID     (String)
#   <ssm_param_prefix>/PANEL_PASSWORD         (SecureString)
#   <ssm_param_prefix>/GITHUB_TOKEN           (SecureString, optional; for a private repo clone)
# ---------------------------------------------------------------------------
variable "enable_processor" {
  description = "Create the EC2 processor instance + control panel."
  type        = bool
  default     = false
}

variable "processor_instance_type" {
  description = "EC2 instance type for the processor."
  type        = string
  default     = "t3.small"
}

variable "panel_user" {
  description = "Basic-auth username for the control panel."
  type        = string
  default     = "gc"
}

variable "github_repo_url" {
  description = "HTTPS git URL the instance clones to run the loader."
  type        = string
  default     = "https://github.com/kconst/gc-media.git"
}

variable "github_branch" {
  description = "Branch to deploy on the processor."
  type        = string
  default     = "main"
}

variable "ssm_param_prefix" {
  description = "SSM Parameter Store path prefix holding the processor's secrets."
  type        = string
  default     = "/gc-media"
}

variable "vpc_id" {
  description = "VPC for the processor (this account has no default VPC, so set it explicitly)."
  type        = string
  default     = ""
}

variable "subnet_id" {
  description = "Public subnet (routes to an internet gateway) for the processor instance."
  type        = string
  default     = ""
}
