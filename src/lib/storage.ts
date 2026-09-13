import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'
import { env } from '../config/env.js'

const s3 = new S3Client({
  endpoint: env.MINIO_ENDPOINT,
  region: 'us-east-1', // required by the SDK; arbitrary — MinIO ignores it
  credentials: {
    accessKeyId: env.MINIO_ACCESS_KEY,
    secretAccessKey: env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true, // MinIO requires path-style addressing, not virtual-hosted
})

function extensionFor(contentType: string): string {
  return contentType.split('/')[1]?.split('+')[0] ?? 'bin'
}

/**
 * Uploads to the public bucket, fronted by imgproxy for on-the-fly
 * resizing — used for listing photos and chat images. Stores the original
 * as-is; resizing happens at read time via `publicUrl()`, not here, so
 * transforms always match the current imgproxy config instead of being
 * baked in permanently at upload time.
 */
export async function uploadPublic(buffer: Buffer, folder: string, contentType: string): Promise<string> {
  const key = `${folder}/${randomUUID()}.${extensionFor(contentType)}`
  await s3.send(new PutObjectCommand({
    Bucket: env.MINIO_PUBLIC_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }))
  return key
}

export async function deletePublic(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.MINIO_PUBLIC_BUCKET, Key: key }))
}

/**
 * Uploads to the private bucket — no public read access. Used for business
 * verification documents and payment transfer proofs, where Cloudinary
 * previously used `type: 'authenticated'` delivery. Only reachable via
 * `signedPrivateUrl()`, matching the old `private_download_url` behavior.
 */
export async function uploadPrivate(buffer: Buffer, folder: string, contentType: string): Promise<string> {
  const key = `${folder}/${randomUUID()}.${extensionFor(contentType)}`
  await s3.send(new PutObjectCommand({
    Bucket: env.MINIO_PRIVATE_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }))
  return key
}

/** Short-lived signed GET URL for a private-bucket object. */
export async function signedPrivateUrl(key: string, expiresInSeconds = 300): Promise<string> {
  const command = new GetObjectCommand({ Bucket: env.MINIO_PRIVATE_BUCKET, Key: key })
  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds })
}

const RESIZE_PRESETS = {
  /** Grid/list thumbnails */
  thumb: 'rs:fill:400:400',
  /** Chat bubbles, small avatars */
  small: 'rs:fill:200:200',
  /** Listing detail hero / gallery — fit, not fill, to preserve aspect ratio */
  hero: 'rs:fit:1200:1200',
} as const

export type ResizePreset = keyof typeof RESIZE_PRESETS

/**
 * Builds an imgproxy URL that resizes a public-bucket object on the fly.
 * imgproxy fetches the source itself over the internal docker network
 * (IMGPROXY_ALLOWED_SOURCES restricts it to MinIO's address only) — clients
 * never talk to MinIO directly.
 */
export function publicUrl(key: string, preset: ResizePreset = 'thumb'): string {
  const source = `${env.MINIO_ENDPOINT}/${env.MINIO_PUBLIC_BUCKET}/${key}`
  return `${env.IMGPROXY_URL}/unsafe/${RESIZE_PRESETS[preset]}/plain/${encodeURIComponent(source)}`
}
