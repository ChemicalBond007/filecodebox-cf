import {
  verifyFileToken,
  isValidFileKey,
  uploadToken,
  chunkToken,
  verifyChunkToken,
} from './auth.js';

// FileCodeBox-CF · Telegram 存储后端（移植自 CloudFlare-ImgBed 的 telegramAPI.js）
//
// 把文件直接存到 Telegram（通过 Bot API），从而无需额外部署 / 对接一个 ImgBed 实例。
// 凭据（在 Cloudflare 控制台配置为 Variables / Secrets）：
//   TG_BOT_TOKEN : BotFather 申请的 Bot Token（形如 123456:ABC-DEF...）
//   TG_CHAT_ID   : 文件要发往的频道 / 群组 ID（机器人需为该会话管理员；私聊可用自己的 id）
//   TG_API       : 可选，自定义反代域名（用于 api.telegram.org 被墙的环境），留空则用官方 API
//
// 大小限制（按 Telegram getFile 下载上限切片）：
//   · 本项目单文件上传：20MiB，确保可整文件经 getFile 取回（sendDocument 本身可上传 50MB）
//   · 分片上传：每片 ≤ CHUNK_SIZE(20MiB)，最多 MAX_CHUNKS 片，受会话超时与上传速度约束
//   · 单文件下载：20MiB（getFile 限制）
//   · 分片下载：无限制（逐片 getFile 拼接，支持 Range / HEAD）
// 因此超过 CHUNK_SIZE 的文件分片——每片单独 sendDocument，取件时按序流式重组。
// 分片元信息编码进 file_key（base64url 的 JSON 数组），无需额外存储。
//
// 安全说明：取件时本 Worker 在服务端用 bot token 调 getFile 取回字节并流式返回给浏览器，
// bot token 始终留在服务端，不会下发给客户端（与 ImgBed 的 302 不同，这里不暴露 token）。

// 官方 Bot API 的 MAX_DOWNLOAD_FILE_SIZE = 20 << 20，恰好 20MiB，不再预留 4MiB。
export const CHUNK_SIZE = 20 * 1024 * 1024;
// 分片数防护上限：避免 merge 接受超大数组造成 Worker CPU/内存或 Telegram API 滥用。
// 仍可能先受到 file_key 长度、请求大小等限制。
export const MAX_CHUNKS = 1000;

