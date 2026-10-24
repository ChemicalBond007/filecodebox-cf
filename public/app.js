// FileCodeBox-CF 前端逻辑（零依赖原生 JS）
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  let state = {
    type: 'text',
    file: null,
    sending: false,
  };
  // 清除旧版本长期令牌。管理员凭证只保存在 HttpOnly Cookie 中。
  try { localStorage.removeItem('fcb_admin_token'); } catch { /* 存储被禁用 */ }

  // ---------- 工具 ----------
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 1800);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = (data && data.error) || `请求失败 (${res.status})`;
      throw new Error(err);
    }
    return data;
  }

  function fmtSize(b) {
    if (b == null) return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  }

  function fmtExpire(ts) {
    if (!ts) return '永久有效';
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function normalizeCode(s) {
    return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function formatCode(code, group = 4) {
    const s = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!group || group <= 0) return s;
    const parts = [];
    for (let i = 0; i < s.length; i += group) parts.push(s.slice(i, i + group));
    return parts.join('-');
  }

  // ---------- 配置加载 ----------
  async function loadConfig() {
    try {
      const cfg = await api('/api/config');
      if (cfg.name) $('#appName').textContent = cfg.name;
      if (cfg.subtitle) $('#appSubtitle').textContent = cfg.subtitle;
      state.storage = cfg.storage || ''; // 'Telegram (Bot API)' 或 'CloudFlare-ImgBed (API)'
    } catch (e) { /* 忽略 */ }
  }

  // ---------- Tabs / 分段 ----------
  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => switchView(t.dataset.view))
  );
  $$('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      if (state.sending) return;
      state.type = b.dataset.type;
      resetUploadProgress();
      $$('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      $('#pane-text').classList.toggle('hidden', state.type !== 'text');
      $('#pane-file').classList.toggle('hidden', state.type !== 'file');
    })
  );

  function switchView(v) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
    $('#view-send').classList.toggle('hidden', v !== 'send');
    $('#view-receive').classList.toggle('hidden', v !== 'receive');
  }

  // ---------- 文件选择 ----------
  const dz = $('#dropzone');
  const fileInput = $('#fileInput');
  dz.addEventListener('click', () => { if (!state.sending) fileInput.click(); });
  fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
  ['dragover', 'dragenter'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); if (!state.sending) dz.classList.add('drag'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); })
  );
  dz.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  });
  $('#fileClear').addEventListener('click', () => setFile(null));

  function setFile(f) {
    if (state.sending) return;
    state.file = f || null;
    resetUploadProgress();
    $('#sendResult').classList.add('hidden');
    if (f) {
      $('#fcName').textContent = f.name;
      $('#fcSize').textContent = fmtSize(f.size);
      $('#fileChip').classList.remove('hidden');
    } else {
      $('#fileChip').classList.add('hidden');
      fileInput.value = '';
    }
  }

  // ---------- 上传进度 ----------
  let uploadProgress = null;
  function resetUploadProgress() {
    uploadProgress = null;
    $('#uploadProgress').classList.add('hidden');
    $('#uploadProgress').dataset.status = '';
    $('#uploadProgressBar').value = 0;
    $('#uploadProgressPercent').textContent = '0%';
    $('#uploadProgressStatus').textContent = '';
    $('#uploadProgressDetail').textContent = '';
  }
  function startUploadProgress(file) {
    uploadProgress = { loaded: 0, total: file.size };
    $('#uploadProgress').classList.remove('hidden');
    $('#uploadProgress').dataset.status = 'uploading';
    updateUploadProgress(0, '准备上传…');
  }
  function updateUploadProgress(loaded, status, complete = false) {
    if (!uploadProgress) return;
    const p = uploadProgress;
    p.loaded = Math.max(p.loaded, Math.min(p.total, Math.max(0, loaded)));
    const percent = complete ? 100 : p.total ? Math.floor(p.loaded / p.total * 100) : 0;
    $('#uploadProgressBar').value = percent;
    $('#uploadProgressPercent').textContent = `${percent}%`;
    if ($('#uploadProgressStatus').textContent !== status) $('#uploadProgressStatus').textContent = status;
    $('#uploadProgressDetail').textContent = `${fmtSize(p.loaded)} / ${fmtSize(p.total)}`;
  }
  function setSending(sending) {
    state.sending = sending;
    $('#sendBtn').disabled = sending;
    $('#sendBtn').textContent = sending ? '处理中…' : '生成取件码';
    ['#fileInput', '#fileClear', '#textInput', '#expireSel', '#dlSel', '#pwdInput']
      .forEach(id => { $(id).disabled = sending; });
    $$('.seg-btn').forEach(b => { b.disabled = sending; });
    dz.setAttribute('aria-disabled', String(sending));
    if (sending) dz.classList.remove('drag');
  }

  // fetch 不提供上传进度事件，仅上传请求使用 XHR；其它 API 仍复用 api()。
  function uploadApi(path, form, onProgress, onSent) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      xhr.responseType = 'json';
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(Math.min(1, Math.max(0, event.loaded / event.total)));
        }
      };
      xhr.upload.onload = onSent;
      xhr.onload = () => {
        const data = xhr.response;
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error((data && data.error) || `上传失败 (${xhr.status})`));
        } else if (!data || typeof data !== 'object') {
          reject(new Error('上传响应无效，请重试'));
        } else {
          resolve(data);
        }
      };
      xhr.onerror = () => reject(new Error('网络异常，文件上传失败，请重试'));
      xhr.onabort = () => reject(new Error('上传已取消'));
      xhr.ontimeout = () => reject(new Error('上传超时，请重试'));
      xhr.send(form);
    });
  }

  // ---------- 寄件 ----------
  $('#sendBtn').addEventListener('click', async () => {
    if (state.sending) return;
    const type = state.type;
    const file = state.file;
    setSending(true);
    resetUploadProgress();
    $('#sendResult').classList.add('hidden');
    try {
      const fd = new FormData();
      fd.set('type', type);
      fd.set('expire_ms', $('#expireSel').value);
      fd.set('download_limit', $('#dlSel').value);
      const pwd = $('#pwdInput').value.trim();
      if (pwd) fd.set('password', pwd);

      if (type === 'text') {
        const text = $('#textInput').value;
        if (!text.trim()) throw new Error('文本内容不能为空');
        fd.set('text', text);
      } else {
        if (!file) throw new Error('请先选择文件');
        startUploadProgress(file);
        // 文件上传：Telegram 模式下大文件（>20MiB）走客户端分块（init→逐片→merge），
        // 绕过 Cloudflare Worker 请求体/CPU 限制；其余走 /api/imgbed/upload（ImgBed 模式或 Telegram 小文件）。
        const up = await uploadFileKey(file);
        if (!up.id || !up.upload_token) throw new Error('存储后端未返回文件凭证');
        fd.set('file_key', up.id);
        fd.set('upload_token', up.upload_token);
        fd.set('file_name', file.name);
        fd.set('file_type', file.type || 'application/octet-stream');
        fd.set('file_size', String(file.size));
        updateUploadProgress(file.size, '文件上传完成，正在生成取件码…');
      }

      const data = await api('/api/share', { method: 'POST', body: fd });
      showSendResult(data);
      if (uploadProgress) {
        updateUploadProgress(file.size, '上传完成，取件码已生成', true);
        $('#uploadProgress').dataset.status = 'complete';
      }
    } catch (e) {
      if (uploadProgress) {
        $('#uploadProgress').dataset.status = 'error';
        $('#uploadProgressStatus').textContent = `未完成：${e.message}`;
      }
      toast(e.message);
    } finally {
      setSending(false);
    }
  });

  // 文件上传：返回 { id, upload_token }（id 即分享用的 file_key，upload_token 证明来源）。
  // Telegram 模式且文件 > 20MiB 时走客户端分块上传（复用 ImgBed 的 init→chunk→merge 协议），
  // 否则直接 /api/imgbed/upload（ImgBed 模式流式代理，或 Telegram 小文件单发）。
  async function uploadFileKey(file) {
    const isTG = state.storage === 'Telegram (Bot API)';
    if (isTG && file.size > 20 * 1024 * 1024) {
      return await uploadChunked(file);
    }
    const upForm = new FormData();
    upForm.set('file', file);
    return await uploadApi('/api/imgbed/upload', upForm,
      fraction => updateUploadProgress(file.size * fraction, '正在上传文件…'),
      () => updateUploadProgress(file.size, '数据已发送，等待存储确认…'));
  }

  // 客户端分块上传：从 init 获取分片大小（当前 20MiB），逐片 POST /api/chunk/upload，
  // 最后 POST /api/chunk/merge 汇总各片元信息，得到分片 file_key。
  async function uploadChunked(file) {
    const { chunkSize } = await api('/api/chunk/init', { method: 'POST' });
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error('无效的上传分片大小');
    const total = Math.max(1, Math.ceil(file.size / chunkSize));
    const chunks = [];
    for (let i = 0; i < total; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const blob = file.slice(start, end);
      const fileName = `${file.name}.part${String(i).padStart(3, '0')}`;
      const fd = new FormData();
      fd.set('file', blob);
      fd.set('index', String(i));
      fd.set('fileName', fileName);
      const label = `正在上传分片 ${i + 1}/${total}…`;
      updateUploadProgress(start, label);
      const r = await uploadApi('/api/chunk/upload', fd,
        fraction => updateUploadProgress(start + blob.size * fraction, label),
        () => updateUploadProgress(end, `分片 ${i + 1}/${total} 已发送，等待存储确认…`));
      if (!r.success || !r.chunkToken) throw new Error(`分片 ${i + 1}/${total} 上传失败`);
      updateUploadProgress(end, `分片 ${i + 1}/${total} 上传完成`);
      chunks.push({
        index: i,
        fileId: r.fileId,
        size: r.size,
        fileName: r.fileName,
        chunkToken: r.chunkToken,
      });
    }
    updateUploadProgress(file.size, '正在合并分片，请稍候…');
    return await api('/api/chunk/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name,
        fileType: file.type || 'application/octet-stream',
        totalChunks: total,
        chunks,
      }),
    });
  }

  function showSendResult(data) {
    $('#resultCode').textContent = formatCode(data.code);
    const link = `${location.origin}/#r/${data.code}`;
    $('#resultLink').value = link;
    const tips = [];
    tips.push(data.expire_at ? `过期：${fmtExpire(data.expire_at)}` : '永久有效');
    tips.push(data.download_limit > 0 ? `可取 ${data.download_limit} 次` : '取件次数不限');
    if (data.type === 'file') tips.push(state.storage === 'Telegram (Bot API)' ? '文件已存入 Telegram' : '文件已存入 ImgBed');
    $('#resultTip').textContent = tips.join(' · ');
    $('#sendResult').classList.remove('hidden');
  }

  $('#copyCode').addEventListener('click', () => copy($('#resultCode').textContent, '已复制取件码'));
  $('#copyLink').addEventListener('click', () => copy($('#resultLink').value, '已复制链接'));
  function copy(text, ok) {
    navigator.clipboard.writeText(text).then(() => toast(ok)).catch(() => toast('复制失败'));
  }

  // ---------- 取件 ----------
  $('#receiveBtn').addEventListener('click', () => doReceive(false));
  $('#pwdSubmit').addEventListener('click', () => doReceive(true));
  let pendingCode = '';

  async function doReceive(withPwd) {
    const out = $('#receiveOut');
    const raw = $('#codeInput').value;
    const code = normalizeCode(raw);
    if (!code) { toast('请输入取件码'); return; }
    pendingCode = code;
    out.innerHTML = '<div class="spinner">取件中…</div>';
    $('#pwdRow').classList.add('hidden');

    try {
      // 先取元信息
      const meta = await api('/api/share/' + code);
      if (meta.has_password && !withPwd) {
        out.innerHTML = '';
        $('#pwdRow').classList.remove('hidden');
        $('#receivePwd').focus();
        return;
      }
      // 取件（消耗一次）
      const fd = new FormData();
      if (withPwd) fd.set('password', $('#receivePwd').value);
      const claim = await api('/api/share/' + code + '/claim', { method: 'POST', body: fd });

      if (claim.type === 'text') {
        out.innerHTML = `<div class="text-result">${escapeHtml(claim.text)}</div>
          <button class="mini-btn" id="copyText" style="margin-top:12px">复制文本</button>`;
        $('#copyText').addEventListener('click', () => copy(claim.text, '已复制'));
      } else {
        const safeName = escapeHtml(claim.file_name || 'file');
        const safeUrl = escapeHtml(claim.url || '');
        out.innerHTML = `<div class="file-result">
          <div class="fr-icon">📄</div>
          <div class="fr-name">${safeName}</div>
          <div class="fr-size">${fmtSize(claim.file_size)}</div>
          <a class="primary-btn" href="${safeUrl}" download="${safeName}">下载文件</a>
        </div>`;
      }
    } catch (e) {
      out.innerHTML = `<div class="msg err">${escapeHtml(e.message)}</div>`;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // ---------- 管理后台 ----------
  const modal = $('#adminModal');
  let adminBusy = false;
  let backupContinue = null;
  $('#adminBtn').addEventListener('click', openAdmin);
  function closeAdmin() {
    if (adminBusy) return;
    if (backupContinue) { toast('请先安全保存备用码并确认'); return; }
    $('#adminPwd').value = '';
    modal.classList.add('hidden');
  }
  $('#adminClose').addEventListener('click', closeAdmin);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeAdmin(); });

  const adminPost = (path, data = {}) => api('/api/admin/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  function adminPanel(id) {
    ['adminLogin', 'adminRegisterPanel', 'adminBackupPanel', 'adminDash']
      .forEach(p => $('#' + p).classList.toggle('hidden', p !== id));
  }
  async function adminAction(fn) {
    if (adminBusy) return;
    adminBusy = true;
    $$('[data-admin-action]').forEach(b => { b.disabled = true; });
    $('#adminErr').textContent = '';
    try {
      await fn();
    } catch (e) {
      $('#adminErr').textContent = e.name === 'NotAllowedError'
        ? 'Passkey 操作已取消或超时，请重新尝试。' : e.message;
    } finally {
      adminBusy = false;
      $$('[data-admin-action]').forEach(b => { b.disabled = false; });
    }
  }

  async function refreshAdmin() {
    const s = await api('/api/admin/status');
    if (s.authenticated) {
      adminPanel('adminDash');
      await loadAdmin();
    } else if (s.scope === 'bootstrap' || s.scope === 'recovery') {
      adminPanel('adminRegisterPanel');
    } else {
      adminPanel('adminLogin');
      $('#adminHint').textContent = s.initialized
        ? '通过设备指纹、人脸、PIN 或安全密钥验证。原 API 密钥已停用。'
        : '首次使用：输入 ADMIN_API_TOKEN 验证，然后绑定系统 Passkey。';
      $('#passkeyLoginBtn').classList.toggle('hidden', !s.initialized);
      $('#recoveryToggle').classList.toggle('hidden', !s.initialized);
      $('#adminCodePanel').classList.toggle('hidden', s.initialized);
      $('#adminCodeLabel').textContent = s.initialized ? '一次性备用码' : 'API 密钥';
      $('#adminPwd').placeholder = s.initialized ? 'Backup code' : 'ADMIN_API_TOKEN';
      $('#adminLoginBtn').textContent = s.initialized ? '恢复并绑定新 Passkey' : '验证并绑定 Passkey';
    }
  }
  function openAdmin() {
    modal.classList.remove('hidden');
    if (!backupContinue) return adminAction(refreshAdmin);
  }
  $('#recoveryToggle').addEventListener('click', () => {
    $('#adminCodePanel').classList.toggle('hidden');
    $('#adminPwd').focus();
  });
  function showBackup(code, next) {
    $('#backupCode').value = code;
    backupContinue = next;
    adminPanel('adminBackupPanel');
  }
  $('#copyBackup').addEventListener('click', () => copy($('#backupCode').value, '已复制，请安全保存'));
  $('#backupSaved').addEventListener('click', () => adminAction(async () => {
    const next = backupContinue;
    backupContinue = null;
    $('#backupCode').value = '';
    if (next) await next();
  }));
  $('#adminLoginBtn').addEventListener('click', () => adminAction(async () => {
    let data;
    try { data = await adminPost('login', { code: $('#adminPwd').value }); }
    finally { $('#adminPwd').value = ''; }
    if (data.backup_code) showBackup(data.backup_code, async () => adminPanel('adminRegisterPanel'));
    else adminPanel('adminRegisterPanel');
  }));

  // 原生 WebAuthn，二进制字段与服务器 JSON 的 base64url 互转，无外部脚本。
  function decodeWebAuthn(value) {
    const s = value.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(s + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
  }
  function encodeWebAuthn(value) {
    return btoa(String.fromCharCode(...new Uint8Array(value)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function webAuthnResponse(credential) {
    const r = credential.response;
    const response = { clientDataJSON: encodeWebAuthn(r.clientDataJSON) };
    for (const key of ['attestationObject', 'authenticatorData', 'signature', 'userHandle']) {
      if (r[key]) response[key] = encodeWebAuthn(r[key]);
    }
    if (r.getTransports) response.transports = r.getTransports();
    return { id: credential.id, rawId: encodeWebAuthn(credential.rawId), type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment,
      clientExtensionResults: credential.getClientExtensionResults(), response };
  }
  function requireWebAuthn() {
    if (!window.isSecureContext || !window.PublicKeyCredential) {
      throw new Error('当前浏览器不支持 Passkey，请使用支持 WebAuthn 的浏览器和 HTTPS 地址。');
    }
  }
  async function registerPasskey() {
    requireWebAuthn();
    const { options, challengeId } = await adminPost('passkey/register/options');
    const publicKey = { ...options, challenge: decodeWebAuthn(options.challenge),
      user: { ...options.user, id: decodeWebAuthn(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map(c => ({ ...c, id: decodeWebAuthn(c.id) })) };
    const credential = await navigator.credentials.create({ publicKey });
    if (!credential) throw new Error('未创建 Passkey');
    const data = await adminPost('passkey/register/verify', { challengeId, response: webAuthnResponse(credential) });
    if (data.backup_code) showBackup(data.backup_code, refreshAdmin);
    else await refreshAdmin();
  }
  async function loginPasskey() {
    requireWebAuthn();
    const { options, challengeId } = await adminPost('passkey/login/options');
    const publicKey = { ...options, challenge: decodeWebAuthn(options.challenge),
      allowCredentials: (options.allowCredentials || []).map(c => ({ ...c, id: decodeWebAuthn(c.id) })) };
    const credential = await navigator.credentials.get({ publicKey });
    if (!credential) throw new Error('未选择 Passkey');
    await adminPost('passkey/login/verify', { challengeId, response: webAuthnResponse(credential) });
  }
  $('#passkeyRegisterBtn').addEventListener('click', () => adminAction(registerPasskey));
  $('#passkeyLoginBtn').addEventListener('click', () => adminAction(async () => {
    await loginPasskey();
    await refreshAdmin();
  }));
  $('#addPasskeyBtn').addEventListener('click', () => adminAction(async () => {
    await loginPasskey(); // 添加凭证前要求一次新的用户验证。
    await registerPasskey();
  }));
  $('#rotateBackupBtn').addEventListener('click', () => adminAction(async () => {
    await loginPasskey();
    const data = await adminPost('backup/rotate');
    showBackup(data.backup_code, refreshAdmin);
  }));
  const logoutAdmin = () => adminAction(async () => {
    await adminPost('logout');
    $('#adminPwd').value = '';
    $('#shareRows').textContent = '';
    $('#adminStats').textContent = '';
    await refreshAdmin();
  });
  $('#adminLogout').addEventListener('click', logoutAdmin);
  $('#setupLogout').addEventListener('click', logoutAdmin);

  $('#sweepBtn').addEventListener('click', () => adminAction(async () => {
    await adminPost('sweep');
    toast('已清理');
    await loadAdmin();
  }));

  async function loadAdmin() {
    try {
      const s = await api('/api/admin/stats');
      $('#adminStats').innerHTML = `
        <div class="stat"><div class="num">${s.total}</div><div class="lbl">总分享</div></div>
        <div class="stat"><div class="num">${s.active}</div><div class="lbl">有效</div></div>
        <div class="stat"><div class="num">${s.expired}</div><div class="lbl">已失效</div></div>`;
      const list = await api('/api/admin/shares');
      const rows = list.shares.map((r) => `
        <tr>
          <td class="code-cell">${escapeHtml(formatCode(r.code))}</td>
          <td>${r.type === 'file' ? '📄 文件' : '✏️ 文本'}</td>
          <td>${escapeHtml(r.file_name || '—')}</td>
          <td>${r.download_limit > 0 ? (r.download_limit - r.downloads) : '∞'}</td>
          <td>${fmtExpire(r.expire_at)}</td>
          <td><button class="del" data-code="${escapeHtml(r.code)}">删除</button></td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">暂无分享</td></tr>';
      $('#shareRows').innerHTML = rows;
      $$('#shareRows .del').forEach((b) =>
        b.addEventListener('click', () => delShare(b.dataset.code))
      );
    } catch (e) {
      if (/401|未授权/.test(e.message)) {
        await refreshAdmin();
      } else toast(e.message);
    }
  }

  async function delShare(code) {
    if (!confirm('确认删除取件码 ' + code + '？')) return;
    try {
      await api('/api/admin/share/' + code, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
      toast('已删除');
      loadAdmin();
    } catch (e) { toast(e.message); }
  }

  // ---------- 分享链接直达（#r/CODE） ----------
  function handleHash() {
    const m = location.hash.match(/^#r\/(.+)$/);
    if (m) {
      switchView('receive');
      $('#codeInput').value = m[1];
      doReceive(false);
    }
  }
  window.addEventListener('hashchange', handleHash);

  // ---------- 启动 ----------
  loadConfig();
  handleHash();
})();
