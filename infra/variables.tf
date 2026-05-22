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
