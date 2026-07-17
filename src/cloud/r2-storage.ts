import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET,
  );
}

function client() {
  if (!configured()) throw new Error("R2 is not configured");
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

export function isR2Configured() {
  return configured();
}

export function r2Uri(key: string) {
  return `r2://${process.env.R2_BUCKET}/${key.replace(/^\/+/, "")}`;
}

export function parseR2Uri(uri: string) {
  const match = uri.match(/^r2:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid R2 uri: ${uri}`);
  return { bucket: match[1], key: match[2] };
}

export async function uploadFileToR2(localPath: string, key: string, contentType = "application/octet-stream") {
  const bucket = process.env.R2_BUCKET!;
  await client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key.replace(/^\/+/, ""),
    Body: createReadStream(localPath),
    ContentType: contentType,
  }));
  return r2Uri(key);
}

export async function uploadBufferToR2(buffer: Buffer, key: string, contentType = "application/octet-stream") {
  const bucket = process.env.R2_BUCKET!;
  await client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key.replace(/^\/+/, ""),
    Body: buffer,
    ContentType: contentType,
  }));
  return r2Uri(key);
}

export async function downloadR2ToFile(uri: string, targetPath: string) {
  const { bucket, key } = parseR2Uri(uri);
  const result = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error(`R2 object has no body: ${uri}`);
  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as Readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, Buffer.concat(chunks));
  return targetPath;
}

export async function signedR2Url(uri: string, expiresIn = 900) {
  const { bucket, key } = parseR2Uri(uri);
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}

export async function signedR2UploadUrl(key: string, contentType = "application/octet-stream", expiresIn = 900) {
  const bucket = process.env.R2_BUCKET!;
  const objectKey = key.replace(/^\/+/, "");
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    ContentType: contentType,
  });
  return {
    uploadUrl: await getSignedUrl(client(), command, { expiresIn }),
    filePath: r2Uri(objectKey),
    key: objectKey,
    expiresIn,
  };
}

export async function deleteR2Object(uri: string) {
  const { bucket, key } = parseR2Uri(uri);
  await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
