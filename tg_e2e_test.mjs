// Telegram 存储模式端到端测试（配合 preview_local.mjs FCB_TG_MODE=1 的 Telegram mock）
// 覆盖：20MiB 分片/边界、旧 16MiB 分片兼容、Range / HEAD、超限拒绝及取件鉴权。
const BASE = process.env.BASE || 'http://127.0.0.1:8088';
const CHUNK = 20 * 1024 * 1024; // 官方 getFile 上限，也是当前新上传分片大小

// 确定性伪随机字节（便于比对，跨分片边界也连续）
function randBytes(n, seed = 0) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7 + seed) % 256;
  return b;
}

async function uploadAndShare(payload, fileName, fileType) {
  const fd = new FormData();
  fd.append('file', new Blob([payload], { type: fileType }), fileName);
  const up = await fetch(`${BASE}/api/imgbed/upload`, { method: 'POST', body: fd });
  const upJson = await up.json();
  if (!up.ok || !upJson.id) throw new Error('上传失败：' + JSON.stringify(upJson));
  const sf = new FormData();
  sf.append('type', 'file');
  sf.append('file_key', upJson.id);
  sf.append('upload_token', upJson.upload_token);
  sf.append('file_name', fileName);
  sf.append('file_type', fileType);
  sf.append('file_size', String(payload.length));
  const create = await fetch(`${BASE}/api/share`, { method: 'POST', body: sf });
  const createJson = await create.json();
  if (!create.ok || !createJson.code) throw new Error('创建分享失败：' + JSON.stringify(createJson));
  const claim = await (await fetch(`${BASE}/api/share/${createJson.code}/claim`, { method: 'POST' })).json();
  if (!claim.ok && !claim.url) throw new Error('取件失败：' + JSON.stringify(claim));
  return { upJson, claimUrl: claim.url };
}