// base64url 编解码（纯 ASCII 的 chunks JSON，跨 Cloudflare Workers / Node 均可用）
function toB64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64Url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class TelegramAPI {
  constructor(botToken, proxyUrl = '') {
    this.botToken = botToken;
    const domain = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
    this.baseURL = `${domain}/bot${botToken}`;
    this.fileDomain = domain;
    this.defaultHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
    };
  }

  // 发送文件到 Telegram（统一用 sendDocument）。本项目以 20MiB（getFile 可取回）为每片上限；
  // 超过 CHUNK_SIZE 的由调用方分片上传，每片单独 sendDocument。
  async sendFile(file, chatId, functionName, functionType, caption = '', fileName = '') {
    const formData = new FormData();
    formData.append('chat_id', chatId);
    if (fileName) formData.append(functionType, file, fileName);
    else formData.append(functionType, file);
    if (caption) formData.append('caption', caption);

    const response = await fetch(`${this.baseURL}/${functionName}`, {
      method: 'POST',
      headers: this.defaultHeaders,
      body: formData,
    });
    if (!response.ok) {
      throw new Error(`Telegram API error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  // 从 Bot API 响应里提取 file_id / file_name / file_size
  getFileInfo(responseData) {
    const getDetails = (file) => ({
      file_id: file.file_id,
      file_name: file.file_name || file.file_unique_id,
      file_size: file.file_size,
    });
    try {
      if (!responseData.ok) return null;
      if (responseData.result.photo) {
        const largest = responseData.result.photo.reduce((p, c) =>
          p.file_size > c.file_size ? p : c
        );
        return getDetails(largest);
      }
      if (responseData.result.video) return getDetails(responseData.result.video);
      if (responseData.result.audio) return getDetails(responseData.result.audio);
      if (responseData.result.document) return getDetails(responseData.result.document);
      return null;
    } catch (e) {
      return null;
    }
  }

  async getFilePath(fileId) {
    try {
      const url = `${this.baseURL}/getFile?file_id=${encodeURIComponent(fileId)}`;
      const response = await fetch(url, { method: 'GET', headers: this.defaultHeaders });
      const data = await response.json();
      return data.ok ? data.result.file_path : null;
    } catch (e) {
      return null;
    }
  }

  // 取回文件内容（服务端 fetch，token 不出服务端）
  async getFileContent(fileId) {
    const filePath = await this.getFilePath(fileId);
    if (!filePath) throw new Error(`File path not found for fileId: ${fileId}`);
    const fullURL = `${this.fileDomain}/file/bot${this.botToken}/${filePath}`;
    return fetch(fullURL, {
      headers: { ...this.defaultHeaders, 'Accept-Encoding': 'identity' },
    });
  }
}

// 上传：把请求里的文件发给 Telegram。
// 小文件（<=20MiB）单发，file_key = 纯 file_id（与原格式兼容）；
// 大文件分片，file_key = "c:" + base64url(JSON 分片数组)，取件时据此重组。
export async function uploadToTelegram(env, request) {
  if (!env.TG_BOT_TOKEN) throw new Error('未配置 TG_BOT_TOKEN（Telegram Bot Token）');
  if (!env.TG_CHAT_ID) throw new Error('未配置 TG_CHAT_ID（文件要发往的频道/群组 ID）');
  const form = await request.formData();
  const file = form.get('file');
  if (!file) throw new Error('未找到上传文件');

  const tg = new TelegramAPI(env.TG_BOT_TOKEN, env.TG_API || '');
  const fileSize = file.size ?? (file.byteLength || 0);
  const fileName = file.name || 'file';

  // 小文件：直接 sendDocument，file_key 用纯 file_id（向后兼容）
  if (fileSize <= CHUNK_SIZE) {
    const resp = await tg.sendFile(file, env.TG_CHAT_ID, 'sendDocument', 'document', '', fileName);
    const info = tg.getFileInfo(resp);
    if (!info || !info.file_id || !isValidFileKey(info.file_id)) {
      throw new Error('Telegram 未返回合法 file_id: ' + JSON.stringify(resp).slice(0, 200));
    }
    return {
      id: info.file_id,
      src: `tg://${info.file_id}`,
      upload_token: await uploadToken(env, info.file_id),
    };
  }

  // 大文件：按 20MiB 分片，每片单独 sendDocument。
  // 注：服务端自动分片是在「单次 Worker 请求」内连续调 sendDocument，受 Worker CPU 时间约束；
  // 真正的大文件请走前端客户端分块上传（init→chunk→merge，逐片独立请求）。
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  if (totalChunks > MAX_CHUNKS) throw new Error(`分片数量超过上限（${MAX_CHUNKS}）`);
  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, fileSize);
    const blob = file.slice(start, end); // Blob.slice 零拷贝、惰性，不占内存
    const chunkFileName = `${fileName}.part${String(i).padStart(3, '0')}`;
    const resp = await tg.sendFile(
      blob,
      env.TG_CHAT_ID,
      'sendDocument',
      'document',
      `Part ${i + 1}/${totalChunks}`,
      chunkFileName
    );
    const info = tg.getFileInfo(resp);
    if (!info || !info.file_id || !isValidFileKey(info.file_id)) {
      throw new Error(`分片 ${i + 1}/${totalChunks} 上传失败: ` + JSON.stringify(resp).slice(0, 200));
    }
    chunks.push({
      index: i,
      fileId: info.file_id,
      size: Number(info.file_size ?? end - start),
      fileName: chunkFileName,
    });
  }
  if (chunks.length !== totalChunks) {
    throw new Error(`分片数量不一致：期望 ${totalChunks}，实际 ${chunks.length}`);
  }
  const id = 'c:' + toB64Url(JSON.stringify(chunks));
  return {
    id,
    src: `tg://chunked:${chunks.length}`,
    upload_token: await uploadToken(env, id),
  };
}

