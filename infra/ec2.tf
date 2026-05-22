# ---------------------------------------------------------------------------
# Processor: a small EC2 instance that runs the loader control panel so media
# can be ingested from a phone. Reaches S3 via an instance role (no static
# keys), is reachable over HTTPS via a nip.io hostname on its Elastic IP, and
# is protected by the panel's basic auth. Manage/recover it with SSM Session
# Manager (no SSH port is opened).
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

data "aws_ami" "al2023" {
  count       = var.enable_processor ? 1 : 0
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

data "aws_iam_policy_document" "processor_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "processor" {
  count              = var.enable_processor ? 1 : 0
  name               = "${var.project}-processor"
  assume_role_policy = data.aws_iam_policy_document.processor_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "processor" {
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
  statement {
    sid       = "ReadSecrets"
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = ["arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${var.ssm_param_prefix}/*"]
  }
  statement {
    sid       = "DecryptSecrets"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "processor" {
  count  = var.enable_processor ? 1 : 0
  name   = "processor"
  role   = aws_iam_role.processor[0].id
  policy = data.aws_iam_policy_document.processor.json
}

# Enables SSM Session Manager (browser shell) for management/recovery.
resource "aws_iam_role_policy_attachment" "processor_ssm" {
  count      = var.enable_processor ? 1 : 0
  role       = aws_iam_role.processor[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "processor" {
  count = var.enable_processor ? 1 : 0
  name  = "${var.project}-processor"
  role  = aws_iam_role.processor[0].name
}

resource "aws_security_group" "processor" {
  count       = var.enable_processor ? 1 : 0
  name        = "${var.project}-processor"
  description = "gc-media processor: HTTP/HTTPS in, all out"
  tags        = local.tags

  ingress {
    description = "HTTP (ACME cert challenge + redirect to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTPS control panel"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_eip" "processor" {
  count  = var.enable_processor ? 1 : 0
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${var.project}-processor" })
}

locals {
  # Stable hostname that resolves to the Elastic IP, so Caddy can get a real
  # Let's Encrypt cert without owning a domain.
  processor_host = var.enable_processor ? "${replace(aws_eip.processor[0].public_ip, ".", "-")}.nip.io" : ""
}

resource "aws_instance" "processor" {
  count                  = var.enable_processor ? 1 : 0
  ami                    = data.aws_ami.al2023[0].id
  instance_type          = var.processor_instance_type
  iam_instance_profile   = aws_iam_instance_profile.processor[0].name
  vpc_security_group_ids = [aws_security_group.processor[0].id]
  tags                   = merge(local.tags, { Name = "${var.project}-processor" })

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
  }

  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/processor/userdata.sh.tftpl", {
    region     = var.aws_region
    repo_url   = var.github_repo_url
    branch     = var.github_branch
    ssm_prefix = var.ssm_param_prefix
    panel_user = var.panel_user
    panel_host = local.processor_host
  })
}

resource "aws_eip_association" "processor" {
  count         = var.enable_processor ? 1 : 0
  instance_id   = aws_instance.processor[0].id
  allocation_id = aws_eip.processor[0].id
}
