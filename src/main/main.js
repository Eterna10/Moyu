// Moyu 主进程：窗口、菜单、文件系统、导出、设置
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { buildMenu } = require('./menu');
const images = require('./images');
const plugins = require('./plugins');
const appearance = require('./appearance');
const updater = require('./updater');
const history = require('./history');
const workspace = require('./workspace');

const ROOT = path.join(__dirname, '..', '..');
const SELF_TEST = process.argv.includes('--self-test');
const ICON = path.join(ROOT, 'build', 'icon.png');
const MD_EXT = ['md', 'markdown', 'mdown', 'mkd', 'txt'];
const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];

if (SELF_TEST) app.setPath('userData', path.join(os.tmpdir(), 'zmark-selftest'));
else migrateUserData();

/** 软件由 ZMark 更名为 Moyu：首次启动时复制旧版的设置、插件、插件数据与粘贴的图片（旧目录保留不动） */
function migrateUserData() {
  try {
    const dst = app.getPath('userData');
    const src = path.join(app.getPath('appData'), 'Z' + 'Mark');
    if (path.resolve(src).toLowerCase() === path.resolve(dst).toLowerCase()) return;
    if (fs.existsSync(path.join(dst, 'settings.json')) || !fs.existsSync(path.join(src, 'settings.json'))) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const name of ['settings.json', 'plugins', 'plugin-data', 'images']) {
      const from = path.join(src, name);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(dst, name), { recursive: true });
    }
  } catch (e) { console.error('migrate settings failed', e); }
}

/* ---------------- 设置 ---------------- */
const DEFAULTS = {
  // 通用
  startupAction: 'new', // new | restoreLast | welcome
  autoSave: false,
  autoSaveDelay: 2, // 秒
  saveOnBlur: false,
  externalChange: 'auto', // auto（无未保存修改时自动重新加载）| ask | ignore
  defaultEol: 'LF', // 新建文件的换行符：LF | CRLF
  insertFinalNewline: false,
  trimTrailingWhitespace: false,
  recentLimit: 10,
  // 外观
  theme: 'github',
  fontFamily: 'default', // default | sans | serif | kai | mono | custom
  customFont: '',
  fontSize: 16,
  lineHeight: 1.75,
  paragraphSpacing: 'normal', // compact | normal | loose
  contentWidth: 860,
  firstLineIndent: false,
  headingNumbering: false,
  showStatusBar: true,
  showWordCount: true,
  sidebarPosition: 'left',
  // 编辑器
  richMode: true, // 纯文本模式：编辑时不显示 Markdown 源码
  enterMode: 'paragraph', // paragraph：Enter 新段落 | newline：Enter 换行
  autoPair: true,
  wrapSelection: true,
  livePreview: true,
  tabSize: 4,
  insertSpaces: true,
  // Markdown
  breaks: true,
  linkify: true,
  typographer: false,
  mathSyntax: true,
  markSyntax: true,
  supSubSyntax: false,
  mermaid: true,
  codeLineNumbers: false,
  codeWrap: false,
  mathNumbering: false,
  listMarker: '-',
  strongMarker: '**',
  emMarker: '*',
  // 导出
  exportTheme: 'current', // current | github | newsprint | night | midnight
  pdfPageSize: 'A4',
  pdfLandscape: false,
  pdfMargin: 'normal', // narrow | normal | wide
  pdfHeaderFooter: 'none', // none | page | titlePage
  exportEmbedImages: false,
  openAfterExport: false,
  // 个性化：背景图片与配色
  bgImage: '',
  bgFit: 'cover', // cover | contain | tile
  bgOpacityAuto: true, // 根据图片亮度与复杂度自动计算遮罩透明度
  bgOverlay: 0.8, // 手动模式下遮罩的不透明度（越大图片越淡）
  bgBlur: 0,
  bgPanels: true, // 侧边栏与状态栏半透明，透出背景
  accentColor: '', // 空：主题默认；auto：取自背景图片；#rrggbb：自定义
  customCss: '',
  codeFont: 'default', // default | mono | font:<家族名> | custom
  customCodeFont: '',
  // 更新与历史版本
  smartPaste: true, // 粘贴网页 / Word 内容时转换为 Markdown
  autoCheckUpdate: true,
  lastUpdateCheck: 0,
  skippedVersion: '', // 用户选择「跳过此版本」的版本号，自动检查时不再弹窗
  updateMirror: '',
  historyEnabled: true,
  historyMax: 50,
  slashCommands: true,
  showSplash: true, // 启动时显示开启动画
  // 图像
  imageFolder: 'assets',
  // 图像（对标 Typora「偏好设置 → 图像」）
  imageInsertAction: 'copyToAssets', // none | copyToCurrent | copyToAssets | copyToCustom | upload
  imageCustomPath: './${filename}.assets',
  imageApplyLocal: true,
  imageApplyNetwork: false,
  imageYamlUpload: false,
  imagePreferRelative: true,
  imageAddDotSlash: false,
  imageEscapeUrl: false,
  uploadService: 'picgo-app', // picgo-app | picgo-core | custom
  picgoPath: '',
  picgoServer: 'http://127.0.0.1:36677',
  picgoCoreCommand: 'picgo',
  customUploadCommand: '',
  spellcheck: false,
  sidebar: true,
  sidebarTab: 'outline',
  sidebarWidth: 260,
  focusMode: false,
  typewriter: false,
  recentFiles: [],
  disabledPlugins: [],
  lastFolder: null,
  lastFile: null,
  firstRun: true,
  bounds: null,
};
let settingsFile = null;
let settings = null;
function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) { /* 首次运行 */ }
  // 旧版「插入图片时复制到文档目录」开关迁移为新的插入规则
  if (raw.imageInsertAction === undefined && raw.copyImages === false) raw.imageInsertAction = 'none';
  delete raw.copyImages;
  settings = Object.assign({}, DEFAULTS, raw);
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch (e) { console.error('save settings failed', e); }
}

