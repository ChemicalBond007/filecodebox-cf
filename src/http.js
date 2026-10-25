export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function mediaType(request) {
  return (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
}

export function requireMultipart(request) {
  if (mediaType(request) !== 'multipart/form-data') {
    throw new HttpError(415, '请求必须使用 multipart/form-data');
  }
  const match = /(?:^|;)\s*boundary\s*=\s*(?:"([^"]{1,70})"|([^;\s]{1,70}))\s*(?=;|$)/i
    .exec(request.headers.get('Content-Type'));
  const boundary = match && (match[1] || match[2]);
  if (!boundary || !/^[0-9A-Za-z'()+_,\-./:=? ]*[0-9A-Za-z'()+_,\-./:=?]$/.test(boundary)) {
    throw new HttpError(400, '无效的 multipart boundary');
  }
}

export async function formData(request) {
  requireMultipart(request);
  try { return await request.formData(); }
  catch { throw new HttpError(400, '无效的表单请求'); }
}

// 先限制实际流字节，再解码/解析；不能只信任 Content-Length。
async function boundedBody(request, maximum) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && !/^\d+$/.test(declared)) throw new HttpError(400, '无效的 Content-Length');
  if (declared !== null && Number(declared) > maximum) {
    await request.body?.cancel().catch(() => {});
    throw new HttpError(413, '请求体过大');
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let bytes = new Uint8Array(Math.min(maximum, Math.max(1024, Number(declared) || 0)));
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (length + value.byteLength > maximum) throw new HttpError(413, '请求体过大');
      if (length + value.byteLength > bytes.length) {
        const grown = new Uint8Array(Math.min(maximum, Math.max(length + value.byteLength, bytes.length * 2)));
        grown.set(bytes.subarray(0, length));
        bytes = grown;
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    return bytes.subarray(0, length);
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, '无法读取请求体');
  } finally {
    reader.releaseLock();
  }
}

export async function fields(request, maximum, allowEmpty = false) {
  const type = mediaType(request);
  if (allowEmpty && !type) {
    const bytes = await boundedBody(request, maximum);
    if (!bytes.length) return {};
    throw new HttpError(415, '不支持的 Content-Type');
  }
  if (!['application/json', 'multipart/form-data', 'application/x-www-form-urlencoded'].includes(type)) {
    throw new HttpError(415, '不支持的 Content-Type');
  }
  if (type === 'multipart/form-data') requireMultipart(request);
  const bytes = await boundedBody(request, maximum);
  if (allowEmpty && !bytes.length) return {};
  try {
    if (type === 'application/json') {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
      return value;
    }
    const form = await new Request(request.url, {
      method: 'POST', headers: { 'Content-Type': request.headers.get('Content-Type') }, body: bytes,
    }).formData();
    return Object.fromEntries(form);
  } catch {
    throw new HttpError(400, '请求体格式无效');
  }
}
