// Moyu 图片处理：插入图片时的复制 / 上传规则，以及 PicGo / 命令行上传服务（行为对标 Typora）
const { app, net } = require('electron');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IMG_EXT = /^\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?|avif)$/i;
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif' };
const isHttp = (s) => /^https?:\/\/\S+$/i.test(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function uniqueName(dir, base, ext) {
  let name = base + ext;
  let i = 1;
  while (fs.existsSync(path.join(dir, name))) name = `${base}-${i++}${ext}`;
  return name;
}

const fallbackDir = () => path.join(app.getPath('userData'), 'images');
const tempDir = () => path.join(os.tmpdir(), 'zmark-upload');

function docBaseName(docPath) {
  return docPath ? path.basename(docPath, path.extname(docPath)) : 'untitled';
}

/** 展开目标目录模板（支持 ${filename}），相对路径基于文档目录 */
function expandTarget(tpl, docPath) {
  const t = String(tpl || '').trim().replace(/^['"]|['"]$/g, '').replace(/\$\{filename\}/g, docBaseName(docPath));
  if (!t) return null;
  if (path.isAbsolute(t)) return t;
  return docPath ? path.resolve(path.dirname(docPath), t) : null;
}

/** 根据设置与 YAML（typora-copy-images-to / zmark-copy-images-to）决定插入动作 */
function resolveAction(s, docPath, yamlTarget) {
  if (yamlTarget) {
    if (yamlTarget.trim().toLowerCase() === 'upload') {
      if (s.imageYamlUpload) return { type: 'upload' };
    } else {
      return { type: 'copy', dir: expandTarget(yamlTarget, docPath) };
    }
  }
  const docDir = docPath ? path.dirname(docPath) : null;
  switch (s.imageInsertAction) {
    case 'upload': return { type: 'upload' };
    case 'copyToCurrent': return { type: 'copy', dir: docDir };
    case 'copyToAssets': return { type: 'copy', dir: docDir && path.join(docDir, s.imageFolder || 'assets') };
    case 'copyToCustom': return { type: 'copy', dir: expandTarget(s.imageCustomPath || './${filename}.assets', docPath) };
    default: return { type: 'none' };
  }
}

/** 按「图片语法偏好」生成 Markdown 中的图片地址 */
function formatSrc(s, docPath, abs) {
  let p;
  if (s.imagePreferRelative && docPath) {
    p = path.relative(path.dirname(docPath), abs).replace(/\\/g, '/');
    if (s.imageAddDotSlash && !p.startsWith('.') && !path.isAbsolute(p)) p = './' + p;
  } else {
    p = abs.replace(/\\/g, '/');
  }
  return s.imageEscapeUrl ? encodeURI(p) : p.replace(/ /g, '%20');
}

function writeData(dir, src) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = '.' + String(src.ext || 'png').replace(/^\./, '').replace('jpeg', 'jpg');
  const full = path.join(dir, uniqueName(dir, 'image-' + stamp(), ext));
  fs.writeFileSync(full, Buffer.from(src.data));
  return full;
}

function copyInto(dir, file) {
  if (!fs.existsSync(file)) throw new Error('图片不存在：' + file);
  if (path.resolve(path.dirname(file)).toLowerCase() === path.resolve(dir).toLowerCase()) return file;
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(file);
  const full = path.join(dir, uniqueName(dir, path.basename(file, ext), ext));
  fs.copyFileSync(file, full);
  return full;
}

async function download(url, dir) {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`下载图片失败（HTTP ${res.status}）：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const u = new URL(url);
  let ext = path.extname(decodeURIComponent(u.pathname));
  if (!IMG_EXT.test(ext)) ext = '.' + (MIME_EXT[(res.headers.get('content-type') || '').split(';')[0].trim()] || 'png');
  let base = path.basename(decodeURIComponent(u.pathname), path.extname(decodeURIComponent(u.pathname))).replace(/[\\/:*?"<>|]/g, '').slice(0, 60);
  if (!base) base = 'image-' + stamp();
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, uniqueName(dir, base, ext));
  fs.writeFileSync(full, buf);
  return full;
}

/* ======================= 上传服务 ======================= */

async function postJson(url, body, timeout) {
  const res = await net.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { throw new Error(`PicGo 返回了无法解析的结果（HTTP ${res.status}）：${text.slice(0, 200)}`); }
}

const isConnError = (e) => /ERR_CONNECTION|ECONNREFUSED|ERR_ADDRESS|fetch failed|Failed to fetch|ERR_EMPTY_RESPONSE/i.test(String((e && e.message) || e));

async function waitForServer(base, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await net.fetch(base + '/heartbeat', { method: 'POST', signal: AbortSignal.timeout(1500) }); return true; } catch (e) { await sleep(800); }
  }
  return false;
}

/** PicGo 桌面版：调用其内置 HTTP 服务（默认 127.0.0.1:36677），未运行时按路径启动 */
async function uploadPicgoApp(s, files) {
  const base = String(s.picgoServer || 'http://127.0.0.1:36677').replace(/\/+$/, '');
  let r;
  try {
    r = await postJson(base + '/upload', { list: files }, 120000);
  } catch (e) {
    if (!isConnError(e)) throw e;
    if (!s.picgoPath || !fs.existsSync(s.picgoPath)) {
      throw new Error(`无法连接 PicGo（${base}）。请先启动 PicGo 并开启「PicGo-Server」，或在设置中填写 PicGo 路径以便自动启动。`);
    }
    spawn(s.picgoPath, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    if (!(await waitForServer(base, 25000))) throw new Error(`已启动 PicGo，但 ${base} 无响应。请确认 PicGo 设置中已开启 Server。`);
    r = await postJson(base + '/upload', { list: files }, 120000);
  }
  if (!r || !r.success) throw new Error('PicGo 上传失败：' + ((r && (r.message || r.msg)) || '未知错误'));
  const urls = Array.isArray(r.result) ? r.result : [];
  if (urls.length !== files.length) throw new Error(`PicGo 返回了 ${urls.length} 个地址，应为 ${files.length} 个`);
  return urls;
}

/** 命令行上传：命令 + 引号包裹的图片路径；从输出的最后几行读取图片地址 */
function uploadCommand(cmd, files, picgoStyle) {
  return new Promise((resolve, reject) => {
    const full = cmd + ' ' + files.map((f) => `"${f}"`).join(' ');
    exec(full, { timeout: 180000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
      let lines = out.split(/\r?\n/);
      if (picgoStyle) {
        const idx = lines.findIndex((l) => l.includes('[PicGo SUCCESS]'));
        if (idx >= 0) lines = lines.slice(idx + 1);
      }
      const urls = lines.map((l) => l.trim()).filter(isHttp).slice(-files.length);
      if (urls.length === files.length) { resolve(urls); return; }
      const detail = (out + '\n' + String(stderr || '')).trim().slice(-600);
      reject(new Error(`上传命令未输出 ${files.length} 个图片地址。${err ? '\n' + err.message.split('\n')[0] : ''}${detail ? '\n输出：\n' + detail : ''}`));
    });
  });
}

/** 命令本身是含空格的程序路径（如 C:\Program Files\picgo.cmd）时加引号；带参数的命令原样使用 */
function quoteCmd(c) {
  c = String(c || '').trim();
  return /\s/.test(c) && !c.startsWith('"') && fs.existsSync(c) ? `"${c}"` : c;
}

async function upload(s, files) {
  if (!files.length) return [];
  switch (s.uploadService) {
    case 'picgo-core': return uploadCommand(quoteCmd(s.picgoCoreCommand || 'picgo') + ' upload', files, true);
    case 'custom':
      if (!String(s.customUploadCommand || '').trim()) throw new Error('尚未设置自定义上传命令');
      return uploadCommand(s.customUploadCommand.trim(), files, false);
    default: return uploadPicgoApp(s, files);
  }
}

/* ======================= 对外接口 ======================= */

/**
 * 插入图片：sources 为 [{path}|{url}|{data, ext}]
 * 返回 {results: [{src, uploaded?}], uploaded, error}
 */
async function insertImages(s, { docPath, yamlTarget, sources }) {
  const action = resolveAction(s, docPath, yamlTarget);
  const results = [];
  const queue = [];
  const docAssets = docPath ? path.join(path.dirname(docPath), s.imageFolder || 'assets') : fallbackDir();

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const isNet = !!src.url;
    const isData = !!src.data;
    const applies = isData || (isNet ? s.imageApplyNetwork : s.imageApplyLocal);
    if (!applies || action.type === 'none') {
      if (isData) results[i] = { src: formatSrc(s, docPath, writeData(docAssets, src)) }; // 粘贴的图片必须落盘
      else results[i] = { src: isNet ? src.url : formatSrc(s, docPath, src.path) };
      continue;
    }
    if (action.type === 'upload') {
      queue.push({ i, file: isNet ? src.url : (isData ? writeData(tempDir(), src) : src.path), temp: isData });
      continue;
    }
    const dir = action.dir || fallbackDir();
    let abs;
    if (isData) abs = writeData(dir, src);
    else if (isNet) abs = await download(src.url, dir);
    else abs = copyInto(dir, src.path);
    results[i] = { src: formatSrc(s, docPath, abs) };
  }

  let error = null;
  if (queue.length) {
    try {
      const urls = await upload(s, queue.map((q) => q.file));
      queue.forEach((q, k) => { results[q.i] = { src: urls[k], uploaded: true }; });
    } catch (e) {
      error = e.message;
      // 上传失败：保留为本地图片，不丢内容
      for (const q of queue) {
        if (isHttp(q.file)) results[q.i] = { src: q.file };
        else results[q.i] = { src: formatSrc(s, docPath, q.temp ? copyInto(docAssets, q.file) : q.file) };
      }
    }
    for (const q of queue) if (q.temp) fs.unlink(q.file, () => {});
  }
  return { results, uploaded: queue.length && !error ? queue.length : 0, error };
}

/** 上传文档中已有的本地图片：items 为 [{src, abs}] */
async function uploadLocal(s, items) {
  const missing = items.filter((it) => !fs.existsSync(it.abs)).map((it) => it.src);
  const ok = items.filter((it) => fs.existsSync(it.abs));
  const urls = await upload(s, ok.map((it) => it.abs));
  const map = {};
  ok.forEach((it, k) => { map[it.src] = urls[k]; });
  return { map, missing };
}

/** 「验证图片上传选项」：上传一张测试图片 */
async function testUpload(s, iconPath) {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `zmark-test-${stamp()}.png`);
  fs.writeFileSync(file, fs.readFileSync(iconPath)); // 应用图标可能位于 asar 内，先复制到真实文件
  const started = Date.now();
  try {
    const [url] = await upload(s, [file]);
    return { ok: true, url, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    fs.unlink(file, () => {});
  }
}

module.exports = { insertImages, uploadLocal, testUpload, resolveAction, formatSrc };
