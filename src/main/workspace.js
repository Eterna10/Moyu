// Moyu 工作区（主进程）：文件树管理、文件夹内全文搜索、未保存内容的崩溃恢复、原生右键菜单
const { app, shell, Menu, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SEARCH_MAX_FILE = 2 * 1048576; // 超过 2 MB 的文件不参与搜索
const SEARCH_MAX_MATCHES = 500;
const SEARCH_MAX_FILES = 3000;

function checkName(name) {
  name = String(name || '').trim();
  if (!name || name === '.' || name === '..') throw new Error('名称不能为空');
  if (/[\\/:*?"<>|]/.test(name)) throw new Error('名称中不能包含 \\ / : * ? " < > |');
  if (/[. ]$/.test(name)) throw new Error('名称不能以空格或句点结尾');
  return name;
}

const recoveryDir = () => path.join(app.getPath('userData'), 'recovery');
const recoveryFile = (key) => {
  if (!/^[\w-]{6,40}$/.test(String(key))) throw new Error('无效的恢复标识');
  return path.join(recoveryDir(), key + '.json');
};

/**
 * ctx: { mdExt, decodeText, selfTest }
 */
function register(h, ctx) {
  const isDoc = (name) => ctx.mdExt.includes(path.extname(name).slice(1).toLowerCase());

  /* ---------------- 文件树管理 ---------------- */

  h('fs:newFolder', (e, dir, name) => {
    const p = path.join(dir, checkName(name));
    if (fs.existsSync(p)) throw new Error('同名的文件或文件夹已存在');
    fs.mkdirSync(p);
    return p;
  });

  // 重命名（保持在原目录中）；文档省略扩展名时沿用原扩展名
  h('fs:rename', (e, p, newName) => {
    newName = checkName(newName);
    const st = fs.statSync(p);
    if (!st.isDirectory() && !path.extname(newName)) newName += path.extname(p);
    const dst = path.join(path.dirname(p), newName);
    if (dst === p) return p;
    // 仅大小写不同（Windows 上视为同一文件）时允许直接改名
    if (fs.existsSync(dst) && dst.toLowerCase() !== p.toLowerCase()) throw new Error('同名的文件或文件夹已存在');
    fs.renameSync(p, dst);
    return dst;
  });

  // 删除：移到回收站，可以恢复
  h('fs:trash', async (e, p) => {
    if (!p || !fs.existsSync(p)) throw new Error('文件不存在');
    if (ctx.selfTest) { fs.rmSync(p, { recursive: true, force: true }); return true; } // 自检不往回收站里放文件
    await shell.trashItem(p);
    return true;
  });

  /* ---------------- 文件夹内搜索 ---------------- */

  h('fs:search', (e, dir, query, opts = {}) => {
    query = String(query || '');
    if (!dir || !query.trim() || !fs.existsSync(dir)) return { files: [], total: 0, truncated: false };
    let re;
    try {
      const src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(opts.wholeWord ? `\\b(?:${src})\\b` : src, opts.caseSensitive ? 'g' : 'gi');
    } catch (err) {
      throw new Error('正则表达式无效：' + err.message);
    }
    const files = [];
    let total = 0;
    let scanned = 0;
    let truncated = false;
    const walk = (d, depth) => {
      if (depth > 8 || truncated) return;
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (err) { return; }
      entries.sort((a, b) => (a.isDirectory() - b.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      for (const ent of entries) {
        if (truncated) return;
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) { walk(full, depth + 1); continue; }
        if (!isDoc(ent.name)) continue;
        if (++scanned > SEARCH_MAX_FILES) { truncated = true; return; }
        const matches = [];
        re.lastIndex = 0;
        const nameHit = re.test(ent.name);
        try {
          if (fs.statSync(full).size <= SEARCH_MAX_FILE) {
            const lines = ctx.decodeText(fs.readFileSync(full)).content.split(/\r\n?|\n/);
            for (let i = 0; i < lines.length && !truncated; i++) {
              const line = lines[i];
              re.lastIndex = 0;
              let m;
              while ((m = re.exec(line))) {
                if (m[0] === '') { re.lastIndex++; continue; }
                // 摘要：匹配处前后各保留一段上下文
                const from = Math.max(0, m.index - 30);
                const to = Math.min(line.length, m.index + m[0].length + 60);
                matches.push({ line: i, col: m.index, len: m[0].length, text: (from > 0 ? '…' : '') + line.slice(from, to) + (to < line.length ? '…' : ''), at: m.index - from + (from > 0 ? 1 : 0) });
                if (++total >= SEARCH_MAX_MATCHES) { truncated = true; break; }
                if (matches.length >= 50) break; // 单个文件最多列出 50 处
              }
              if (matches.length >= 50) break;
            }
          }
        } catch (err) { /* 读不了的文件跳过 */ }
        if (matches.length || nameHit) files.push({ path: full, rel: path.relative(dir, full), name: ent.name, nameHit, matches });
      }
    };
    walk(dir, 0);
    return { files, total, truncated };
  });

  /* ---------------- 崩溃恢复 ---------------- */

  // 文档有未保存的修改时，页面定期把内容写到这里；正常保存 / 关闭后删除。
  // 下次启动时若还留有文件，说明上次没有正常退出，提示用户恢复。
  const live = new Map(); // 仍在运行的窗口各自的恢复标识：这些文档并未丢失，不必提示恢复
  h('recovery:save', (e, key, doc) => {
    const file = recoveryFile(key);
    live.set(key, e.sender);
    fs.mkdirSync(recoveryDir(), { recursive: true });
    const data = JSON.stringify({ filePath: doc.filePath || null, name: String(doc.name || '未命名'), text: String(doc.text || ''), savedAt: Date.now() });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  });
  h('recovery:clear', (e, key) => { fs.rmSync(recoveryFile(key), { force: true }); return true; });
  h('recovery:list', () => {
    let names = [];
    try { names = fs.readdirSync(recoveryDir()); } catch (err) { return []; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const owner = live.get(n.slice(0, -5));
      if (owner && !owner.isDestroyed()) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(recoveryDir(), n), 'utf8'));
        if (!String(d.text || '').trim()) { fs.rmSync(path.join(recoveryDir(), n), { force: true }); continue; }
        out.push({ key: n.slice(0, -5), filePath: d.filePath, name: d.name, savedAt: d.savedAt, chars: d.text.length, preview: d.text.replace(/\s+/g, ' ').trim().slice(0, 120) });
      } catch (err) { fs.rmSync(path.join(recoveryDir(), n), { force: true }); }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  });
  h('recovery:read', (e, key) => JSON.parse(fs.readFileSync(recoveryFile(key), 'utf8')));

  /* ---------------- 右键菜单 / 编辑操作 ---------------- */

  // items: [{ id, label, enabled, checked, accelerator, submenu: [...] } | { type: 'separator' }]，返回被点击项的 id
  h('menu:popup', (e, items) => {
    if (ctx.selfTest) return global.__moyuMenuPick ? global.__moyuMenuPick(items) : null;
    const win = BrowserWindow.fromWebContents(e.sender);
    return new Promise((resolve) => {
      let picked = null;
      const build = (list) => (list || []).map((it) => {
        if (it.type === 'separator') return { type: 'separator' };
        const item = { label: String(it.label), enabled: it.enabled !== false };
        if (it.checked !== undefined) { item.type = 'checkbox'; item.checked = !!it.checked; }
        if (it.accelerator) item.label += '\t' + it.accelerator; // 仅作提示，不注册快捷键
        if (it.submenu) item.submenu = build(it.submenu);
        else item.click = () => { picked = it.id; };
        return item;
      });
      const menu = Menu.buildFromTemplate(build(items));
      menu.popup({ window: win, callback: () => setTimeout(() => resolve(picked), 0) });
    });
  });

  h('edit:exec', (e, op) => {
    const wc = e.sender;
    const ops = { cut: () => wc.cut(), copy: () => wc.copy(), paste: () => wc.paste(), pastePlain: () => wc.pasteAndMatchStyle(), selectAll: () => wc.selectAll(), delete: () => wc.delete() };
    if (ops[op]) ops[op]();
    return !!ops[op];
  });
  h('spell:replace', (e, word) => { e.sender.replaceMisspelling(String(word)); return true; });
  h('spell:add', (e, word) => e.sender.session.addWordToSpellCheckerDictionary(String(word)));
}

/** 把窗口的右键事件（含拼写建议）转给页面，由页面按点击位置决定菜单内容 */
function attachContextMenu(win) {
  win.webContents.on('context-menu', (e, p) => {
    win.webContents.send('context-menu', {
      x: p.x,
      y: p.y,
      isEditable: p.isEditable,
      selectionText: p.selectionText,
      misspelledWord: p.misspelledWord,
      suggestions: (p.dictionarySuggestions || []).slice(0, 6),
      linkURL: p.linkURL,
      srcURL: p.srcURL,
      mediaType: p.mediaType,
      canCut: p.editFlags.canCut,
      canCopy: p.editFlags.canCopy,
      canPaste: p.editFlags.canPaste,
    });
  });
}

module.exports = { register, attachContextMenu };