// 模拟前端客户端分块上传：init → 逐片 /api/chunk/upload → /api/chunk/merge → 分享 → 取件
async function clientChunkUpload(payload, fileName, fileType, legacyChunkSize) {
  const init = await (await fetch(`${BASE}/api/chunk/init`, { method: 'POST' })).json();
  assert(init.chunkSize === CHUNK, 'init 应返回 20MiB 分片大小');
  const chunkSize = legacyChunkSize || init.chunkSize;
  const total = Math.max(1, Math.ceil(payload.length / chunkSize));
  const chunks = [];
  for (let i = 0; i < total; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, payload.length);
    const blob = new Blob([payload.subarray(start, end)], { type: fileType });
    const chunkFileName = `${fileName}.part${String(i).padStart(3, '0')}`;
    const fd = new FormData();
    fd.append('file', blob, chunkFileName);
    fd.append('index', String(i));
    fd.append('fileName', chunkFileName);
    const r = await (await fetch(`${BASE}/api/chunk/upload`, { method: 'POST', body: fd })).json();
    if (!r.success || !r.chunkToken) throw new Error('分片上传失败：' + JSON.stringify(r));
    chunks.push({
      index: i,
      fileId: r.fileId,
      size: r.size,
      fileName: r.fileName,
      chunkToken: r.chunkToken,
    });
  }
  const merge = await (await fetch(`${BASE}/api/chunk/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName, fileType, totalChunks: total, chunks }),
  })).json();
  if (!merge.id || !merge.id.startsWith('c:')) throw new Error('merge 未返回 c: file_key：' + JSON.stringify(merge));
  const sf = new FormData();
  sf.append('type', 'file');
  sf.append('file_key', merge.id);
  sf.append('upload_token', merge.upload_token);
  sf.append('file_name', fileName);
  sf.append('file_type', fileType);
  sf.append('file_size', String(payload.length));
  const create = await fetch(`${BASE}/api/share`, { method: 'POST', body: sf });
  const createJson = await create.json();
  const claim = await (await fetch(`${BASE}/api/share/${createJson.code}/claim`, { method: 'POST' })).json();
  return { claimUrl: claim.url, mergeId: merge.id };
}

function assert(cond, msg) { if (!cond) throw new Error('断言失败：' + msg); }

async function main() {
  // ---------- 1) 小文件（<=20MiB，单发，file_key=纯 file_id）----------
  {
    const fileName = '小文件.bin';
    const payload = randBytes(2048);
    const { upJson, claimUrl } = await uploadAndShare(payload, fileName, 'application/octet-stream');
    assert(!upJson.id.startsWith('c:'), '小文件不应分片（file_key 不应以 c: 开头）');
    const dl = await fetch(`${BASE}${claimUrl}`);
    assert(dl.status === 200, '小文件下载 200');
    assert(dl.headers.get('content-type') === 'application/octet-stream', '文件响应 Content-Type 固定为 octet-stream');
    assert((dl.headers.get('content-disposition') || '').startsWith('attachment'), '文件响应强制 attachment');
    assert(dl.headers.get('x-content-type-options') === 'nosniff', '文件响应带 nosniff');
    const got = new Uint8Array(await dl.arrayBuffer());
    assert(got.length === payload.length, `小文件字节数 ${got.length} != ${payload.length}`);
    for (let i = 0; i < payload.length; i++) assert(got[i] === payload[i], '小文件字节不一致 @' + i);
    console.log('[1] 小文件单发：上传/取件/下载字节一致（2048）✅');
  }

  // ---------- 2) 大文件（>20MiB，自动分片）----------
  let chunkedId;
  let chunkedClaimUrl;
  {
    const fileName = '大文件.bin';
    const payload = randBytes(CHUNK + 1024 * 1024, 11); // 21MiB → 2 片
    const { upJson, claimUrl } = await uploadAndShare(payload, fileName, 'application/octet-stream');
    assert(upJson.id.startsWith('c:'), '大文件应分片（file_key 以 c: 开头）');
    const chunks = JSON.parse(Buffer.from(upJson.id.slice(2), 'base64url').toString());
    assert(chunks.length === 2 && chunks[0].size === CHUNK && chunks[1].size === 1024 * 1024,
      '服务端自动分片大小应为 20MiB + 1MiB');
    chunkedId = upJson.id;
    chunkedClaimUrl = claimUrl;
    const dl = await fetch(`${BASE}${claimUrl}`);
    assert(dl.status === 200, '大文件下载 200，实际 ' + dl.status);
    const len = parseInt(dl.headers.get('Content-Length') || '0', 10);
    assert(len === payload.length, `Content-Length ${len} != ${payload.length}`);
    const got = new Uint8Array(await dl.arrayBuffer());
    assert(got.length === payload.length, `大文件字节数 ${got.length} != ${payload.length}`);
    for (let i = 0; i < payload.length; i++) assert(got[i] === payload[i], '大文件字节不一致 @' + i);
    console.log(`[2] 大文件分片（21MiB→2片）：上传/取件/下载全量字节一致（${payload.length}）✅`);
  }

  // ---------- 3) Range 取件（跨分片边界）----------
  {
    // 造一个 3 片的大文件（41MiB），验证 Range 跨片
    const fileName = 'range.bin';
    const payload = randBytes(CHUNK * 2 + 1024 * 1024, 22); // 41MiB → 3 片
    const { upJson, claimUrl } = await uploadAndShare(payload, fileName, 'application/octet-stream');
    assert(upJson.id.startsWith('c:'), 'range 场景应分片');
    // 头部 16 字节
    let r = await fetch(`${BASE}${claimUrl}`, { headers: { Range: 'bytes=0-15' } });
    assert(r.status === 206, 'Range 头部应 206，实际 ' + r.status);
    let buf = new Uint8Array(await r.arrayBuffer());
    assert(buf.length === 16, 'Range 头部长度 16，实际 ' + buf.length);
    for (let i = 0; i < 16; i++) assert(buf[i] === payload[i], 'Range 头部不一致 @' + i);
    // 跨 20MiB 边界，分别取第 1 片末尾 8 字节和第 2 片开头 8 字节。
    const start = CHUNK - 8;
    r = await fetch(`${BASE}${claimUrl}`, { headers: { Range: `bytes=${start}-${start + 15}` } });
    assert(r.status === 206, 'Range 跨片应 206，实际 ' + r.status);
    buf = new Uint8Array(await r.arrayBuffer());
    assert(buf.length === 16, 'Range 跨片长度 16，实际 ' + buf.length);
    for (let i = 0; i < 16; i++) assert(buf[i] === payload[start + i], 'Range 跨片不一致 @' + (start + i));
    // 尾部 16 字节
    const end = payload.length - 16;
    r = await fetch(`${BASE}${claimUrl}`, { headers: { Range: `bytes=${end}-${payload.length - 1}` } });
    assert(r.status === 206, 'Range 尾部应 206，实际 ' + r.status);
    buf = new Uint8Array(await r.arrayBuffer());
    assert(buf.length === 16, 'Range 尾部长度 16，实际 ' + buf.length);
    for (let i = 0; i < 16; i++) assert(buf[i] === payload[end + i], 'Range 尾部不一致 @' + (end + i));
    console.log('[3] Range 取件（头部/跨20MiB边界/尾部）206 且字节一致 ✅');
  }

  // ---------- 4) HEAD 不应返回 body，但带 Content-Length ----------
  {
    const r = await fetch(`${BASE}${chunkedClaimUrl}`, { method: 'HEAD' });
    assert(r.status === 200, 'HEAD 200，实际 ' + r.status);
    assert(r.headers.get('Content-Length') === String(CHUNK + 1024 * 1024), 'HEAD Content-Length 正确');
    const body = await r.arrayBuffer();
    assert(body.byteLength === 0, 'HEAD 不应有 body');
    console.log('[4] HEAD 返回正确 Content-Length 且无 body ✅');
  }

  // ---------- 5) 无 token 取件被拒 ----------
  {
    const r = await fetch(`${BASE}/file/${chunkedId}`);
    assert(r.status === 403, '缺 token 应 403，实际 ' + r.status);
    console.log('[5] 无 token 取件被拒(403) ✅');
  }

  // ---------- 6) config 显示 Telegram ----------
  {
    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    assert(cfg.storage === 'Telegram (Bot API)', 'storage 标签错误：' + cfg.storage);
    console.log('[6] /api/config 显示：' + cfg.storage + ' ✅');
  }

  // ---------- 7) 客户端分块上传流程（init→chunk→merge）----------
  {
    const fileName = '客户端分块.bin';
    const payload = randBytes(CHUNK * 2 + 512 * 1024, 33); // 40.5MiB → 3 片
    const { claimUrl, mergeId } = await clientChunkUpload(payload, fileName, 'application/octet-stream');
    assert(mergeId.startsWith('c:'), 'merge 应返回 c: file_key');
    const dl = await fetch(`${BASE}${claimUrl}`);
    assert(dl.status === 200, '客户端分块下载 200，实际 ' + dl.status);
    const got = new Uint8Array(await dl.arrayBuffer());
    assert(got.length === payload.length, `客户端分块字节数 ${got.length} != ${payload.length}`);
    for (let i = 0; i < payload.length; i++) assert(got[i] === payload[i], '客户端分块字节不一致 @' + i);
    console.log(`[7] 客户端分块上传流程（init/chunk/upload/merge，${payload.length}字节）全量一致 ✅`);
  }

  // ---------- 8) getFile 下载硬边界：20MiB-1、20MiB、20MiB+1 ----------
  {
    for (const size of [CHUNK - 1, CHUNK, CHUNK + 1]) {
      const payload = randBytes(size, 44);
      const { upJson, claimUrl } = await uploadAndShare(payload, `boundary-${size}.bin`, 'application/octet-stream');
      assert(upJson.id.startsWith('c:') === (size > CHUNK), '只在超过 20MiB 时自动分片');
      const dl = await fetch(`${BASE}${claimUrl}`);
      assert(dl.status === 200, '边界文件可下载：' + size);
      const got = new Uint8Array(await dl.arrayBuffer());
      assert(Buffer.from(got).equals(Buffer.from(payload)), '边界文件完整字节一致：' + size);
    }
    console.log('[8] 20MiB-1 / 20MiB / 20MiB+1 上传和完整下载通过 ✅');
  }

  // ---------- 9) 旧布局的 16MiB 分片仍按实际大小读取，无需迁移 ----------
  {
    const legacySize = 16 * 1024 * 1024;
    const payload = randBytes(legacySize + 1024 * 1024, 55);
    const { claimUrl, mergeId } = await clientChunkUpload(payload, '旧分片.bin', 'application/octet-stream', legacySize);
    const chunks = JSON.parse(Buffer.from(mergeId.slice(2), 'base64url').toString());
    assert(chunks.length === 2 && chunks[0].size === legacySize, '保留旧 16MiB 分片布局');
    const dl = await fetch(`${BASE}${claimUrl}`);
    assert(dl.status === 200, '旧分片下载 200');
    assert(Buffer.from(await dl.arrayBuffer()).equals(Buffer.from(payload)), '旧分片完整字节一致');
    const start = legacySize - 8;
    const range = await fetch(`${BASE}${claimUrl}`, { headers: { Range: `bytes=${start}-${start + 15}` } });
    assert(range.status === 206, '旧分片跨界 Range 206');
    assert(Buffer.from(await range.arrayBuffer()).equals(Buffer.from(payload.subarray(start, start + 16))),
      '旧 16MiB 分片跨界字节一致');
    const head = await fetch(`${BASE}${claimUrl}`, { method: 'HEAD' });
    assert(head.headers.get('Content-Length') === String(payload.length), '旧分片 HEAD 长度正确');
    console.log('[9] 旧 16MiB 分片完整下载、跨界 Range 和 HEAD 兼容 ✅');
  }

  // ---------- 10) 客户端不能提交超过下载上限的单片 ----------
  {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(CHUNK + 1)]), 'oversized.bin');
    form.set('index', '0');
    const oversized = await fetch(`${BASE}/api/chunk/upload`, { method: 'POST', body: form });
    assert(oversized.status === 413, '超过 20MiB 的分片应返回 413');
    assert((await oversized.json()).error.includes('20MiB'), '超限错误说明实际分片大小上限');
    console.log('[10] 20MiB+1 单片被拒绝（413），避免上传成功却无法下载 ✅');
  }

  console.log('\n✅ Telegram 存储端到端测试全部通过（含 20MiB 边界、旧分片兼容、Range）');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\n❌ 测试失败：', e.message);
  process.exit(1);
});
