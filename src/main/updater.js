// Moyu 在线更新（主进程）：从 GitHub Releases 检查新版本、下载并校验、退出后安装
//
// 两种更新方式：
// - 增量更新（安装版）：发布中带有 Moyu-<版本>-app-electron-<Electron 版本>.asar.gz，且 Electron 版本与本机一致时，
//   只下载这个几 MB 的包。解压为 resources/app-update.asar 并校验其中的版本号，退出后由辅助脚本
//   （用 Moyu.exe 以 Node 模式运行）等待进程结束、替换 app.asar，再重新启动 Moyu。替换失败时保留原文件。
// - 完整更新：下载安装包（安装版退出后运行安装程序）或便携版文件（放到当前程序旁边）。
const { app, net, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
// 处理 .asar 文件本身时绕过 Electron 的 asar 文件系统（否则会被当作目录）
const ofs = (() => { try { return require('original-fs'); } catch (e) { return fs; } })();

const DEFAULT_REPO = 'Eterna10/Moyu';

/** 版本号比较：a > b 返回正数 */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 当前运行形态：setup（安装版）/ portable（便携版）/ dev（开发模式） */
function runKind() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  return app.isPackaged ? 'setup' : 'dev';
}

function pickAsset(assets, kind) {
  const exe = (assets || []).filter((a) => /\.exe$/i.test(a.name));
  const want = kind === 'portable' ? /portable/i : /setup/i;
  return exe.find((a) => want.test(a.name)) || null;
}

/** 与本机 Electron 版本一致的增量更新包 */
function pickPatch(assets) {
  return (assets || []).find((a) => {
    const m = /^Moyu-[\d.]+-app-electron-([\d.]+)\.asar\.gz$/i.exec(a.name);
    return m && m[1] === process.versions.electron;
  }) || null;
}

const updateDir = () => path.join(app.getPath('temp'), 'moyu-update');

/** resources 目录是否可写（安装到 Program Files 等受保护目录时不可写，只能用完整安装包更新） */
function writable(dir) {
  const probe = path.join(dir, `.moyu-write-test-${process.pid}`);
  try { fs.writeFileSync(probe, ''); fs.rmSync(probe); return true; } catch (e) { return false; }
}

// 辅助脚本：由 Moyu.exe 以 Node 模式运行（ELECTRON_RUN_AS_NODE=1），参数：进程号 新文件 目标文件 日志 [重启的程序 及其参数…]
const HELPER = `process.noAsar = true;
const fs = require('fs');
const { spawn } = require('child_process');
const [pid, src, dst, log, exe, ...args] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const note = (s) => { if (log) try { fs.appendFileSync(log, new Date().toISOString() + ' ' + s + '\\n'); } catch (e) {} };
(async () => {
  for (let i = 0; i < 600 && alive(); i++) await sleep(100);
  const old = dst + '.old';
  let ok = false;
  for (let i = 0; i < 50 && !ok; i++) {
    try {
      fs.rmSync(old, { force: true });
      fs.renameSync(dst, old);
      try { fs.renameSync(src, dst); ok = true; } catch (e) { fs.renameSync(old, dst); throw e; }
    } catch (e) { if (i === 49) note('替换失败：' + e.message); await sleep(200); }
  }
  if (ok) { try { fs.rmSync(old, { force: true }); } catch (e) {} note('已替换 ' + dst); }
  if (exe) {
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;
    const direct = () => spawn(exe, args, { detached: true, stdio: 'ignore', env }).unref();
    // 经 Start-Process（ShellExecute）启动：新的 Moyu 不会继承旧进程遗留的句柄（如已打开的网络端口）
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    let cmd = 'Start-Process -FilePath ' + q(exe);
    if (args.length) cmd += ' -ArgumentList ' + q(args.map((a) => '"' + a + '"').join(' '));
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'ignore', env, windowsHide: true });
    ps.on('error', () => { note('无法通过 PowerShell 启动，改为直接启动'); direct(); });
    ps.on('exit', (code) => { if (code) { note('Start-Process 失败，改为直接启动'); direct(); } });
  }
})();
`;

/** 写出辅助脚本，返回其路径 */
function writeHelper() {
  fs.mkdirSync(updateDir(), { recursive: true });
  const file = path.join(updateDir(), 'apply-update.js');
  fs.writeFileSync(file, HELPER);
  return file;
}

