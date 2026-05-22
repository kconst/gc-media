output "media_bucket" {
  description = "Name of the S3 media bucket (set as MEDIA_BUCKET)."
  value       = aws_s3_bucket.media.id
}

output "cloudfront_domain" {
  description = "CloudFront domain serving the media (set as CLOUDFRONT_DOMAIN)."
  value       = aws_cloudfront_distribution.media.domain_name
}

output "loader_aws_access_key_id" {
  description = "Scoped loader IAM access key id (set as LOADER_AWS_ACCESS_KEY_ID)."
  value       = aws_iam_access_key.loader.id
}

output "loader_aws_secret_access_key" {
  description = "Scoped loader IAM secret (set as LOADER_AWS_SECRET_ACCESS_KEY)."
  value       = aws_iam_access_key.loader.secret
  sensitive   = true
}