/* ---------------- 窗口 ---------------- */
const windows = new Set();
let startupHandled = false;
let splashShown = false; // 开启动画只在程序启动时的第一个窗口播放
function bgFor(theme) { return { night: '#1f2124', midnight: '#12192b', newsprint: '#f3f2ee' }[theme] || '#ffffff'; }

function createWindow(filePath) {
  const b = settings.bounds || {};
  const offset = windows.size * 26;
  const win = new BrowserWindow({
    width: b.width || 1200,
    height: b.height || 820,
    x: b.x !== undefined && windows.size === 0 ? b.x : undefined,
    y: b.y !== undefined && windows.size === 0 ? b.y : undefined,
    minWidth: 640,
    minHeight: 420,
    title: 'Moyu',
    icon: fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : undefined,
    backgroundColor: bgFor(settings.theme),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // 自检窗口在后台运行（常被其他窗口遮挡），关闭计时器节流，避免依赖时间的用例偶发失败
      backgroundThrottling: !SELF_TEST,
    },
  });
  if (offset && !b.x) win.setPosition(win.getPosition()[0] + offset, win.getPosition()[1] + offset);
  win.pendingFile = filePath || null;
  win.forceClose = false;
  windows.add(win);
  // 是否播放开启动画由主进程在加载前决定（通过地址参数传给页面），关闭时不会闪现
  const splash = !splashShown && settings.showSplash !== false;
  splashShown = true;
  const dark = ['night', 'midnight'].includes(settings.theme);
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'), splash ? { query: { splash: '1', bg: bgFor(settings.theme), dark: dark ? '1' : '0' } } : undefined);
  win.once('ready-to-show', () => { if (SELF_TEST) win.showInactive(); else win.show(); });

  // 禁止页面导航与新窗口：外链交给系统浏览器
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.session.setSpellCheckerLanguages(['en-US']);
  workspace.attachContextMenu(win);

  win.on('close', (e) => {
    if (win.forceClose || SELF_TEST) return;
    e.preventDefault();
    win.webContents.send('before-close');
  });
  win.on('closed', () => windows.delete(win));
  const remember = () => { if (!win.isMaximized() && !win.isMinimized()) { settings.bounds = win.getBounds(); } };
  win.on('resize', remember);
  win.on('move', remember);
  win.webContents.on('render-process-gone', () => { win.forceClose = true; });
  return win;
}

