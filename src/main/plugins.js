// Moyu 插件管理（主进程）：扫描插件目录、启用状态、插件数据存储、插件菜单项
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
let menuItems = [];

const userPluginDir = () => path.join(app.getPath('userData'), 'plugins');
const dataDir = () => path.join(app.getPath('userData'), 'plugin-data');

function ensureUserDir() {
  const dir = userPluginDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const readme = path.join(dir, '在此放置插件.txt');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, '每个插件是此目录下的一个文件夹，包含 plugin.json 与入口脚本（默认 main.js）。\r\n开发说明见 Moyu 菜单「帮助 → 插件开发指南」。\r\n', 'utf8');
    }
  } catch (e) { /* 只读环境下忽略 */ }
  return dir;
}

/** 扫描内置插件目录与用户插件目录，返回插件清单（同 id 时内置优先） */
function scan(root, settings) {
  const disabled = new Set(settings.disabledPlugins || []);
  const out = [];
  const seen = new Set();
  const sources = [{ dir: path.join(root, 'plugins'), builtin: true }, { dir: ensureUserDir(), builtin: false }];
  for (const { dir, builtin } of sources) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const pdir = path.join(dir, ent.name);
      const manifestPath = path.join(pdir, 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;
      const base = { id: ent.name, name: ent.name, version: '', description: '', author: '', dir: pdir, builtin, enabled: false };
      let m;
      try {
        m = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
      } catch (e) {
        out.push(Object.assign(base, { error: 'plugin.json 解析失败：' + e.message }));
        continue;
      }
      const id = String(m.id || '');
      if (!ID_RE.test(id)) { out.push(Object.assign(base, { error: 'plugin.json 中的 id 缺失或不合法（只能包含字母、数字、. _ -）' })); continue; }
      if (seen.has(id)) { out.push(Object.assign(base, { id: id + ' (' + ent.name + ')', name: m.name || id, error: `id「${id}」与另一个插件重复，已忽略` })); continue; }
      seen.add(id);
      const main = String(m.main || 'main.js');
      const mainPath = path.resolve(pdir, main);
      let error = null;
      if (!mainPath.startsWith(pdir + path.sep)) error = 'main 必须位于插件目录内';
      else if (!fs.existsSync(mainPath)) error = `找不到入口脚本 ${main}`;
      out.push({
        id,
        name: String(m.name || id),
        version: String(m.version || '0.0.0'),
        description: String(m.description || ''),
        author: String(m.author || ''),
        homepage: typeof m.homepage === 'string' ? m.homepage : '',
        apiVersion: Number(m.apiVersion || 1),
        main,
        dir: pdir,
        builtin,
        baseUrl: pathToFileURL(pdir + path.sep).href,
        mainUrl: pathToFileURL(mainPath).href,
        enabled: !disabled.has(id),
        error,
      });
    }
  }
  return out;
}

function storageFile(id) {
  if (!ID_RE.test(id)) throw new Error('非法插件 id');
  return path.join(dataDir(), id + '.json');
}

/** 注册插件相关 IPC。ctx: { root, getSettings, saveSettings, refreshMenu, windows } */
function register(h, ctx) {
  h('plugins:list', () => scan(ctx.root, ctx.getSettings()));
  h('plugins:setEnabled', (e, id, enabled) => {
    const s = ctx.getSettings();
    const set = new Set(s.disabledPlugins || []);
    if (enabled) set.delete(id); else set.add(id);
    s.disabledPlugins = [...set];
    ctx.saveSettings();
    for (const w of ctx.windows) if (w.webContents !== e.sender) w.webContents.send('plugins-changed');
    return true;
  });
  h('plugins:openDir', () => shell.openPath(ensureUserDir()));
  h('plugins:storageGet', (e, id) => {
    try { return JSON.parse(fs.readFileSync(storageFile(id), 'utf8')); } catch (err) { return {}; }
  });
  h('plugins:storageSet', (e, id, data) => {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(storageFile(id), JSON.stringify(data, null, 2), 'utf8');
    return true;
  });
  h('plugins:setMenu', (e, items) => {
    const clean = (Array.isArray(items) ? items : []).slice(0, 200).map((it) => ({
      key: String(it.key),
      pluginId: String(it.pluginId),
      pluginName: String(it.pluginName || it.pluginId),
      title: String(it.title || it.key).slice(0, 80),
      accelerator: it.accelerator ? String(it.accelerator) : null,
    })).filter((it) => /^plugin:[^:]+:[\w.-]+$/.test(it.key));
    if (JSON.stringify(clean) === JSON.stringify(menuItems)) return true;
    menuItems = clean;
    ctx.refreshMenu();
    return true;
  });
}

/** 自检模式下清空插件目录与插件数据，保证结果可重复 */
function resetForTest() {
  for (const d of [userPluginDir(), dataDir()]) fs.rmSync(d, { recursive: true, force: true });
}

module.exports = { register, ensureUserDir, resetForTest, menuItems: () => menuItems };
