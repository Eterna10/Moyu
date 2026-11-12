// Moyu 导出（主进程）：长图（PNG）与经 Pandoc 转换的 Word / ODT / RTF / EPUB / LaTeX
const { BrowserWindow, dialog, screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ======================= 长图 ======================= */

const IMAGE_WIDTHS = { mobile: 480, standard: 800, wide: 1100 }; // 版面宽度（CSS 像素）
const IMAGE_PADDING = { mobile: '28px 22px', standard: '44px 48px', wide: '48px 64px' };
const MAX_SEGMENT_PX = 12000; // 单张图片的最大高度（设备像素）；实测约 16000 以上截图会失败
const MAX_SEGMENTS = 40;

/**
 * 按块的边界把总高度切成若干段，每段不超过 maxH：优先在某个块的顶部切开，
 * 只有单个块本身就超过 maxH 时才从中间硬切。
 */
function splitSegments(total, tops, maxH) {
  const segs = [];
  let start = 0;
  while (total - start > maxH) {
    const limit = start + maxH;
    let cut = 0;
    for (const t of tops) if (t > start + maxH * 0.35 && t <= limit && t > cut) cut = t;
    if (!cut) cut = limit;
    segs.push([start, cut]);
    start = cut;
  }
  if (total > start) segs.push([start, total]);
  return segs;
}

/**
 * 把导出的 HTML 渲染成图片。在隐藏窗口中按 2 倍（或 1 倍）像素密度截图，过长的文档按段落边界分成多张。
 * 返回写出的文件路径列表（一张时为 outPath，多张时为 名称-1.png、名称-2.png …）。
 */
async function htmlToImages(html, outPath, opts = {}) {
  const key = IMAGE_WIDTHS[opts.width] ? opts.width : 'standard';
  const layout = IMAGE_WIDTHS[key];
  const scale = Number(opts.scale) === 1 ? 1 : 2;
  // 截图的像素密度跟随显示器缩放；通过窗口宽度与缩放比例得到想要的输出宽度
  const display = screen.getPrimaryDisplay().scaleFactor || 1;
  const winW = Math.max(200, Math.round((layout * scale) / display));
  const zoom = winW / layout;
  const maxCss = Math.floor(MAX_SEGMENT_PX / (zoom * display));
  const extra = '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'">' +
    `<style>html,body{overflow:hidden}::-webkit-scrollbar{display:none}.markdown-body{max-width:none!important;margin:0!important;padding:${IMAGE_PADDING[key]}!important}</style>`;
  const page = html.includes('</head>') ? html.replace('</head>', extra + '</head>') : extra + html;
  const tmp = path.join(os.tmpdir(), `moyu-image-${Date.now()}.html`);
  fs.writeFileSync(tmp, page, 'utf8');
  const w = new BrowserWindow({ show: false, width: winW, height: 600, useContentSize: true, webPreferences: { sandbox: true, backgroundThrottling: false, zoomFactor: zoom } });
  const wc = w.webContents;
  const files = [];
  try {
    await w.loadFile(tmp);
    wc.setZoomFactor(zoom);
    // 等图片与字体加载完成（页面自身的脚本已被 CSP 禁止，这里的代码由主进程注入）
    const info = await wc.executeJavaScript(`(async () => {
      const imgs = Array.from(document.images);
      imgs.forEach((im) => { im.loading = 'eager'; });
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await Promise.race([Promise.all(imgs.map((im) => (im.complete ? null : new Promise((r) => { im.onload = im.onerror = r; })))), wait(8000)]);
      try { await Promise.race([document.fonts.ready, wait(3000)]); } catch (e) {}
      await wait(120);
      const body = document.querySelector('.markdown-body') || document.body;
      const tops = Array.from(body.children).map((el) => Math.round(el.getBoundingClientRect().top + window.scrollY));
      return { total: Math.ceil(document.documentElement.scrollHeight), tops };
    })()`);
    if (!info || !info.total) throw new Error('文档内容为空');
    const segs = splitSegments(info.total, info.tops, maxCss);
    if (segs.length > MAX_SEGMENTS) throw new Error(`文档过长（需要 ${segs.length} 张图片），请改用 PDF 导出`);
    const base = outPath.replace(/\.png$/i, '');
    for (let i = 0; i < segs.length; i++) {
      const [top, bottom] = segs[i];
      w.setContentSize(winW, Math.max(1, Math.round((bottom - top) * zoom)));
      await wc.executeJavaScript(`new Promise((r) => { window.scrollTo(0, ${top}); setTimeout(r, 160); })`);
      const img = await Promise.race([wc.capturePage(), new Promise((r) => setTimeout(() => r(null), 20000))]);
      if (!img || img.isEmpty()) throw new Error('截图失败');
      const file = segs.length === 1 ? base + '.png' : `${base}-${i + 1}.png`;
      fs.writeFileSync(file, img.toPNG());
      files.push(file);
    }
    return files;
  } catch (e) {
    for (const f of files) fs.rmSync(f, { force: true });
    throw e;
  } finally {
    w.destroy();
    fs.unlink(tmp, () => {});
  }
}

/* ======================= Pandoc ======================= */

const PANDOC_FORMATS = {
  docx: { name: 'Word 文档', ext: 'docx', to: 'docx' },
  odt: { name: 'OpenDocument 文本', ext: 'odt', to: 'odt' },
  rtf: { name: 'RTF 文档', ext: 'rtf', to: 'rtf' },
  epub: { name: 'EPUB 电子书', ext: 'epub', to: 'epub' },
  latex: { name: 'LaTeX 源文件', ext: 'tex', to: 'latex' },
};

const run = (file, args, opts) => new Promise((resolve) => {
  execFile(file, args, Object.assign({ windowsHide: true, timeout: 120000, maxBuffer: 16 * 1048576 }, opts), (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

// 自检时用于模拟「没有安装 Pandoc」
let noPandoc = () => false;

/** 查找 Pandoc：偏好设置中指定的路径 → PATH → 常见安装位置。找不到返回 null */
async function findPandoc(custom) {
  if (noPandoc()) return null;
  const exe = process.platform === 'win32' ? 'pandoc.exe' : 'pandoc';
  const candidates = [];
  if (custom && String(custom).trim()) candidates.push(String(custom).trim().replace(/^"|"$/g, ''));
  candidates.push(exe);
  if (process.platform === 'win32') {
    for (const base of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) if (base) candidates.push(path.join(base, 'Pandoc', exe));
  } else candidates.push('/usr/local/bin/pandoc', '/opt/homebrew/bin/pandoc', '/usr/bin/pandoc');
  for (const c of candidates) {
    if (path.isAbsolute(c) && !fs.existsSync(c)) continue;
    const r = await run(c, ['--version'], { timeout: 8000 });
    const m = !r.err && /^pandoc(?:\.exe)?\s+([\d.]+)/i.exec(r.stdout);
    if (m) return { path: c, version: m[1] };
  }
  return null;
}

/** 把 ==高亮== 换成 <mark>（Pandoc 的 CommonMark 解析器不认识这一语法）；代码块与行内代码中的内容不动 */
function prepareMarkdown(md) {
  let fence = null;
  let hasToc = false;
  const lines = md.split('\n').map((line) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) { if (!fence) fence = m[1][0]; else if (m[1][0] === fence) fence = null; return line; }
    if (fence) return line;
    if (/^\s*\[toc\]\s*$/i.test(line)) { hasToc = true; return ''; }
    if (!line.includes('==')) return line;
    return line.split(/(`+[^`]*`+)/).map((seg, i) => (i % 2 ? seg : seg.replace(/==(?=\S)([^=\n]+?)(?<=\S)==/g, '<mark>$1</mark>'))).join('');
  });
  return { text: lines.join('\n'), hasToc };
}

/**
 * 用 Pandoc 把 Markdown 转成 Word 等格式。
 * opts: { markdown, format, outPath, baseDir, title, breaks, supSub, pandocPath }
 */
async function pandocExport(opts) {
  const fmt = PANDOC_FORMATS[opts.format];
  if (!fmt) throw new Error('不支持的导出格式');
  const pandoc = await findPandoc(opts.pandocPath);
  if (!pandoc) return { missing: true };
  const { text, hasToc } = prepareMarkdown(String(opts.markdown || ''));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-pandoc-'));
  const src = path.join(dir, 'input.md');
  fs.writeFileSync(src, text, 'utf8');
  // 与 Moyu 的渲染保持一致：不做引号 / 表情替换，不启用 Moyu 没有的扩展语法
  let from = 'commonmark_x-smart-emoji-fancy_lists-definition_lists-fenced_divs-bracketed_spans-attributes+autolink_bare_uris';
  if (opts.breaks !== false) from += '+hard_line_breaks';
  if (!opts.supSub) from += '-subscript-superscript';
  const args = ['-f', from, '-t', fmt.to, '--standalone', '-o', opts.outPath];
  const cwd = opts.baseDir && fs.existsSync(opts.baseDir) ? opts.baseDir : dir;
  args.push('--resource-path', cwd);
  if (hasToc) args.push('--toc', '--metadata', 'toc-title=目录');
  if (opts.title && !/^---\s*$/.test(text.split('\n')[0])) args.push('--metadata', 'title=' + opts.title);
  args.push(src);
  try {
    const r = await run(pandoc.path, args, { cwd });
    if (r.err && !fs.existsSync(opts.outPath)) {
      const msg = (r.stderr || r.err.message || '').trim().split('\n').slice(-3).join(' ');
      throw new Error(r.err.killed ? 'Pandoc 转换超时' : 'Pandoc 转换失败：' + msg);
    }
    // 找不到图片等情况 Pandoc 只给出警告，文件仍然生成
    const warnings = r.stderr.split('\n').filter((l) => /^\[WARNING\]/.test(l)).map((l) => l.replace(/^\[WARNING\]\s*/, '').trim());
    return { path: opts.outPath, version: pandoc.version, warnings };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * ctx: { focusedWin(e), afterExport(p), getSettings() }
 */
function register(h, ctx) {
  if (ctx.noPandoc) noPandoc = ctx.noPandoc;
  h('export:image', async (e, { html, defaultPath, outPath }) => {
    let target = outPath;
    if (!target) {
      const r = await dialog.showSaveDialog(ctx.focusedWin(e), { title: '导出图片', defaultPath, filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
      if (r.canceled) return null;
      target = r.filePath;
    }
    if (!/\.png$/i.test(target)) target += '.png';
    const s = ctx.getSettings();
    const files = await htmlToImages(html, target, { width: s.exportImageWidth, scale: s.exportImageScale });
    ctx.afterExport(files[0]);
    return files;
  });

  h('export:pandoc', async (e, { markdown, format, defaultPath, outPath, baseDir, title, breaks, supSub }) => {
    const fmt = PANDOC_FORMATS[format];
    if (!fmt) throw new Error('不支持的导出格式');
    const s = ctx.getSettings();
    // 先确认 Pandoc 可用，再询问保存位置
    if (!(await findPandoc(s.pandocPath))) return { missing: true };
    let target = outPath;
    if (!target) {
      const r = await dialog.showSaveDialog(ctx.focusedWin(e), { title: '导出 ' + fmt.name, defaultPath, filters: [{ name: fmt.name, extensions: [fmt.ext] }] });
      if (r.canceled) return null;
      target = r.filePath;
    }
    const res = await pandocExport({ markdown, format, outPath: target, baseDir, title, breaks, supSub, pandocPath: s.pandocPath });
    if (res.path) ctx.afterExport(res.path);
    return res;
  });

  h('export:pandocInfo', async () => findPandoc(ctx.getSettings().pandocPath));
}

module.exports = { register, splitSegments, prepareMarkdown, PANDOC_FORMATS };