function focusedWin(e) {
  return (e && BrowserWindow.fromWebContents(e.sender)) || BrowserWindow.getFocusedWindow() || [...windows][0];
}

function sendCommand(cmd, win) {
  win = win || BrowserWindow.getFocusedWindow() || [...windows][0];
  if (!win) { if (cmd === 'file.new' || cmd === 'file.open') createWindow(); return; }
  win.webContents.send('menu', cmd);
}

function openInWindow(filePath) {
  const win = BrowserWindow.getFocusedWindow() || [...windows][0];
  if (win) win.webContents.send('open-file', filePath);
  else createWindow(filePath);
}

function refreshMenu() {
  Menu.setApplicationMenu(buildMenu({
    settings,
    send: sendCommand,
    newWindow: () => createWindow(),
    openRecent: (p) => openInWindow(p),
    clearRecent: () => { settings.recentFiles = []; saveSettings(); refreshMenu(); },
    plugins: plugins.menuItems(),
    openPluginDir: () => shell.openPath(plugins.ensureUserDir()),
  }));
}

function addRecent(p) {
  if (!p) return;
  settings.recentFiles = [p].concat(settings.recentFiles.filter((x) => x !== p)).slice(0, settings.recentLimit || 10);
  saveSettings();
  refreshMenu();
  if (process.platform === 'win32' && !SELF_TEST) app.addRecentDocument(p); // 自检不写入系统「最近使用」
}

/* ---------------- 文件树 ---------------- */
function readTree(dir, depth) {
  const node = { name: path.basename(dir) || dir, path: dir, dir: true, children: [] };
  if (depth > 6) return node;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return node; }
  entries = entries.filter((ent) => !ent.name.startsWith('.') && ent.name !== 'node_modules');
  entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  node.empty = entries.length === 0; // 全空的文件夹（例如刚新建的）也显示；只有图片等其它文件的文件夹不显示
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const child = readTree(full, depth + 1);
      if (child.children.length || child.empty) node.children.push(child);
    } else if (MD_EXT.includes(path.extname(ent.name).slice(1).toLowerCase())) {
      node.children.push({ name: ent.name, path: full, dir: false });
    }
  }
  return node;
}

/* ---------------- 导出 PDF ---------------- */
const PDF_MARGINS = { narrow: 0.4, normal: 0.6, wide: 1.0 }; // 英寸

/** 按「偏好设置 → 导出」生成 printToPDF 参数 */
function pdfOptions(title) {
  const m = PDF_MARGINS[settings.pdfMargin] || PDF_MARGINS.normal;
  const opts = {
    printBackground: true,
    pageSize: ['A3', 'A4', 'A5', 'Letter', 'Legal'].includes(settings.pdfPageSize) ? settings.pdfPageSize : 'A4',
    landscape: !!settings.pdfLandscape,
    margins: { top: m, bottom: m, left: m, right: m },
  };
  if (settings.pdfHeaderFooter && settings.pdfHeaderFooter !== 'none') {
    const style = 'font-size:8px;color:#888;width:100%;padding:0 0.6in;font-family:sans-serif;';
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    opts.displayHeaderFooter = true;
    opts.headerTemplate = settings.pdfHeaderFooter === 'titlePage' ? `<div style="${style}text-align:left">${esc(title)}</div>` : '<span></span>';
    opts.footerTemplate = `<div style="${style}text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`;
    opts.margins.top = Math.max(m, 0.6); // 给页眉页脚留出空间
    opts.margins.bottom = Math.max(m, 0.6);
  }
  return opts;
}

