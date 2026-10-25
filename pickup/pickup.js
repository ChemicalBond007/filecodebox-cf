(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  let receiving = false;
  let passwordCode = '';

  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add('hidden'), 1800);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, credentials: 'omit' });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `请求失败 (${response.status})`);
    if (!data) throw new Error('服务响应无效，请重试');
    return data;
  }

  function normalizeCode(value) {
    return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function fmtSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function element(tag, className, text) {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function showResult(claim) {
    const out = $('#receiveOut');
    if (claim.type === 'text') {
      const copy = element('button', 'mini-btn', '复制文本');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(claim.text);
          toast('已复制');
        } catch {
          toast('复制失败，请手动复制');
        }
      });
      out.replaceChildren(element('div', 'text-result', claim.text), copy);
    } else if (claim.type === 'file') {
      const url = new URL(claim.url, location.origin);
      if (url.origin !== location.origin || !/^\/file\/[^/]+$/.test(url.pathname)) {
        throw new Error('下载地址无效，请重新取件');
      }
      const name = claim.file_name || 'file';
      const link = element('a', 'primary-btn', '下载文件');
      link.href = url.pathname + url.search;
      link.download = name;
      link.style.display = 'inline-block';
      const result = element('div', 'file-result');
      result.append(element('div', 'fr-name', name), element('div', 'fr-size', fmtSize(claim.file_size)), link);
      out.replaceChildren(result);
    } else {
      throw new Error('服务响应无效，请重试');
    }
  }

  function setBusy(busy) {
    receiving = busy;
    for (const id of ['codeInput', 'receiveBtn', 'receivePwd', 'pwdSubmit']) {
      $('#' + id).disabled = busy;
    }
    $('#receiveOut').setAttribute('aria-busy', String(busy));
  }

  async function doReceive(withPassword) {
    if (receiving) return;
    const code = normalizeCode($('#codeInput').value);
    if (!code) { toast('请输入取件码'); return; }
    if (code !== passwordCode) {
      $('#receivePwd').value = '';
      $('#pwdRow').classList.add('hidden');
      withPassword = false;
    }
    setBusy(true);
    const out = $('#receiveOut');
    out.replaceChildren(element('div', 'spinner', '取件中…'));
    try {
      const meta = await api('/api/share/' + code);
      if (meta.has_password) {
        passwordCode = code;
        $('#pwdRow').classList.remove('hidden');
        if (!withPassword) {
          out.replaceChildren();
          return;
        }
      }
      const body = new FormData();
      if (withPassword) body.set('password', $('#receivePwd').value);
      const claim = await api('/api/share/' + code + '/claim', { method: 'POST', body });
      showResult(claim);
      $('#pwdRow').classList.add('hidden');
      $('#receivePwd').value = '';
    } catch (error) {
      out.replaceChildren(element('div', 'msg err', error.message));
    } finally {
      setBusy(false);
      if (!$('#pwdRow').classList.contains('hidden')) $('#receivePwd').focus();
    }
  }

  $('#receiveForm').addEventListener('submit', event => {
    event.preventDefault();
    return doReceive(false);
  });
  $('#pwdRow').addEventListener('submit', event => {
    event.preventDefault();
    return doReceive(true);
  });
  $('#codeInput').addEventListener('input', () => {
    passwordCode = '';
    $('#receivePwd').value = '';
    $('#pwdRow').classList.add('hidden');
    $('#receiveOut').replaceChildren();
  });

  function handleHash() {
    const match = location.hash.match(/^#r\/(.+)$/);
    if (match && !receiving) {
      $('#codeInput').value = match[1];
      return doReceive(false);
    }
  }
  window.addEventListener('hashchange', handleHash);

  async function loadConfig() {
    try {
      const config = await api('/api/config');
      if (config.name) {
        $('#appName').textContent = config.name;
        document.title = `${config.name} · 取件`;
      }
      if (typeof config.subtitle === 'string') $('#appSubtitle').textContent = config.subtitle;
    } catch { /* 使用默认标题 */ }
  }

  loadConfig();
  handleHash();
})();