// 单分片上传（供前端客户端分块上传的 /api/chunk/upload 调用）：把一片 Blob 单独 sendDocument 到 Telegram。
// 返回 { fileId, size, fileName, chunkToken }，前端收集各片后交给 merge 校验并组装 file_key。
export async function uploadChunk(env, blob, fileName, index) {
  if (!env.TG_BOT_TOKEN) throw new Error('未配置 TG_BOT_TOKEN（Telegram Bot Token）');
  if (!env.TG_CHAT_ID) throw new Error('未配置 TG_CHAT_ID（文件要发往的频道/群组 ID）');
  if (blob.size > CHUNK_SIZE) throw new RangeError('分片不能超过 20MiB（20971520 字节）');
  const tg = new TelegramAPI(env.TG_BOT_TOKEN, env.TG_API || '');
  const resp = await tg.sendFile(blob, env.TG_CHAT_ID, 'sendDocument', 'document', '', fileName);
  const info = tg.getFileInfo(resp);
  if (!info || !info.file_id || !isValidFileKey(info.file_id)) {
    throw new Error('分片上传失败: ' + JSON.stringify(resp).slice(0, 200));
  }
  const size = Number(info.file_size ?? blob.size ?? 0);
  if (!Number.isFinite(size) || size < 0) throw new Error('分片大小无效');
  return {
    fileId: info.file_id,
    size,
    fileName,
    chunkToken: await chunkToken(env, info.file_id, size, index),
  };
}

// 把各分片元信息组装成分片 file_key（c: + base64url(JSON)），与取件端 serveFromTelegram 约定一致。
// 只保留必要字段，chunkToken 不进入 file_key。
export function assembleChunkedKey(chunks) {
  if (!Array.isArray(chunks) || !chunks.length) throw new Error('分片为空');
  if (chunks.length > MAX_CHUNKS) throw new Error(`分片数量超过上限（${MAX_CHUNKS}）`);
  const sorted = [...chunks].sort((a, b) => a.index - b.index);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].index !== i) throw new Error('分片序号不连续');
  }
  const normalized = sorted.map((c) => {
    const size = Number(c.size);
    if (!Number.isFinite(size) || size < 0) throw new Error('分片大小非法');
    return {
      index: c.index,
      fileId: c.fileId,
      size,
      fileName: String(c.fileName || '').slice(0, 255),
    };
  });
  return 'c:' + toB64Url(JSON.stringify(normalized));
}

// merge 时校验每个分片的上传凭证，避免客户端直接引用任意 Telegram file_id。
export async function verifyAndAssembleChunkedKey(env, chunks) {
  if (!Array.isArray(chunks) || !chunks.length) throw new Error('分片列表为空');
  if (chunks.length > MAX_CHUNKS) throw new Error(`分片数量超过上限（${MAX_CHUNKS}）`);
  const seen = new Set();
  for (const c of chunks) {
    if (!Number.isInteger(c.index) || c.index < 0) throw new Error('分片序号无效');
    if (seen.has(c.index)) throw new Error('分片序号重复');
    seen.add(c.index);
    if (typeof c.fileId !== 'string' || !isValidFileKey(c.fileId)) throw new Error('分片 file_id 非法');
    if (!Number.isFinite(c.size) || c.size < 0) throw new Error('分片大小非法');
    const ok = await verifyChunkToken(env, c.fileId, c.size, c.index, c.chunkToken);
    if (!ok) throw new Error(`分片 ${c.index} 凭证无效`);
  }
  const id = assembleChunkedKey(chunks);
  return { id, upload_token: await uploadToken(env, id) };
}

