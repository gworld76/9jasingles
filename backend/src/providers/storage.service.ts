import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Cloudflare R2 / AWS S3 media storage behind a CDN. */
@Injectable()
export class StorageService {
  private readonly s3 = new S3Client({
    region: process.env.S3_REGION ?? 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    },
  });
  private readonly bucket = process.env.S3_BUCKET ?? '9jasingles-media';

  newKey(userId: string, kind: 'photos' | 'voice' | 'chat', ext: string) {
    return `${kind}/${userId}/${randomUUID()}.${ext}`;
  }

  keyBelongsTo(key: string, userId: string, kind: 'photos' | 'voice' | 'chat') {
    return key.startsWith(`${kind}/${userId}/`);
  }

  async uploadUrl(key: string, contentType: string) {
    return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), { expiresIn: 600 });
  }

  async privateUrl(key: string) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: 3600 });
  }

  /** Public CDN URL. lowData = compressed variant; blur = blurred variant for Likes You / nudity. */
  cdnUrl(key: string, opts: { lowData?: boolean; blur?: boolean } = {}) {
    const params: string[] = [];
    if (opts.lowData) params.push('width=480', 'quality=60');
    if (opts.blur) params.push('blur=60');
    const base = `${process.env.CDN_BASE_URL}/${key}`;
    return params.length ? `${process.env.CDN_BASE_URL}/cdn-cgi/image/${params.join(',')}/${key}` : base;
  }
}
