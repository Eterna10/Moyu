// Moyu 在线更新（主进程）：从 GitHub Releases 检查新版本、下载安装包并校验、退出后安装
const { app, net, shell, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

const updateDir = () => path.join(app.getPath('temp'), 'moyu-update');

/**
 * ctx: { root, apiBase(), getSettings, saveSettings }
 * apiBase 仅在自检时可替换为本地模拟服务
 */
function register(h, ctx) {
  let abort = null;
  let pendingInstaller = null;

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
    };
  });

  // 下载安装包：流式写入临时目录，推送进度，校验大小与 SHA-256（GitHub 提供时）
  h('update:download', async (e, asset) => {
    const allowLocal = ctx.apiBase() !== 'https://api.github.com'; // 仅自检时使用本地模拟服务
    if (!asset || !(/^https:\/\//.test(asset.url) || (allowLocal && /^http:\/\/127\.0\.0\.1[:/]/.test(asset.url)))) throw new Error('无效的下载地址');
    if (!/^[\w.-]+\.exe$/i.test(asset.name)) throw new Error('无效的文件名');
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

  // 安装：安装版在 Moyu 退出后启动安装程序；便携版把新版本放到当前程序旁边
  h('update:install', (e, file) => {
    const full = path.resolve(file || '');
    if (!full.startsWith(path.resolve(updateDir()) + path.sep) || !fs.existsSync(full)) throw new Error('找不到下载的安装包');
    const kind = runKind();
    if (kind === 'portable') {
      const dst = path.join(path.dirname(process.env.PORTABLE_EXECUTABLE_FILE), path.basename(full));
      fs.copyFileSync(full, dst);
      shell.showItemInFolder(dst);
      return { kind, path: dst };
    }
    if (kind === 'dev') { shell.showItemInFolder(full); return { kind, path: full }; }
    pendingInstaller = full;
    const w = BrowserWindow.fromWebContents(e.sender);
    setTimeout(() => app.quit(), 100); // 退出流程会先询问各窗口是否保存
    void w;
    return { kind, path: full };
  });

  app.on('will-quit', () => {
    if (!pendingInstaller) return;
    spawn(pendingInstaller, [], { detached: true, stdio: 'ignore' }).unref();
    pendingInstaller = null;
  });
}

module.exports = { register, compareVersions, runKind };
