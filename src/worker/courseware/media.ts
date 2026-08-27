import type { OwnedCoursewareCoordinates } from './repository';

const CONTENT_TYPES = new Set(['audio/mpeg', 'image/png', 'image/jpeg', 'image/webp']);

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function exactPrefix(userId: number, studentId: number, coursewareId?: number): string {
  if (![userId, studentId].every(positiveInteger) || (coursewareId !== undefined && !positiveInteger(coursewareId))) {
    throw new Error('invalid media coordinates');
  }
  return coursewareId === undefined
    ? `courseware/${userId}/${studentId}/`
    : `courseware/${userId}/${studentId}/${coursewareId}/`;
}

export function buildCoursewareMediaKey(
  userId: number,
  studentId: number,
  coursewareId: number,
  segmentId: number,
  variant: 'main' | 'alternate' | 'image',
  extension: string,
): string {
  if (!positiveInteger(segmentId)) throw new Error('invalid segment id');
  const prefix = exactPrefix(userId, studentId, coursewareId);
  if (variant === 'main' || variant === 'alternate') {
    if (extension !== 'mp3') throw new Error('invalid audio extension');
    return `${prefix}audio/${segmentId}${variant === 'alternate' ? '-alternate' : ''}.mp3`;
  }
  if (!['png', 'jpg', 'webp'].includes(extension)) throw new Error('invalid image extension');
  return `${prefix}images/${segmentId}.${extension}`;
}

export async function putCoursewareMedia(
  bucket: R2Bucket,
  key: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<void> {
  if (!CONTENT_TYPES.has(contentType)) throw new Error('unsupported courseware media type');
  await bucket.put(key, bytes, { httpMetadata: { contentType } });
}

interface ResolvedRange {
  offset: number;
  length: number;
  end: number;
}

function parseRange(value: string, size: number): ResolvedRange | null {
  if (!value.startsWith('bytes=') || value.includes(',')) return null;
  const expression = value.slice(6);
  const match = /^(\d*)-(\d*)$/.exec(expression);
  if (!match || (!match[1] && !match[2]) || size < 1) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length, end: size - 1 };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null;
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  const end = Math.min(requestedEnd, size - 1);
  return { offset: start, length: end - start + 1, end };
}

function baseHeaders(object: R2Object): Headers {
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    ETag: object.httpEtag,
  });
  const contentType = object.httpMetadata?.contentType;
  if (contentType && CONTENT_TYPES.has(contentType)) headers.set('Content-Type', contentType);
  return headers;
}

export async function getCoursewareMediaResponse(
  bucket: R2Bucket,
  key: string,
  request: Request,
): Promise<Response> {
  const metadata = await bucket.head(key);
  if (!metadata) return new Response('媒体不存在', { status: 404 });
  const headers = baseHeaders(metadata);
  const rangeHeader = request.headers.get('Range');
  const ifRange = request.headers.get('If-Range');
  const useRange = Boolean(rangeHeader) && (!ifRange || ifRange === metadata.httpEtag);

  if (!useRange && request.headers.get('If-None-Match') === metadata.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  if (useRange && rangeHeader) {
    const range = parseRange(rangeHeader, metadata.size);
    if (!range) {
      headers.set('Content-Range', `bytes */${metadata.size}`);
      return new Response(null, { status: 416, headers });
    }
    const object = await bucket.get(key, { range: { offset: range.offset, length: range.length } });
    if (!object) return new Response('媒体不存在', { status: 404 });
    headers.set('Content-Length', String(range.length));
    headers.set('Content-Range', `bytes ${range.offset}-${range.end}/${metadata.size}`);
    return new Response(object.body, { status: 206, headers });
  }

  const object = await bucket.get(key);
  if (!object) return new Response('媒体不存在', { status: 404 });
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function deleteCoursewareMedia(
  bucket: R2Bucket,
  owner: OwnedCoursewareCoordinates,
): Promise<void> {
  await deletePrefix(bucket, exactPrefix(owner.userId, owner.studentId, owner.coursewareId));
}

export async function deleteStudentCoursewareMedia(
  bucket: R2Bucket,
  userId: number,
  studentId: number,
): Promise<void> {
  await deletePrefix(bucket, exactPrefix(userId, studentId));
}