/** 启动时清理上次未完成的增量更新留下的文件 */
function cleanupPatch(dir) {
  if (!dir) return;
  for (const f of ['app-update.asar', 'app.asar.old']) {
    try { ofs.rmSync(path.join(dir, f), { force: true }); } catch (e) { /* 可能仍被占用，下次再清理 */ }
  }
}

/**
 * ctx: { root, apiBase(), patchDir(), selfTest, getSettings, saveSettings }
 * apiBase / patchDir 仅在自检时可替换为本地模拟服务与临时目录
 */
function register(h, ctx) {
  let abort = null;
  let pendingInstaller = null;
  let pendingPatch = null;

  // 增量更新的目标目录：安装版为 resources 目录；便携版与开发模式不支持
  // （自检时只使用指定的临时目录，绝不改动真实的 resources 目录）
  const patchDir = () => {
    if (ctx.selfTest) return (ctx.patchDir && ctx.patchDir()) || null;
    return runKind() === 'setup' ? process.resourcesPath : null;
  };
  cleanupPatch(patchDir());

  const repo = () => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(ctx.root, 'package.json'), 'utf8'));
      const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec((pkg.repository && (pkg.repository.url || pkg.repository)) || '');
      return m ? m[1] : DEFAULT_REPO;
    } catch (e) { return DEFAULT_REPO; }
  };

  h('update:check', async () => {
    const current = app.getVersion();
    const kind = runKind();
    const url = `${ctx.apiBase()}/repos/${repo()}/releases/latest`;
    let res;
    try {
      res = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Moyu-Updater' }, signal: AbortSignal.timeout(15000) });
    } catch (e) {
      return { ok: false, error: '无法连接 GitHub：' + (e.message || e), current, repo: repo() };
    }
    if (res.status === 404) return { ok: false, error: '仓库中还没有发布版本', current, repo: repo() };
    if (res.status === 403) return { ok: false, error: 'GitHub 访问频率受限，请稍后再试', current, repo: repo() };
    if (!res.ok) return { ok: false, error: `GitHub 返回 HTTP ${res.status}`, current, repo: repo() };
    const r = await res.json();
    const latest = String(r.tag_name || '').replace(/^v/i, '');
    const asset = pickAsset(r.assets, kind === 'dev' ? 'setup' : kind);
    const dir = patchDir();
    const patch = dir && writable(dir) ? pickPatch(r.assets) : null;
    const s = ctx.getSettings();
    s.lastUpdateCheck = Date.now();
    ctx.saveSettings();
    return {
      ok: true,
      current,
      latest,
      newer: compareVersions(latest, current) > 0,
      kind,
      name: r.name || r.tag_name,
      notes: r.body || '',
      url: r.html_url,
      publishedAt: r.published_at,
      repo: repo(),
      asset: asset && { name: asset.name, size: asset.size, url: asset.browser_download_url, digest: asset.digest || null },
      patch: patch && { name: patch.name, size: patch.size, url: patch.browser_download_url, digest: patch.digest || null },
    };
  });

  // 下载安装包：流式写入临时目录，推送进度，校验大小与 SHA-256（GitHub 提供时）
  h('update:download', async (e, asset) => {
    const allowLocal = ctx.apiBase() !== 'https://api.github.com'; // 仅自检时使用本地模拟服务
    if (!asset || !(/^https:\/\//.test(asset.url) || (allowLocal && /^http:\/\/127\.0\.0\.1[:/]/.test(asset.url)))) throw new Error('无效的下载地址');
    if (!/^[\w.-]+\.(exe|asar\.gz)$/i.test(asset.name)) throw new Error('无效的文件名');
    const prefix = String(ctx.getSettings().updateMirror || '').trim();
    const url = prefix && /^https:\/\//.test(prefix) ? prefix.replace(/\/?$/, '/') + asset.url : asset.url;
    fs.mkdirSync(updateDir(), { recursive: true });
    const file = path.join(updateDir(), asset.name);
    const part = file + '.part';
    abort = new AbortController();
    const sender = e.sender;
    try {
      const res = await net.fetch(url, { headers: { 'User-Agent': 'Moyu-Updater' }, signal: abort.signal });
      if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
      const total = Number(res.headers.get('content-length')) || asset.size || 0;
      const out = fs.createWriteStream(part);
      const hash = crypto.createHash('sha256');
      const reader = res.body.getReader();
      let received = 0;
      let last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        hash.update(buf);
        if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
        received += buf.length;
        if (Date.now() - last > 120 && !sender.isDestroyed()) { last = Date.now(); sender.send('update-progress', { received, total }); }
      }
      await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
      if (asset.size && received !== asset.size) throw new Error(`文件大小不符（${received} / ${asset.size} 字节）`);
      const digest = 'sha256:' + hash.digest('hex');
      if (asset.digest && asset.digest.toLowerCase() !== digest) throw new Error('文件校验失败（SHA-256 不一致），已删除下载的文件');
      fs.renameSync(part, file);
      if (!sender.isDestroyed()) sender.send('update-progress', { received, total: received, done: true });
      return { file, digest, verified: !!asset.digest };
    } catch (err) {
      fs.rmSync(part, { force: true });
      if (abort && abort.signal.aborted) return { canceled: true };
      throw err;
    } finally {
      abort = null;
    }
  });

  h('update:cancel', () => { if (abort) abort.abort(); });

  // 安装：增量更新包退出后替换 app.asar 并重启；安装版在 Moyu 退出后启动安装程序；便携版把新版本放到当前程序旁边
  h('update:install', async (e, file, opts = {}) => {
    const full = path.resolve(file || '');
    if (!full.startsWith(path.resolve(updateDir()) + path.sep) || !fs.existsSync(full)) throw new Error('找不到下载的安装包');
    if (/\.asar\.gz$/i.test(full)) {
      const dir = patchDir();
      if (!dir) throw new Error('当前运行方式不支持增量更新');
      let data;
      try {
        data = await new Promise((r, j) => zlib.gunzip(fs.readFileSync(full), (err, d) => (err ? j(new Error('更新包已损坏，无法解压')) : r(d))));
        const pkg = asarPackage(data);
        if (!pkg || pkg.name !== 'moyu' || (opts.version && pkg.version !== opts.version)) throw new Error('更新包内容无效，已放弃更新');
      } finally {
        fs.rmSync(full, { force: true }); // 无论成功与否都不再需要下载的压缩包
      }
      const pkg = asarPackage(data);
      const src = path.join(dir, 'app-update.asar');
      ofs.writeFileSync(src, data);
      if (ctx.selfTest) return { kind: 'patch', version: pkg.version, path: src }; // 自检只验证到这一步，不退出、不替换
      pendingPatch = { src, dst: path.join(dir, 'app.asar') };
      setTimeout(() => app.quit(), 100); // 退出流程会先询问各窗口是否保存
      return { kind: 'patch', version: pkg.version, path: src };
    }
    const kind = runKind();
    if (kind === 'portable') {
      const dst = path.join(path.dirname(process.env.PORTABLE_EXECUTABLE_FILE), path.basename(full));
      fs.copyFileSync(full, dst);
      shell.showItemInFolder(dst);
      return { kind, path: dst };
    }
    if (kind === 'dev') { shell.showItemInFolder(full); return { kind, path: full }; }
    pendingInstaller = full;
    setTimeout(() => app.quit(), 100); // 退出流程会先询问各窗口是否保存
    return { kind, path: full };
  });

  app.on('will-quit', () => {
    if (pendingPatch) {
      const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
      const log = path.join(updateDir(), 'apply-update.log');
      spawn(process.execPath, [writeHelper(), String(process.pid), pendingPatch.src, pendingPatch.dst, log, process.execPath, ...process.argv.slice(1)], { detached: true, stdio: 'ignore', env, windowsHide: true }).unref();
      pendingPatch = null;
    }
    if (pendingInstaller) {
      spawn(pendingInstaller, [], { detached: true, stdio: 'ignore' }).unref();
      pendingInstaller = null;
    }
  });
}

/** 读取 asar 包中的 package.json；不是有效的 Moyu 程序包时返回 null（不经过 Electron 的 asar 缓存） */
function asarPackage(buf) {
  try {
    // 格式：[4][头部长度] + 头部 pickle：[负载长度][JSON 长度][JSON]，文件内容从 8 + 头部长度 处开始
    const headerSize = buf.readUInt32LE(4);
    const jsonLen = buf.readUInt32LE(12);
    const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen));
    const files = header.files || {};
    const mainJs = files.src && files.src.files && files.src.files.main && files.src.files.main.files && files.src.files.main.files['main.js'];
    const entry = files['package.json'];
    if (!mainJs || !entry || entry.unpacked) return null;
    const start = 8 + headerSize + Number(entry.offset);
    return JSON.parse(buf.toString('utf8', start, start + entry.size));
  } catch (e) {
    return null;
  }
}

module.exports = { register, writeHelper, asarPackage };
