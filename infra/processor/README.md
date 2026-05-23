# Processor (EC2 control panel)

A small EC2 instance that runs the loader's web **control panel** so you can
ingest media, place pins, and manage the map from a phone browser — no laptop
needed.

**Live:** https://3-225-166-109.nip.io  (log in as user `gc`)

- HTTPS via Caddy with an automatic Let's Encrypt cert on a `nip.io` hostname
  pinned to the instance's Elastic IP (no domain required).
- S3 access through an **instance role** (no static keys on the box).
- Secrets are read at boot from **SSM Parameter Store** (not stored in tfstate).
- Manage/recover the box with **SSM Session Manager** (no SSH port is open).

## What's deployed

| Resource | Value |
|---|---|
| Instance | `i-049101f059ddf0ee5` (`t3.small`, us-east-1) |
| Elastic IP | `3.225.166.109` |
| Panel URL | `https://3-225-166-109.nip.io` |
| Terraform state | `s3://gc-media-tfstate-588994405361/infra/terraform.tfstate` |

## Secrets (SSM Parameter Store, prefix `/gc-media`)

Set/rotate these from the AWS Console (Systems Manager → Parameter Store) or
CloudShell. The instance reads them at boot:

| Name | Type | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | SecureString | **Currently a placeholder** — set the real key to enable AI analysis. |
| `GOOGLE_MAPS_API_KEY` | SecureString | Used by the placement map. |
| `GOOGLE_MAPS_MAP_ID` | String | |
| `PANEL_PASSWORD` | SecureString | Basic-auth password for the panel. |
| `MEDIA_BUCKET` | String | `gc-media-588994405361` |
| `CLOUDFRONT_DOMAIN` | String | `d3etcbrcz4shm0.cloudfront.net` |

After changing a secret, restart the panel so it re-reads them:

```bash
# via SSM Session Manager (browser shell from EC2 console), or CloudShell run-command:
sudo bash /opt/gc-media/infra/processor/setup.sh    # re-reads SSM, rewrites env, restarts
```

## Update the code on the instance

```bash
cd /opt/gc-media && sudo git pull && sudo systemctl restart gc-panel
```

## Start / stop to control cost

The instance bills while **running** (~$0.02/hr for `t3.small`); near-zero when
stopped. The Elastic IP keeps the panel URL stable across stop/start.

- **Phone:** AWS Console → EC2 → Instances → select `gc-media-processor` →
  Instance state → **Stop** / **Start**.
- **CloudShell:**
  ```bash
  aws ec2 stop-instances  --instance-ids i-049101f059ddf0ee5 --region us-east-1
  aws ec2 start-instances --instance-ids i-049101f059ddf0ee5 --region us-east-1
  ```

## Manage with Terraform (from CloudShell)

State lives in S3, so you can drive the stack from anywhere:

```bash
git clone https://github.com/kconst/gc-media.git
cd gc-media/infra
terraform init
terraform plan          # uses infra/terraform.tfvars (enable_processor=true)
```

Tear the processor down (keeps S3/CloudFront/loader IAM):

```bash
terraform destroy -target=aws_eip_association.processor \
  -target=aws_instance.processor -target=aws_eip.processor \
  -target=aws_security_group.processor
# or set enable_processor=false in terraform.tfvars and `terraform apply`
```

## Two follow-ups

- **Maps key referrers:** if your Google Maps key restricts HTTP referrers,
  add `https://3-225-166-109.nip.io/*` (or `https://*.nip.io/*`) or the
  placement map won't render.
- **Real Anthropic key:** ingestion with AI is disabled until you replace the
  `ANTHROPIC_API_KEY` placeholder in SSM.