// 取件文件名（RFC 5987：中文等非 ASCII 用 filename* 编码，浏览器优先取之）。
// 强制 attachment，避免用户上传的 HTML/SVG 在本站同源被浏览器渲染执行。
function dispositionValue(name) {
  const safeName = String(name || 'file');
  const asciiName = safeName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(safeName);
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`;
}

function baseDownloadHeaders(disposition) {
  const headers = new Headers();
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Disposition', disposition);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, no-store');
  return headers;
}

// 不支持多段请求；无效语法忽略 Range。BigInt 避免超长十进制范围溢出。
function byteRange(request, size) {
  if (request.method !== 'GET' || request.headers.has('If-Range')) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(request.headers.get('Range') || '');
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? BigInt(match[1]) : null;
  const end = match[2] ? BigInt(match[2]) : null;
  const total = BigInt(size);
  if (start !== null && end !== null && start > end) return null;
  if (!size || (start === null ? end === 0n : start >= total)) {
    return { unsatisfiable: true };
  }
  return {
    start: start === null ? Number(end < total ? total - end : 0n) : Number(start),
    end: start === null || end === null || end >= total ? size - 1 : Number(end),
  };
}

function unsatisfiedRange(size, disposition) {
  const headers = baseDownloadHeaders(disposition);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes */${size}`);
  return new Response(null, { status: 416, headers });
}

// 按需跳过前缀、输出范围并取消剩余上游数据；客户端取消时也释放上游连接。
function sliceStream(body, start, end) {
  const reader = body.getReader();
  let position = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          const offset = position;
          position += value.byteLength;
          if (position <= start) continue;
          controller.enqueue(value.subarray(Math.max(0, start - offset),
            Math.min(value.byteLength, end + 1 - offset)));
          if (position > end) {
            controller.close();
            await reader.cancel();
          }
          return;
        }
      } catch (error) {
        controller.error(error);
        await reader.cancel(error).catch(() => {});
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
}

// Workers 只会为已知长度的流生成 Content-Length；Node 测试使用标准流。
function fixedLengthBody(body, length) {
  return typeof FixedLengthStream === 'function'
    ? body.pipeThrough(new FixedLengthStream(length))
    : body;
}

