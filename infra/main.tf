terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }

  # Durable, shareable state so the stack can be managed from anywhere
  # (e.g. AWS CloudShell on a phone).
  backend "s3" {
    bucket  = "gc-media-tfstate-588994405361"
    key     = "infra/terraform.tfstate"
    region  = "us-east-1"
    encrypt = true
  }
}

provider "aws" {
  region = var.aws_region
  # Credentials come from the environment (the temporary STS admin creds).
}

resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  bucket_name = var.bucket_name != "" ? var.bucket_name : "${var.project}-${random_id.suffix.hex}"
  tags = {
    Project   = var.project
    ManagedBy = "terraform"
  }
}

# ---------------------------------------------------------------------------
# Media bucket: private, fronted by CloudFront only.
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "media" {
  bucket = local.bucket_name
  tags   = local.tags
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.web_origins
    allowed_headers = ["*"]
    max_age_seconds = 3600
  }
}

# ---------------------------------------------------------------------------
# CloudFront in front of S3 via Origin Access Control (bucket stays private).
# ---------------------------------------------------------------------------
resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "${var.project}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "media" {
  enabled             = true
  comment             = "${var.project} media CDN"
  default_root_object = ""
  price_class         = "PriceClass_100"
  tags                = local.tags

  origin {
    domain_name              = aws_s3_bucket.media.bucket_regional_domain_name
    origin_id                = "s3-media"
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-media"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # AWS managed "CachingOptimized" policy.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    # AWS managed "SimpleCORS" response headers policy.
    response_headers_policy_id = "60669652-455b-4ae9-85a4-c4c02393f86c"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# Allow only this CloudFront distribution to read the bucket.
data "aws_iam_policy_document" "bucket_policy" {
  statement {
    sid       = "AllowCloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.media.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = data.aws_iam_policy_document.bucket_policy.json
}

# ---------------------------------------------------------------------------
# Least-privilege IAM user for the loader (upload-only on this bucket).
# ---------------------------------------------------------------------------
resource "aws_iam_user" "loader" {
  name = "${var.project}-loader"
  tags = local.tags
}

data "aws_iam_policy_document" "loader" {
  statement {
    sid       = "ManageMediaObjects"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }
  statement {
    sid       = "ListMediaBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]
  }
}

resource "aws_iam_user_policy" "loader" {
  name   = "media-upload"
  user   = aws_iam_user.loader.name
  policy = data.aws_iam_policy_document.loader.json
}

resource "aws_iam_access_key" "loader" {
  user = aws_iam_user.loader.name
}
