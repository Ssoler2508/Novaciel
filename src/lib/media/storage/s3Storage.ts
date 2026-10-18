import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Storage } from './types.js';

export interface S3StorageOptions {
  /** Omit for AWS S3; set for other S3-compatible services (R2, B2, ...). */
  endpoint?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** For tests only: replaces the AWS client, so no network is used. */
  client?: Pick<S3Client, 'send'>;
}

export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly sender: Pick<S3Client, 'send'>;
  private readonly bucket: string;

  constructor(opts: S3StorageOptions) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region ?? 'us-east-1',
      forcePathStyle: true, // path-style URLs work with S3-compatible services
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
    this.sender = opts.client ?? this.client;
  }

  async put(key: string, body: Buffer, contentType?: string): Promise<void> {
    await this.sender.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  /**
   * Streams the file with a single PutObject (up to 5 GB, above our 2 GiB upload limit), so no
   * extra multipart library is needed. The AWS SDK cannot replay a consumed stream: a transient
   * failure fails the upload instead of retrying it, and the caller retries the whole upload.
   */
  async putFile(key: string, filePath: string, contentType?: string): Promise<void> {
    const { size } = await stat(filePath);
    await this.sender.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty body for object: ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  /** Streams the object to a file; a failed copy leaves no partial file. */
  async getFile(key: string, destPath: string): Promise<void> {
    const res = await this.sender.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty body for object: ${key}`);
    try {
      await pipeline(res.Body as Readable, createWriteStream(destPath));
    } catch (err) {
      await unlink(destPath).catch(() => undefined);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  getSignedUrl(key: string, expiresInSeconds = 900): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}