// 取件：先校验短时 token，再在服务端用 bot token 取回文件内容并流式返回。
// 单文件流式截取、分片文件按序串联，各自支持 Range / HEAD。
// 响应统一 attachment + application/octet-stream，避免 Content-Type 由用户控制。
export async function serveFromTelegram(env, request, key, code, meta) {
  if (!isValidFileKey(key)) return new Response('无效的文件标识', { status: 400 });
  const token = new URL(request.url).searchParams.get('t');
  if (!token || !(await verifyFileToken(env, key, code, token))) {
    return new Response('无效或缺失的访问凭证', { status: 403 });
  }
  const tg = new TelegramAPI(env.TG_BOT_TOKEN, env.TG_API || '');

  const isChunked = key.startsWith('c:');
  let chunks = null;
  if (isChunked) {
    try {
      chunks = JSON.parse(fromB64Url(key.slice(2)));
    } catch (e) {
      return new Response('分片信息损坏', { status: 502 });
    }
    if (!Array.isArray(chunks) || !chunks.length || chunks.length > MAX_CHUNKS) {
      return new Response('分片信息无效', { status: 502 });
    }
    chunks.sort((a, b) => a.index - b.index);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (
        !c ||
        c.index !== i ||
        typeof c.fileId !== 'string' ||
        !isValidFileKey(c.fileId) ||
        !Number.isFinite(c.size) ||
        c.size < 0
      ) {
        return new Response('分片信息损坏', { status: 502 });
      }
    }
  }

  // 不信任客户端提交的 file_type：统一以二进制附件返回，避免 HTML/SVG 同源执行。
  const disposition = dispositionValue(meta && meta.file_name);

  // ---- 单文件：从上游真实长度解析 Range，不信任客户端的 file_size ----
  if (!isChunked) {
    let resp;
    try {
      resp = await tg.getFileContent(key);
    } catch (e) {
      console.error('[telegram download]', e);
      return new Response('Telegram 取文件失败', { status: 502 });
    }
    if (!resp.ok) {
      await resp.body?.cancel();
      return new Response('Telegram 取文件失败', { status: 502 });
    }
    const headers = baseDownloadHeaders(disposition);
    const len = resp.headers.get('Content-Length');
    const size = len !== null && /^\d+$/.test(len) ? Number(len) : NaN;
    const knownSize = Number.isSafeInteger(size) && size >= 0;
    if (knownSize) {
      headers.set('Content-Length', String(size));
      headers.set('Accept-Ranges', 'bytes');
    }
    const range = knownSize ? byteRange(request, size) : null;
    if (range?.unsatisfiable) {
      await resp.body?.cancel();
      return unsatisfiedRange(size, disposition);
    }
    if (request.method === 'HEAD') {
      await resp.body?.cancel();
      return new Response(null, { status: 200, headers });
    }
    if (range && resp.body) {
      const length = range.end - range.start + 1;
      headers.set('Content-Length', String(length));
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      return new Response(fixedLengthBody(sliceStream(resp.body, range.start, range.end), length),
        { status: 206, headers });
    }
    const body = knownSize && resp.body ? fixedLengthBody(resp.body, size) : resp.body;
    return new Response(body, { status: 200, headers });
  }

  // ---- 分片文件：流式串联 + Range / HEAD ----
  const totalSize = chunks.reduce((t, c) => t + (c.size || 0), 0);
  if (!Number.isSafeInteger(totalSize) || chunks.some(c => !Number.isSafeInteger(c.size))) {
    return new Response('分片信息损坏', { status: 502 });
  }
  const range = byteRange(request, totalSize);
  if (range?.unsatisfiable) return unsatisfiedRange(totalSize, disposition);
  const isRange = range !== null;
  const rangeStart = range?.start ?? 0;
  const rangeEnd = range?.end ?? totalSize - 1;

  if (request.method === 'HEAD') {
    const h = baseDownloadHeaders(disposition);
    h.set('Accept-Ranges', 'bytes');
    h.set('Content-Length', String(totalSize));
    return new Response(null, { status: 200, headers: h });
  }

  const headers = baseDownloadHeaders(disposition);
  headers.set('Accept-Ranges', 'bytes');

  // 流式重组：只下载与 Range 相交的分片，避免整文件读入内存
  const stream = new ReadableStream({
    async start(controller) {
      try {
        let pos = 0;
        for (const c of chunks) {
          const cs = c.size || 0;
          if (isRange) {
            if (pos + cs <= rangeStart) {
              pos += cs;
              continue;
            }
            if (pos > rangeEnd) break;
          }
          let resp;
          try {
            resp = await tg.getFileContent(c.fileId);
          } catch (e) {
            controller.error(new Error(`分片 ${c.index} 取回失败: ${e.message}`));
            return;
          }
          if (!resp.ok) {
            controller.error(new Error(`分片 ${c.index} 取回失败 (HTTP ${resp.status})`));
            return;
          }
          const data = new Uint8Array(await resp.arrayBuffer());
          if (isRange) {
            const s = Math.max(0, rangeStart - pos);
            const e = Math.min(data.length, rangeEnd - pos + 1);
            controller.enqueue(data.subarray(s, e));
          } else {
            controller.enqueue(data);
          }
          pos += cs;
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  if (isRange) {
    headers.set('Content-Length', String(rangeEnd - rangeStart + 1));
    headers.set('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${totalSize}`);
    return new Response(fixedLengthBody(stream, rangeEnd - rangeStart + 1), { status: 206, headers });
  }
  headers.set('Content-Length', String(totalSize));
  return new Response(fixedLengthBody(stream, totalSize), { status: 200, headers });
}