async function htmlToPdf(html, outPath, title) {
  const tmp = path.join(os.tmpdir(), `zmark-export-${Date.now()}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  try {
    await w.loadFile(tmp);
    await new Promise((r) => setTimeout(r, 400));
    const data = await w.webContents.printToPDF(pdfOptions(title || path.basename(outPath, '.pdf')));
    fs.writeFileSync(outPath, data);
  } finally {
    w.destroy();
    fs.unlink(tmp, () => {});
  }
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, fn);

  appearance.register(h, { getSettings: () => settings });
  updater.register(h, {
    root: ROOT, getSettings: () => settings, saveSettings, selfTest: SELF_TEST,
    apiBase: () => (SELF_TEST && process.env.MOYU_UPDATE_API) || 'https://api.github.com',
    patchDir: () => process.env.MOYU_PATCH_DIR || null, // 仅在自检时使用
  });
  history.register(h, { getSettings: () => settings });
  workspace.register(h, { mdExt: MD_EXT, decodeText, selfTest: SELF_TEST });
  plugins.register(h, { root: ROOT, getSettings: () => settings, saveSettings, refreshMenu, windows });

  h('settings:get', () => settings);
  h('settings:set', (e, patch) => {
    Object.assign(settings, patch);
    if ('recentLimit' in patch) settings.recentFiles = settings.recentFiles.slice(0, settings.recentLimit);
    saveSettings();
    if ('theme' in patch || 'richMode' in patch || 'autoSave' in patch || 'recentLimit' in patch) refreshMenu();
    for (const w of windows) if (w.webContents !== e.sender) w.webContents.send('settings-changed', patch);
    return settings;
  });
  // 恢复默认设置：保留最近文件、窗口位置、插件启用状态等使用记录
  h('settings:reset', (e) => {
    const keep = {};
    for (const k of ['recentFiles', 'lastFolder', 'lastFile', 'bounds', 'firstRun', 'disabledPlugins', 'sidebarWidth']) keep[k] = settings[k];
    for (const k of Object.keys(settings)) delete settings[k];
    Object.assign(settings, DEFAULTS, keep);
    saveSettings();
    refreshMenu();
    for (const w of windows) if (w.webContents !== e.sender) w.webContents.send('settings-changed', Object.assign({}, settings));
    return settings;
  });
  h('win:initial', (e) => {
    const win = focusedWin(e);
    const first = settings.firstRun;
    if (first) { settings.firstRun = false; saveSettings(); }
    const startup = !startupHandled; // 只有程序启动时的第一个窗口执行「启动时」设置
    startupHandled = true;
    return { file: win ? win.pendingFile : null, firstRun: first, startup, selfTest: SELF_TEST };
  });
  h('win:setTitle', (e, title, edited) => {
    const win = focusedWin(e);
    if (!win) return;
    win.setTitle(title);
    win.setDocumentEdited(!!edited);
  });
  h('win:close', (e) => {
    const win = focusedWin(e);
    if (win) { win.forceClose = true; win.close(); }
  });

  h('dialog:open', async (e) => {
    const r = await dialog.showOpenDialog(focusedWin(e), {
      title: '打开 Markdown 文件',
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: MD_EXT }, { name: '所有文件', extensions: ['*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  h('dialog:openFolder', async (e) => {
    const r = await dialog.showOpenDialog(focusedWin(e), { title: '打开文件夹', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('dialog:save', async (e, opts) => {
    const r = await dialog.showSaveDialog(focusedWin(e), {
      title: opts.title || '保存',
      defaultPath: opts.defaultPath,
      filters: opts.filters || [{ name: 'Markdown', extensions: ['md'] }],
    });
    return r.canceled ? null : r.filePath;
  });
  h('dialog:pickImage', async (e) => {
    const r = await dialog.showOpenDialog(focusedWin(e), {
      title: '插入图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: IMG_EXT }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  h('dialog:pickExe', async (e, current) => {
    const r = await dialog.showOpenDialog(focusedWin(e), {
      title: '选择 PicGo 程序',
      defaultPath: current || undefined,
      properties: ['openFile'],
      filters: [{ name: '程序', extensions: ['exe'] }, { name: '所有文件', extensions: ['*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  h('dialog:confirmSave', async (e, name) => {
    const r = await dialog.showMessageBox(focusedWin(e), {
      type: 'warning',
      buttons: ['保存', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
      title: 'Moyu',
      message: `是否保存对“${name}”的修改？`,
      detail: '如果不保存，你的修改将会丢失。',
    });
    return r.response;
  });
  h('dialog:message', async (e, opts) => {
    if (SELF_TEST) return opts && opts.cancelId !== undefined ? opts.cancelId : 1; // 自检不弹出系统对话框，按「取消」处理
    return (await dialog.showMessageBox(focusedWin(e), Object.assign({ title: 'Moyu' }, opts))).response;
  });

  h('fs:read', (e, p) => {
    const st = fs.statSync(p);
    if (st.size > MAX_DOC_BYTES) throw new Error(`文件过大（${(st.size / 1048576).toFixed(0)} MB），Moyu 最多打开 ${MAX_DOC_BYTES / 1048576} MB 的文本文件`);
    const r = decodeText(fs.readFileSync(p));
    return { content: r.content, encoding: r.encoding, lossy: !!r.lossy, mtime: st.mtimeMs };
  });
  h('fs:write', (e, p, content) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeFileAtomic(p, content);
    return { mtime: fs.statSync(p).mtimeMs };
  });
  h('fs:stat', (e, p) => { try { return fs.statSync(p).mtimeMs; } catch (err) { return null; } });
  h('fs:exists', (e, p) => fs.existsSync(p));
  h('fs:tree', (e, dir) => (dir && fs.existsSync(dir) ? readTree(dir, 0) : null));
  h('fs:newFile', (e, dir, name) => {
    if (!/\.(md|markdown|txt)$/i.test(name)) name += '.md';
    if (/[\\/:*?"<>|]/.test(name)) throw new Error('文件名包含非法字符');
    const p = path.join(dir, name);
    if (fs.existsSync(p)) throw new Error('文件已存在');
    fs.writeFileSync(p, '', 'utf8');
    return p;
  });
  h('image:insert', (e, opts) => images.insertImages(settings, opts));
  h('image:uploadLocal', (e, { baseDir, items }) => images.uploadLocal(settings, items.map((it) => ({
    src: it.src,
    abs: path.isAbsolute(it.path) ? it.path : path.resolve(baseDir || '', it.path),
  }))));
  h('image:testUpload', () => images.testUpload(settings, ICON));

  h('app:addRecent', (e, p) => addRecent(p));
  h('app:readAsset', (e, rel) => {
    const full = path.resolve(ROOT, rel);
    if (!full.startsWith(ROOT + path.sep)) throw new Error('forbidden');
    return fs.readFileSync(full, 'utf8');
  });
  h('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    root: ROOT,
    katexDir: path.join(ROOT, 'node_modules', 'katex', 'dist'),
    userData: app.getPath('userData'),
  }));
  h('app:helpDoc', (e, name) => {
    // 帮助文档：samples/ 下的文件，或 docs/ 下的文档（如插件开发指南）
    const p = path.resolve(ROOT, /^docs[\\/]/.test(name) ? name : path.join('samples', name));
    if (!p.startsWith(ROOT + path.sep)) throw new Error('forbidden');
    return { content: fs.readFileSync(p, 'utf8'), dir: path.dirname(p) };
  });

  // 导出后按设置用系统默认程序打开（自检时不打开）
  const afterExport = (p) => { if (settings.openAfterExport && !SELF_TEST) shell.openPath(p); return p; };
  h('export:html', async (e, { html, defaultPath, outPath }) => {
    let target = outPath;
    if (!target) {
      const r = await dialog.showSaveDialog(focusedWin(e), { title: '导出 HTML', defaultPath, filters: [{ name: 'HTML', extensions: ['html'] }] });
      if (r.canceled) return null;
      target = r.filePath;
    }
    fs.writeFileSync(target, html, 'utf8');
    return afterExport(target);
  });
  h('export:pdf', async (e, { html, defaultPath, outPath, title }) => {
    let target = outPath;
    if (!target) {
      const r = await dialog.showSaveDialog(focusedWin(e), { title: '导出 PDF', defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (r.canceled) return null;
      target = r.filePath;
    }
    await htmlToPdf(html, target, title);
    return afterExport(target);
  });
  // 导出 HTML 时把本地图片嵌入为 data URL
  h('fs:imageDataUrl', (e, p) => {
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' }[ext];
    if (!mime || !fs.existsSync(p) || fs.statSync(p).size > 20 * 1024 * 1024) return null;
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  });
  h('shell:open', (e, url) => {
    if (/^(https?:|mailto:)/i.test(url)) return shell.openExternal(url);
    return null;
  });
  h('shell:reveal', (e, p) => { if (p) shell.showItemInFolder(p); });
  // 由主进程写剪贴板：不受窗口是否处于焦点的限制
  h('app:copyText', (e, text) => { clipboard.writeText(String(text)); return true; });
}

/* ---------------- 文本文件读写 ---------------- */
const MAX_DOC_BYTES = 50 * 1048576;

/**
 * 按实际编码解码文本文件：UTF-8（含 BOM）、UTF-16（BOM）、GB18030 / GBK。
 * 中文 Windows 上常见 GBK 编码的 .md / .txt，按 UTF-8 读取会成为乱码，保存后原文无法恢复。
 */
function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { content: buf.toString('utf8', 3), encoding: 'UTF-8' };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { content: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'UTF-16 LE' };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { content: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'UTF-16 BE' };
  try { return { content: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'UTF-8' }; } catch (e) { /* 不是 UTF-8 */ }
  try { return { content: new TextDecoder('gb18030', { fatal: true }).decode(buf), encoding: 'GB18030' }; } catch (e) { /* 也不是 GB18030 */ }
  return { content: buf.toString('utf8'), encoding: 'UTF-8', lossy: true };
}

/**
 * 原子写入：先写到同目录的临时文件再改名覆盖，写入中途崩溃或断电不会留下被截断的文档。
 * 符号链接、硬链接保持原样直接写入；临时文件无法创建或改名时（如目录只读）退回直接写入。
 */
function writeFileAtomic(p, content) {
  let direct = false;
  let mode;
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || st.nlink > 1) direct = true;
    mode = st.mode;
  } catch (e) { /* 新文件 */ }
  if (!direct) {
    const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(tmp, content, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode });
      fs.renameSync(tmp, p);
      return;
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* 忽略 */ }
    }
  }
  fs.writeFileSync(p, content, 'utf8');
}

/* ---------------- 启动 ---------------- */
function fileFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('--') && a !== '.');
  const f = args.find((a) => MD_EXT.includes(path.extname(a).slice(1).toLowerCase()));
  return f && fs.existsSync(f) ? path.resolve(f) : null;
}

if (!SELF_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    const f = fileFromArgv(argv);
    if (f) createWindow(f);
    else {
      const w = [...windows][0];
      if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
    }
  });

  app.whenReady().then(() => {
    loadSettings();
    if (SELF_TEST) {
      // 既有用例针对源码编辑，纯文本模式单独测试；自检不访问真实的 GitHub
      Object.assign(settings, DEFAULTS, { firstRun: false, richMode: false, autoCheckUpdate: false });
      plugins.resetForTest();
      for (const d of ['history', 'fonts', 'backgrounds']) fs.rmSync(path.join(app.getPath('userData'), d), { recursive: true, force: true });
    }
    registerIpc();
    refreshMenu();
    const win = createWindow(SELF_TEST ? null : fileFromArgv(process.argv));
    if (SELF_TEST) require(path.join(ROOT, 'test', 'selftest.js'))(win, { ROOT, app, createWindow, getSettings: () => settings });
  });

  app.on('window-all-closed', () => {
    saveSettings();
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => { if (!windows.size) createWindow(); });
}
