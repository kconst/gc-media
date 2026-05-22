import fs from "node:fs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
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

export async function uploadFile(
  key: string,
  localPath: string,
  contentType: string,
): Promise<string> {
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

export async function uploadBuffer(
  key: string,
  body: Buffer | string,
  contentType: string,
): Promise<string> {
  await s3().send(
    new PutObjectCommand({
      Bucket: config.aws.bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return cloudfrontUrl(key);
}
