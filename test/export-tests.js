// 导出自检：长图（PNG）与经 Pandoc 导出的 Word 等格式
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { nativeImage } = require('electron');

module.exports = async function exportTests(t) {
  const { js, check, wait, key, OUT, ROOT } = t;
  const set = async (patch) => { await js(`__zmark.setSetting(${JSON.stringify(patch)})`); await wait(150); };
  const load = (md, meta) => js(`__zmark.loadText(${JSON.stringify(md)}, ${JSON.stringify(meta || {})})`);
  const exporter = require(path.join(ROOT, 'src', 'main', 'exporter.js'));
  const dir = path.join(OUT, 'export');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // 导出用的文档：欢迎文档 + 一张本地图片
  const DOC = path.join(dir, '欢迎.md');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'pic.png'), nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png')).resize({ width: 96, height: 96 }).toPNG());
  fs.writeFileSync(DOC, fs.readFileSync(path.join(ROOT, 'samples', '欢迎使用 Moyu.md'), 'utf8').replace('## 快速上手', '本地图片：![logo](assets/pic.png)\n\n## 快速上手'), 'utf8');
  const sizeOf = (f) => nativeImage.createFromPath(f).getSize();
  /** 图片某一行是否为单一颜色（即没有切在文字或图形中间） */
  const rowUniform = (f, y) => {
    const img = nativeImage.createFromPath(f);
    const { width, height } = img.getSize();
    const row = img.crop({ x: 0, y: y < 0 ? height + y : y, width, height: 1 }).toBitmap();
    for (let i = 4; i < row.length; i += 4) if (Math.abs(row[i] - row[0]) > 6 || Math.abs(row[i + 1] - row[1]) > 6 || Math.abs(row[i + 2] - row[2]) > 6) return false;
    return true;
  };

  /* ---------------- 分段算法 ---------------- */
  const tops = Array.from({ length: 100 }, (_, i) => i * 300);
  const segs = exporter.splitSegments(30000, tops, 12000);
  check('导出图片：过长的文档在块的边界处分段', JSON.stringify(segs) === '[[0,12000],[12000,24000],[24000,30000]]', JSON.stringify(segs));
  const segs2 = exporter.splitSegments(20000, [0, 500, 19000], 12000);
  check('导出图片：单个块超过上限时从中间切开，不会死循环', segs2.length === 2 && segs2[0][1] === 12000 && segs2[1][1] === 20000, JSON.stringify(segs2));
  check('导出图片：短文档只有一段', JSON.stringify(exporter.splitSegments(900, [0, 300], 12000)) === '[[0,900]]');

  /* ---------------- 长图 ---------------- */
  await set({ exportImageWidth: 'standard', exportImageScale: 2, theme: 'github' });
  await js(`__zmark.openPath(${JSON.stringify(DOC)}, { force: true, skipConfirm: true })`);
  for (let i = 0; i < 50 && !(await js('!!document.querySelector("#write .mermaid-block svg, #write .mermaid-error")')); i++) await wait(200);
  const one = path.join(dir, '欢迎-标准.png');
  let files = await js(`__zmark.exportDoc('image', ${JSON.stringify(one)})`);
  let sz = files && files.length === 1 ? sizeOf(files[0]) : null;
  check('导出图片：标准宽度 2 倍清晰度（1600 像素宽的单张长图）', !!sz && sz.width === 1600 && sz.height > 3000 && sz.height <= 12000 && fs.statSync(one).size > 100000, JSON.stringify({ files, sz }));
  // 缩小一份便于人工查看
  if (sz) fs.writeFileSync(path.join(dir, '欢迎-预览.png'), nativeImage.createFromPath(one).resize({ width: 500 }).toPNG());
  await set({ exportImageWidth: 'mobile', exportImageScale: 1, theme: 'night' });
  const dark = path.join(dir, '夜间.png');
  files = await js(`__zmark.exportDoc('image', ${JSON.stringify(dark)})`);
  sz = files && files.length === 1 ? sizeOf(files[0]) : null;
  const px = sz ? nativeImage.createFromPath(dark).crop({ x: 2, y: 2, width: 1, height: 1 }).toBitmap() : [255, 255, 255];
  check('导出图片：手机宽度 1 倍清晰度，使用当前（夜间）主题的背景', !!sz && sz.width === 480 && px[0] < 60 && px[1] < 60 && px[2] < 60, JSON.stringify({ sz, px: Array.from(px) }));
  await set({ theme: 'github' });
  // 很长的文档：分成多张，在段落之间切开
  const long = ['# 长文档', ''].concat(Array.from({ length: 420 }, (_, i) => `第 ${i + 1} 段：${'内容'.repeat(20)}\n`)).join('\n');
  await load(long, { filePath: path.join(dir, 'long.md') });
  await wait(300);
  await set({ exportImageWidth: 'mobile', exportImageScale: 2 });
  const multi = path.join(dir, '长文.png');
  files = await js(`__zmark.exportDoc('image', ${JSON.stringify(multi)})`);
  const sizes = (files || []).map(sizeOf);
  check('导出图片：超长文档分成多张（名称-1.png、名称-2.png …）', !!files && files.length >= 2 && files[0].endsWith('长文-1.png') && files[1].endsWith('长文-2.png') && sizes.every((s) => s.width === 960 && s.height <= 12000) && !fs.existsSync(multi), JSON.stringify({ files: (files || []).map((f) => path.basename(f)), sizes }));
  check('导出图片：分段处落在段落之间，没有把文字切成两半', !!files && files.length >= 2 && rowUniform(files[0], -1) && rowUniform(files[1], 0));
  await set({ exportImageWidth: 'standard', exportImageScale: 2 });
  check('导出图片：不影响主窗口的缩放比例', Math.abs(t.wc.getZoomFactor() - 1) < 0.001 && (await js('window.devicePixelRatio')) === (await js('window.devicePixelRatio')), String(t.wc.getZoomFactor()));

  /* ---------------- Pandoc ---------------- */
  const pm = exporter.prepareMarkdown('这是 ==高亮== 和 `==代码==`\n\n[TOC]\n\n```\n==块==\n[TOC]\n```\n\na == b 且 c == d');
  check('导出 Word：高亮转为 <mark>，代码中的内容不动，[TOC] 交给 Pandoc 生成目录', pm.hasToc && pm.text === '这是 <mark>高亮</mark> 和 `==代码==`\n\n\n\n```\n==块==\n[TOC]\n```\n\na == b 且 c == d', JSON.stringify(pm));

  process.env.MOYU_NO_PANDOC = '1';
  await load('# 没有 Pandoc');
  const miss = await js(`__zmark.exportDoc('docx', ${JSON.stringify(path.join(dir, 'none.docx'))})`);
  await wait(200);
  const help = await js('(document.querySelector(".pandoc-modal") || {}).textContent || ""');
  check('导出 Word：没有安装 Pandoc 时给出说明与下载入口，不生成文件', !!miss && miss.missing === true && /需要 Pandoc/.test(help) && /前往 Pandoc 下载页/.test(help) && !fs.existsSync(path.join(dir, 'none.docx')), help.slice(0, 80));
  await key('Escape');
  delete process.env.MOYU_NO_PANDOC;

  const info = await js('window.zmark.invoke("export:pandocInfo")');
  if (!info) {
    console.log('  （这台电脑没有安装 Pandoc，跳过实际转换的检查）');
    return;
  }
  await js(`__zmark.openPath(${JSON.stringify(DOC)}, { force: true, skipConfirm: true })`);
  await wait(300);
  const docx = path.join(dir, '欢迎.docx');
  const r = await js(`__zmark.exportDoc('docx', ${JSON.stringify(docx)})`);
  const okFile = fs.existsSync(docx) && fs.statSync(docx).size > 8000;
  // 用 Pandoc 把生成的 Word 文档读回来，确认标题、公式、表格、图片都在
  let back = '';
  let media = '';
  if (okFile) {
    try {
      back = execFileSync(info.path, ['-f', 'docx', '-t', 'markdown', docx], { encoding: 'utf8', windowsHide: true });
      media = fs.readFileSync(docx).toString('latin1');
    } catch (e) { back = 'ERROR ' + e.message; }
  }
  check(`导出 Word：生成 .docx（Pandoc ${info.version}）`, !!r && r.path === docx && okFile, JSON.stringify(r));
  check('导出 Word：标题、目录、列表、表格与代码都在', /# 欢迎使用 Moyu/.test(back) && /## 快速上手/.test(back) && /# 目录/.test(back) && /1\.\s+点击这段文字/.test(back) && /功能\s+快捷键\s+说明/.test(back) && /function greet\(name\)/.test(back), back.slice(0, 200));
  check('导出 Word：公式是 Word 自带的公式（可读回 TeX）', /\$E = mc\^\{?2\}?\$/.test(back) && /\\sqrt\{\\pi\}/.test(back), (back.match(/\$[^$\n]+\$/) || [''])[0]);
  check('导出 Word：本地图片嵌入到文件中', /word\/media\//.test(media));
  const tex = path.join(dir, '欢迎.tex');
  const r2 = await js(`__zmark.exportDoc('latex', ${JSON.stringify(tex)})`);
  const texSrc = fs.existsSync(tex) ? fs.readFileSync(tex, 'utf8') : '';
  check('导出其他格式：LaTeX', !!r2 && /\\documentclass/.test(texSrc) && /\\section|\\hypertarget|\\subsection/.test(texSrc), texSrc.slice(0, 80));
  const epub = path.join(dir, '欢迎.epub');
  await js(`__zmark.exportDoc('epub', ${JSON.stringify(epub)})`);
  check('导出其他格式：EPUB', fs.existsSync(epub) && fs.statSync(epub).size > 3000);

  // 偏好设置中显示 Pandoc 的检测结果
  await js('__zmark.openPreferences("export")');
  await wait(600);
  const st = await js('(document.querySelector("#pandoc-status") || {}).textContent || ""');
  check('导出设置：显示已找到的 Pandoc 版本', st.includes(info.version), st);
  await key('Escape');
};
