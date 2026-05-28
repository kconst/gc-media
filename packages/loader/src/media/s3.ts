import fs from "node:fs";
import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { config } from "../config.js";

let client: S3Client | undefined;

function s3(): S3Client {
  if (!client) {
    const { accessKeyId, secretAccessKey, region } = config.aws;
    client = new S3Client({
      region,
      // Use scoped loader creds when provided; otherwise fall back to the
      // ambient credential chain.
      credentials:
        accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined,
    });
  }
  return client;
}

export function cloudfrontUrl(key: string): string {
  return `https://${config.aws.cloudfrontDomain()}/${key}`;
}

// S3 PutObject caps at 5GB; larger derivatives (long-clip web.mp4s) must use
// multipart upload.
const MULTIPART_THRESHOLD = 4.5 * 1024 ** 3;
const PART_SIZE = 100 * 1024 * 1024;

export async function uploadFile(
  key: string,
  localPath: string,
  contentType: string,
): Promise<string> {
  const size = fs.statSync(localPath).size;
  if (size < MULTIPART_THRESHOLD) {
    await s3().send(
      new PutObjectCommand({
        Bucket: config.aws.bucket(),
        Key: key,
        Body: fs.createReadStream(localPath),
        ContentType: contentType,
      }),
    );
    return cloudfrontUrl(key);
  }
  return uploadMultipart(key, localPath, contentType, size);
}

async function uploadMultipart(
  key: string,
  localPath: string,
  contentType: string,
  size: number,
): Promise<string> {
  const Bucket = config.aws.bucket();
  const created = await s3().send(
    new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType }),
  );
  const UploadId = created.UploadId;
  const parts: { ETag: string | undefined; PartNumber: number }[] = [];
  const fd = await fs.promises.open(localPath, "r");
  try {
    const buf = Buffer.allocUnsafe(PART_SIZE);
    let pos = 0;
    let partNumber = 1;
    while (pos < size) {
      const { bytesRead } = await fd.read(buf, 0, PART_SIZE, pos);
      if (bytesRead <= 0) break;
      const out = await s3().send(
        new UploadPartCommand({
          Bucket,
          Key: key,
          UploadId,
          PartNumber: partNumber,
          Body: buf.subarray(0, bytesRead),
        }),
      );
      parts.push({ ETag: out.ETag, PartNumber: partNumber });
      pos += bytesRead;
      partNumber++;
    }
    await s3().send(
      new CompleteMultipartUploadCommand({
        Bucket,
        Key: key,
        UploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  } catch (err) {
    await s3().send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId })).catch(() => {});
    throw err;
  } finally {
    await fd.close();
  }
  return cloudfrontUrl(key);
}

export async function uploadBuffer(
  key: string,
  body: Buffer | string,
  contentType: string,
  cacheControl?: string,
): Promise<string> {
  await s3().send(
    new PutObjectCommand({
      Bucket: config.aws.bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
    }),
  );
  return cloudfrontUrl(key);
}

/** List every object key in the bucket (paginated). */
export async function listAllKeys(): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const r = await s3().send(
      new ListObjectsV2Command({ Bucket: config.aws.bucket(), ContinuationToken: token }),
    );
    for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Delete the given keys (batched 1000 per request). Returns the count. */
export async function deleteKeys(keys: string[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await s3().send(
      new DeleteObjectsCommand({
        Bucket: config.aws.bucket(),
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    n += batch.length;
  }
  return n;
}
