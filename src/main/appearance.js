// Moyu 个性化（主进程）：背景图片、主题包导入导出、字体文件管理
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];
const FONT_EXT = ['ttf', 'otf', 'ttc', 'woff', 'woff2'];
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' };

const bgDir = () => path.join(app.getPath('userData'), 'backgrounds');
const fontDir = () => path.join(app.getPath('userData'), 'fonts');

function uniqueCopy(src, dir, base) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(src).toLowerCase();
  base = (base || path.basename(src, path.extname(src))).replace(/[\\/:*?"<>|]/g, '').slice(0, 60) || 'file';
  let name = base + ext;
  for (let i = 1; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}${ext}`;
  const dst = path.join(dir, name);
  fs.copyFileSync(src, dst);
  return dst;
}

/* ---------------- 字体文件：读取 name 表中的字体家族名 ---------------- */

function decodeName(buf, platform, encoding) {
  if (platform === 3 || platform === 0) { // UTF-16BE
    let s = '';
    for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode(buf.readUInt16BE(i));
    return s;
  }
  return platform === 1 && encoding === 0 ? buf.toString('latin1') : '';
}

/** 解析 TTF / OTF / TTC 的字体家族名（优先简体中文，其次英文）；WOFF 等压缩格式返回 null */
function fontFamilyName(file) {
  try {
    const b = fs.readFileSync(file);
    let off = 0;
    if (b.toString('latin1', 0, 4) === 'ttcf') off = b.readUInt32BE(12);
    const tag = b.toString('latin1', off, off + 4);
    if (!['\u0000\u0001\u0000\u0000', 'OTTO', 'true'].includes(tag)) return null;
    const numTables = b.readUInt16BE(off + 4);
    let nameOff = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = off + 12 + i * 16;
      if (b.toString('latin1', rec, rec + 4) === 'name') { nameOff = b.readUInt32BE(rec + 8); break; }
    }
    if (nameOff < 0) return null;
    const count = b.readUInt16BE(nameOff + 2);
    const strOff = nameOff + b.readUInt16BE(nameOff + 4);
    const found = {};
    for (let i = 0; i < count; i++) {
      const r = nameOff + 6 + i * 12;
      const platform = b.readUInt16BE(r);
      const encoding = b.readUInt16BE(r + 2);
      const lang = b.readUInt16BE(r + 4);
      const id = b.readUInt16BE(r + 6);
      if (id !== 1 && id !== 16) continue; // 1：家族名；16：排版家族名
      const s = decodeName(b.slice(strOff + b.readUInt16BE(r + 10), strOff + b.readUInt16BE(r + 10) + b.readUInt16BE(r + 8)), platform, encoding).trim();
      if (!s) continue;
      const key = (lang === 0x0804 || lang === 0x0404 ? 'zh' : (lang === 0x0409 || platform === 1 ? 'en' : 'other')) + id;
      if (!found[key]) found[key] = s;
    }
    return found.zh16 || found.zh1 || found.en16 || found.en1 || found.other16 || found.other1 || null;
  } catch (e) {
    return null;
  }
}

function listFonts() {
  let files = [];
  try { files = fs.readdirSync(fontDir()); } catch (e) { return []; }
  return files.filter((f) => FONT_EXT.includes(path.extname(f).slice(1).toLowerCase())).map((f) => {
    const full = path.join(fontDir(), f);
    const base = path.basename(f, path.extname(f));
    return {
      file: f,
      // 用文件名作为 CSS 中的家族名（稳定、唯一），显示名取字体内部名称
      family: 'MoyuFont-' + base.replace(/[^\w一-龥-]/g, '_'),
      name: fontFamilyName(full) || base,
      url: pathToFileURL(full).href,
      size: fs.statSync(full).size,
      format: { ttf: 'truetype', ttc: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' }[path.extname(f).slice(1).toLowerCase()],
    };
  });
}

function insideDir(dir, file) {
  const full = path.resolve(dir, file);
  return full.startsWith(path.resolve(dir) + path.sep) ? full : null;
}

/** 注册 IPC。ctx: { getSettings } */
function register(h, ctx) {
  const win = (e) => BrowserWindow.fromWebContents(e.sender);

  // 背景图片：复制到用户目录，避免原图移动或删除后失效
  h('theme:pickBackground', async (e) => {
    const r = await dialog.showOpenDialog(win(e), { title: '选择背景图片', properties: ['openFile'], filters: [{ name: '图片', extensions: IMG_EXT }] });
    if (r.canceled) return null;
    const p = uniqueCopy(r.filePaths[0], bgDir());
    return { path: p, url: pathToFileURL(p).href };
  });
  h('theme:bgUrl', (e, p) => (p && fs.existsSync(p) ? pathToFileURL(p).href : null));
  // 供页面分析图片亮度与配色：data URL 不会污染 canvas（file:// 图片会）
  h('theme:bgData', (e, p) => {
    const full = p && insideDir(bgDir(), path.basename(p));
    if (!full || !fs.existsSync(full)) return null;
    const ext = path.extname(full).slice(1).toLowerCase();
    return `data:${MIME[ext] || 'image/png'};base64,${fs.readFileSync(full).toString('base64')}`;
  });

  // 导出主题包（.moyutheme，JSON；背景图片以 data URL 内嵌）
  h('theme:export', async (e, data) => {
    const r = await dialog.showSaveDialog(win(e), { title: '导出主题', defaultPath: (data.name || 'Moyu 主题') + '.moyutheme', filters: [{ name: 'Moyu 主题', extensions: ['moyutheme'] }] });
    if (r.canceled) return null;
    const pkg = { format: 'moyu-theme', version: 1, name: data.name || '', settings: data.settings };
    const bg = data.settings && data.settings.bgImage;
    if (bg && fs.existsSync(bg)) {
      const ext = path.extname(bg).slice(1).toLowerCase();
      pkg.background = { ext, data: `data:${MIME[ext] || 'image/png'};base64,${fs.readFileSync(bg).toString('base64')}` };
    }
    delete pkg.settings.bgImage;
    fs.writeFileSync(r.filePath, JSON.stringify(pkg, null, 2), 'utf8');
    return r.filePath;
  });

  // 导入：主题包 / CSS 样式 / 图片（作为背景）
  h('theme:import', async (e, filePath) => {
    let p = filePath;
    if (!p) {
      const r = await dialog.showOpenDialog(win(e), {
        title: '导入主题',
        properties: ['openFile'],
        filters: [{ name: '主题包、CSS 或图片', extensions: ['moyutheme', 'json', 'css'].concat(IMG_EXT) }],
      });
      if (r.canceled) return null;
      p = r.filePaths[0];
    }
    const ext = path.extname(p).slice(1).toLowerCase();
    if (IMG_EXT.includes(ext)) {
      const dst = uniqueCopy(p, bgDir());
      return { type: 'image', path: dst, url: pathToFileURL(dst).href };
    }
    if (ext === 'css') {
      const text = fs.readFileSync(p, 'utf8');
      if (text.length > 512 * 1024) throw new Error('CSS 文件过大（上限 512 KB）');
      return { type: 'css', text, name: path.basename(p) };
    }
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
    if (pkg.format !== 'moyu-theme' || typeof pkg.settings !== 'object') throw new Error('不是有效的 Moyu 主题包');
    const settings = pkg.settings;
    if (pkg.background && /^data:image\/[\w+.-]+;base64,/.test(pkg.background.data || '')) {
      const ext2 = IMG_EXT.includes(pkg.background.ext) ? pkg.background.ext : 'png';
      fs.mkdirSync(bgDir(), { recursive: true });
      const dst = path.join(bgDir(), `theme-${Date.now()}.${ext2}`);
      fs.writeFileSync(dst, Buffer.from(pkg.background.data.split(',')[1], 'base64'));
      settings.bgImage = dst;
    }
    return { type: 'package', name: pkg.name || path.basename(p, path.extname(p)), settings };
  });

  // 字体文件
  h('font:list', () => listFonts());
  h('font:import', async (e) => {
    const r = await dialog.showOpenDialog(win(e), { title: '导入字体文件', properties: ['openFile', 'multiSelections'], filters: [{ name: '字体', extensions: FONT_EXT }] });
    if (r.canceled) return null;
    const added = r.filePaths.map((p) => path.basename(uniqueCopy(p, fontDir())));
    return { added, fonts: listFonts() };
  });
  h('font:remove', (e, file) => {
    const full = insideDir(fontDir(), file);
    if (full && fs.existsSync(full)) fs.unlinkSync(full);
    return listFonts();
  });
  // 导出 HTML 时内嵌字体（上限 12 MB，过大的中文字体保持文件引用）
  h('font:dataUrl', (e, file) => {
    const full = insideDir(fontDir(), file);
    if (!full || !fs.existsSync(full) || fs.statSync(full).size > 12 * 1024 * 1024) return null;
    const ext = path.extname(full).slice(1).toLowerCase();
    return `data:font/${ext === 'otf' ? 'otf' : ext === 'woff2' ? 'woff2' : ext === 'woff' ? 'woff' : 'ttf'};base64,${fs.readFileSync(full).toString('base64')}`;
  });
  void ctx;
}

module.exports = { register };
