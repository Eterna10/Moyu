// Moyu 端到端自检：npm test（= electron . --self-test）
// 使用真实的鼠标 / 键盘事件驱动编辑器，并输出截图、导出文件和 report.json 到 test-output/
const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');

module.exports = function selfTest(win, { ROOT, app, createWindow, getSettings }) {
  // 打包后应用目录（asar）只读，输出到系统临时目录
  const OUT = app.isPackaged ? path.join(app.getPath('temp'), 'zmark-selftest-output') : path.join(ROOT, 'test-output');
  const DOC_DIR = path.join(OUT, 'doc');
  const DOC = path.join(DOC_DIR, 'test.md');
  const results = [];
  const consoleErrors = [];
  const hostWarnings = [];
  const wc = win.webContents;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => wc.executeJavaScript(code, true);
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 300) });
    console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : '  -> ' + detail}`);
  };
  const shot = async (name) => {
    await wait(250);
    await wc.capturePage(); // 第一次截到的可能还是上一帧
    await wait(60);
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
  };
  const key = async (keyCode, modifiers) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: modifiers || [] });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: modifiers || [] });
    await wait(120);
  };
  const type = async (text) => { wc.insertText(text); await wait(120); };
  const clickAt = async (x, y, clickCount) => {
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: clickCount || 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: clickCount || 1 });
    await wait(200);
  };
  /** 滚动到元素并点击其中心（或指定相对位置） */
  const clickSel = (selector, fx, fy) => clickJs(`document.querySelector(${JSON.stringify(selector)})`, fx, fy);
  const clickJs = async (expr, fx, fy) => {
    // 先等待图表等异步渲染完成并滚动到位，再在点击前重新测量位置，避免布局变化导致点错元素
    const found = await js(`(async () => { await ZMD.whenRendered(); const el = ${expr}; if (!el) return false; el.scrollIntoView({block:'center'}); return true; })()`);
    if (!found) throw new Error('element not found: ' + expr);
    await wait(150);
    const r = await js(`(() => { const b = (${expr}).getBoundingClientRect(); return {x:b.left,y:b.top,w:b.width,h:b.height}; })()`);
    await clickAt(r.x + r.w * (fx === undefined ? 0.5 : fx), r.y + r.h * (fy === undefined ? 0.5 : fy));
  };
  const val = () => js('__zmark.editor.isEditing() ? __zmark.editor.hl.value : null');
  const text = () => js('__zmark.getText()');

  wc.on('render-process-gone', (e, d) => console.log('!! render-process-gone', JSON.stringify(d)));
  wc.on('did-start-navigation', (e) => console.log('!! navigation', e && e.url));
  wc.on('console-message', (...args) => {
    const e = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : { level: args[1], message: args[2] };
    if (e.level === 'error' || e.level === 3) consoleErrors.push(e.message);
    // 宿主层面的插件警告（面板回调、事件、渲染钩子出错）都应视为缺陷
    if (/^\[插件\] /.test(String(e.message))) hostWarnings.push(e.message);
  });

  async function run() {
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(path.join(DOC_DIR, 'assets'), { recursive: true });
    // 测试文档 = 欢迎文档 + 一张本地图片
    const pic = nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png')).resize({ width: 96, height: 96 });
    fs.writeFileSync(path.join(DOC_DIR, 'assets', 'pic.png'), pic.toPNG());
    const sample = fs.readFileSync(path.join(ROOT, 'samples', '欢迎使用 Moyu.md'), 'utf8');
    fs.writeFileSync(DOC, sample.replace('## 快速上手', '本地图片：![logo](assets/pic.png)\n\n## 快速上手'), 'utf8');

    for (let i = 0; i < 100 && !(await js('document.body.dataset.ready === "1"').catch(() => false)); i++) await wait(100);
    check('应用启动完成', await js('document.body.dataset.ready === "1"'));
    await splashStartupCheck();
    await js(`__zmark.openPath(${JSON.stringify(DOC)}, {force:true, skipConfirm:true})`);
    for (let i = 0; i < 50 && !(await js('!!document.querySelector("#write .mermaid-block svg, #write .mermaid-error")')); i++) await wait(200);
    await wait(400); // 等待大纲 / 字数统计的防抖刷新

    // 分组的测试（各自一个文件）。MOYU_TEST_ONLY=名称[,名称] 只运行指定的组，开发时缩短等待；发布前必须运行完整自检
    const T = { js, wc, win, check, wait, key, type, text, val, OUT, DOC, ROOT, shot, app, clickAt };
    const groups = {
      workspace: () => require('./workspace-tests.js')(T),
      export: () => require('./export-tests.js')(T),
      perf: () => perfTests(),
      plugin: () => pluginTests(),
      image: () => imageTests(),
      rich: () => richTests(),
      themefont: () => themeFontTests(),
      update: () => updateTests(),
      feature: () => featureTests(),
      settings: () => settingsTests(),
      settings: () => settingsTests(),
      feature: () => featureTests(),
      rich: () => richTests(),
      tabs: () => require('./tabs-tests.js')(T),
      theme: () => require('./theme-tests.js')(T),
    };
    if (process.env.MOYU_TEST_ONLY) {
      for (const g of process.env.MOYU_TEST_ONLY.split(',')) await groups[g.trim()]();
      return;
    }

    /* ---------- 渲染 ---------- */
    const r = await js(`(() => {
      const w = document.querySelector('#write');
      const img = w.querySelector('img[alt=logo]');
      return {
        h1: w.querySelectorAll('h1').length, h2: w.querySelectorAll('h2').length,
        table: !!w.querySelector('table th'), katex: w.querySelectorAll('.katex').length,
        mermaid: !!w.querySelector('.mermaid-block svg'), mermaidHtml: (w.querySelector('.mermaid-block') || {}).innerHTML, hljs: w.querySelectorAll('.hljs-keyword').length,
        tasks: w.querySelectorAll('input.task-checkbox').length, footnotes: !!document.querySelector('.md-footer .footnotes'),
        front: !!w.querySelector('.front-matter'), toc: w.querySelectorAll('.md-toc a').length,
        mark: !!w.querySelector('mark'), u: !!w.querySelector('u'), del: !!w.querySelector('s, del'),
        img: img ? img.naturalWidth : -1, outline: document.querySelectorAll('.outline-item').length,
        blocks: w.querySelectorAll(':scope > .md-block').length, title: document.title,
        count: document.querySelector('#sb-count').textContent,
      }; })()`);
    check('标题渲染 (h1/h2)', r.h1 === 1 && r.h2 >= 6, JSON.stringify(r));
    check('表格渲染', r.table);
    check('KaTeX 公式渲染', r.katex >= 3, r.katex);
    check('Mermaid 图表渲染', r.mermaid, r.mermaidHtml);
    check('代码高亮', r.hljs > 0, r.hljs);
    check('任务列表复选框', r.tasks === 4, r.tasks);
    check('脚注', r.footnotes);
    check('YAML Front Matter', r.front);
    check('[TOC] 目录', r.toc >= 7, r.toc);
    check('高亮/下划线/删除线', r.mark && r.u && r.del);
    check('本地相对路径图片加载', r.img > 0, r.img);
    check('大纲生成', r.outline === r.h1 + r.h2, r.outline);
    check('字数统计', /字数 \d/.test(r.count), r.count);
    await js('document.querySelector("#content").scrollTop = 0');
    await shot('01-渲染视图.png');

    /* ---------- 点击编辑 ---------- */
    const t0 = await text();
    await clickJs('[...document.querySelectorAll("#write .blk-paragraph p")].find(p => p.textContent.includes("所见即所得"))', 0.3, 0.3);
    let v = await val();
    check('点击段落进入编辑', v && v.includes('所见即所得'), v);
    const caret = await js('__zmark.editor.hl.ta.selectionStart');
    check('点击位置映射到源码光标（非末尾）', caret > 0 && v && caret < v.length, caret + '/' + (v || '').length);
    await js('__zmark.editor.hl.ta.setSelectionRange(__zmark.editor.hl.value.length, __zmark.editor.hl.value.length)');
    await type('追加文字ABC');
    v = await val();
    check('输入文字', v.endsWith('追加文字ABC'), v.slice(-20));
    check('脏标记', await js('__zmark.isDirty()'));
    await shot('02-编辑段落.png');

    /* ---------- 回车拆分 / 新块 / 标题 ---------- */
    await key('Enter');
    v = await val();
    check('回车创建新段落', v === '', JSON.stringify(v));
    await type('## 新加的标题');
    check('编辑中标题字号样式', await js('document.querySelector(".md-editing").classList.contains("edit-h2")'));
    await key('Escape');
    check('Esc 退出并渲染标题', await js('[...document.querySelectorAll("#write h2")].some(h => h.textContent === "新加的标题")'));
    const tAfter = await text();
    check('新标题与上一段之间以空行分隔', tAfter.includes('追加文字ABC\n\n## 新加的标题'), tAfter.slice(0, 400));
    check('大纲实时更新', await (async () => { await wait(400); return js('[...document.querySelectorAll(".outline-item")].some(e => e.textContent === "新加的标题")'); })());

    /* ---------- 撤销 / 重做 ---------- */
    await js('__zmark.runCommand("edit.undo")');
    await wait(150);
    await js('__zmark.runCommand("edit.undo")');
    await wait(150);
    await js('__zmark.runCommand("edit.undo")');
    await wait(150);
    check('撤销恢复原文', (await text()) === t0, (await text()).slice(0, 300));
    await js('__zmark.runCommand("edit.redo")');
    await wait(150);
    check('重做', (await text()) !== t0);
    await js('__zmark.runCommand("edit.undo")');
    await wait(150);

    /* ---------- 列表续写 / 退出 ---------- */
    await js('__zmark.editor.focusEnd()');
    await wait(150);
    await key('Enter');
    await type('- 第一项');
    await key('Enter');
    v = await val();
    check('列表回车续写', v === '- 第一项\n- ', JSON.stringify(v));
    await type('第二项');
    await key('Enter');
    await key('Enter');
    v = await val();
    check('空列表项回车退出列表', v === '', JSON.stringify(v));
    let t = await text();
    check('列表源码正确', /- 第一项\n- 第二项\n*$/.test(t.replace(/\n+$/, '\n')) && !/- \n/.test(t), JSON.stringify(t.slice(-40)));

    /* ---------- 有序列表、引用 ---------- */
    await type('1. 甲');
    await key('Enter');
    v = await val();
    check('有序列表自动编号', v === '1. 甲\n2. ', JSON.stringify(v));
    await key('Enter');
    await type('> 引用一');
    await key('Enter');
    v = await val();
    check('引用续写', v === '> 引用一\n> ', JSON.stringify(v));
    await key('Enter');

    /* ---------- 代码块自动闭合 ---------- */
    await type('```python');
    await key('Enter');
    v = await val();
    check('代码围栏自动闭合', v === '```python\n\n```', JSON.stringify(v));
    await type('print("hi")');
    await key('Escape');
    check('Python 代码块渲染', await js('!!document.querySelector("#write code.language-python .hljs-built_in, #write code.language-python .hljs-string")'));

    /* ---------- 表格 ---------- */
    await js('__zmark.editor.focusEnd()');
    await js('__zmark.runCommand("para.table")');
    await wait(150);
    v = await val();
    check('插入表格模板', /^\| 列1 \| 列2 \| 列3 \|\n\| --- \| --- \| --- \|/.test(v), JSON.stringify(v));
    check('表格编辑时实时预览', await js('!document.querySelector(".md-live-preview").hidden && !!document.querySelector(".md-live-preview table")'));
    await key('Tab');
    const cell = await js('__zmark.editor.hl.ta.selectionStart');
    check('表格 Tab 跳格', cell > 2, cell);
    await key('Escape');

    /* ---------- 公式块实时预览 ---------- */
    await js('__zmark.editor.focusEnd()');
    await js('__zmark.runCommand("para.math")');
    await type('\\frac{a}{b}');
    await wait(350);
    check('公式块实时预览', await js('!!document.querySelector(".md-live-preview .katex")'));
    await shot('03-公式实时预览.png');
    await key('Escape');

    /* ---------- 格式命令 ---------- */
    await js('__zmark.editor.focusEnd()');
    await type('格式测试');
    await js('__zmark.editor.hl.ta.setSelectionRange(0, 4)');
    await js('__zmark.runCommand("fmt.bold")');
    v = await val();
    check('Ctrl+B 加粗', v === '**格式测试**', v);
    await js('__zmark.runCommand("fmt.bold")');
    check('再次 Ctrl+B 取消加粗', (await val()) === '格式测试', await val());
    await js('__zmark.runCommand("para.h3")');
    check('Ctrl+3 设为三级标题', (await val()) === '### 格式测试', await val());
    await js('__zmark.runCommand("para.p")');
    check('Ctrl+0 恢复段落', (await val()) === '格式测试', await val());
    // 通过原生菜单项触发（验证 菜单 → IPC → 渲染进程 的链路）
    const findItem = (items, label) => {
      for (const it of items) {
        if (it.label === label) return it;
        if (it.submenu) { const f = findItem(it.submenu.items, label); if (f) return f; }
      }
      return null;
    };
    const italic = findItem(require('electron').Menu.getApplicationMenu().items, '斜体');
    await js('__zmark.editor.hl.ta.setSelectionRange(0, 4)');
    italic.click(italic, win);
    await wait(250);
    check('菜单「格式→斜体」生效', (await val()) === '*格式测试*', await val());
    check('菜单快捷键绑定', italic.accelerator === 'CmdOrCtrl+I', italic.accelerator);
    await js('__zmark.runCommand("edit.undo")');
    await wait(150);
    await js('__zmark.runCommand("para.task")');
    check('任务列表命令', (await val()) === '- [ ] 格式测试', await val());
    await key('Escape');

    /* ---------- 任务复选框切换 ---------- */
    const before = await text();
    await clickSel('#write input.task-checkbox:not([checked])');
    const after = await text();
    check('点击复选框切换任务状态', before !== after && (after.match(/\[x\]/g) || []).length === (before.match(/\[x\]/g) || []).length + 1);

    /* ---------- 方向键跨块 ---------- */
    await clickSel('#write h1');
    await key('Down');
    v = await val();
    check('↓ 移到下一块', v && !v.startsWith('# '), v && v.slice(0, 30));
    await key('Up');
    v = await val();
    check('↑ 回到上一块', v && v.startsWith('# 欢迎'), v && v.slice(0, 30));
    await key('Escape');

    /* ---------- 源代码模式 ---------- */
    const full = await text();
    await js('__zmark.runCommand("view.source")');
    await wait(300);
    check('切换源代码模式', await js('!document.querySelector("#source").hidden && document.querySelector("#content").hidden && __zmark.source.value === __zmark.getText()'));
    await shot('04-源代码模式.png');
    await js('__zmark.source.ta.focus(); __zmark.source.ta.setSelectionRange(0,0)');
    await type('源码模式输入\n\n');
    await js('__zmark.runCommand("view.source")');
    await wait(300);
    check('切回所见即所得并保留修改', (await text()) === '源码模式输入\n\n' + full);
    await js('__zmark.runCommand("edit.undo")');
    await wait(200);
    check('源码修改可撤销', (await text()) === full);

    /* ---------- 查找替换 ---------- */
    await js('__zmark.editor.commit(); document.querySelector("#content").scrollTop = 0; __zmark.runCommand("edit.replace")');
    await js('const i = document.querySelector("#find-input"); i.value = "Moyu"; i.dispatchEvent(new Event("input"))');
    await wait(300);
    const n = await js('__zmark.find.matches.length');
    check('查找命中', n >= 5, n);
    check('命中项高亮（CSS Highlight）', await js('CSS.highlights.has("zmark-find") && CSS.highlights.get("zmark-find").size > 0'));
    await js('document.querySelector("#find-next").click()');
    await wait(200);
    check('查找定位到编辑块', await js('!!__zmark.editor.hl.findRange && __zmark.editor.isEditing()'));
    await shot('05-查找替换.png');
    await js('document.querySelector("#replace-input").value = "MOYU"; document.querySelector("#replace-all").click()');
    await wait(300);
    const t2 = await text();
    check('全部替换', !t2.includes('Moyu') && t2.includes('MOYU'));
    await js('__zmark.runCommand("edit.undo")');
    await wait(200);
    check('替换可撤销', (await text()) === full);
    await js('document.querySelector("#find-close").click()');

    /* ---------- 主题 ---------- */
    await js('__zmark.runCommand("theme.night")');
    await wait(1200);
    check('夜间主题', await js('document.body.dataset.theme === "night" && getComputedStyle(document.body).backgroundColor === "rgb(31, 33, 36)"'));
    await js('document.querySelector("#content").scrollTop = 600');
    await shot('06-夜间主题.png');
    await js('__zmark.runCommand("theme.newsprint")');
    await wait(800);
    await js('document.querySelector("#content").scrollTop = 0');
    await shot('07-报刊主题.png');
    await js('__zmark.runCommand("theme.github")');
    await wait(500);

    /* ---------- 专注 / 打字机 / 侧边栏 ---------- */
    await js('__zmark.runCommand("view.focus")');
    check('专注模式', await js('document.body.classList.contains("focus-mode")'));
    await js('__zmark.runCommand("view.focus"); __zmark.runCommand("view.files")');
    await wait(200);
    await js(`__zmark.loadFolder(${JSON.stringify(DOC_DIR)})`);
    await wait(300);
    check('文件树显示并标记当前文件', await js('!!document.querySelector(".tree-item.file.current")'));
    await js('__zmark.runCommand("view.sidebar")');
    check('隐藏侧边栏', await js('document.body.classList.contains("no-sidebar")'));
    await js('__zmark.runCommand("view.sidebar"); __zmark.runCommand("view.outline")');

    /* ---------- 保存 ---------- */
    await js('__zmark.save(false, true)');
    await wait(200);
    const disk = fs.readFileSync(DOC, 'utf8');
    check('保存到磁盘且内容一致', disk === (await text()) + '\n');
    check('保存后清除脏标记', !(await js('__zmark.isDirty()')));

    /* ---------- 导出 ---------- */
    const html = await js('__zmark.buildExportHtml(false)');
    fs.writeFileSync(path.join(OUT, 'export.html'), html, 'utf8');
    check('导出 HTML（含公式/图表/高亮）', html.includes('class="katex"') && html.includes('<svg') && html.includes('hljs-keyword') && html.includes('src="assets/pic.png"'));
    const pdfPath = path.join(OUT, 'export.pdf');
    await js(`__zmark.exportDoc('pdf', ${JSON.stringify(pdfPath)})`);
    const pdfOk = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 20000;
    check('导出 PDF', pdfOk, fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 'missing');

    /* ---------- 图片插入规则与上传 ---------- */
    await imageTests();

    /* ---------- 插件系统 ---------- */
    await pluginTests();
    await aiPromptTests();

    /* ---------- 纯文本模式 ---------- */
    await richTests();

    /* ---------- 个性化、在线更新与新功能 ---------- */
    await themeFontTests();
    await updateTests();
    await featureTests();
    await groups.workspace();
    await groups.export();
    await groups.tabs();
    await groups.theme();

    /* ---------- 偏好设置选项 ---------- */
    await settingsTests();

    /* ---------- 大文档性能 ---------- */
    await perfTests();

    /* ---------- 开启动画开关 ---------- */
    await splashWindowTests();

    /* ---------- 深色主题与窄窗口外观 ---------- */
    await visualTests();

    /* ---------- 细节：输入框快捷键、重做、代码块标签 ---------- */
    await polishTests();

    /* ---------- 新建空文档 ---------- */
    await js('__zmark.loadText("", {})');
    await wait(200);
    check('新建文档自动进入编辑', await js('__zmark.editor.isEditing() && __zmark.editor.hl.value === ""'));
    await type('# 新文档');
    await key('Enter');
    await type('正文');
    await key('Escape');
    check('新文档输入', (await text()) === '# 新文档\n\n正文', JSON.stringify(await text()));

    const unexpected = consoleErrors.filter((m) => !/Autofill|DevTools|Electron Security Warning/i.test(m));
    check('渲染进程无错误日志', unexpected.length === 0, unexpected.join(' | '));
    check('插件宿主无异常警告', hostWarnings.length === 0, hostWarnings.join(' | '));
  }

  async function imageTests() {
    const http = require('http');
    const { execSync } = require('child_process');
    const png = fs.readFileSync(path.join(DOC_DIR, 'assets', 'pic.png'));
    const received = [];
    // 模拟 PicGo 桌面版的 HTTP 服务（/upload、/heartbeat）与一个图床
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url.startsWith('/img/')) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); return; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/heartbeat') { res.end(JSON.stringify({ success: true, result: 'alive' })); return; }
        if (req.url === '/upload') {
          const list = (JSON.parse(body || '{}').list) || [];
          received.push(list.map((f) => ({ f, existed: /^https?:/.test(f) || fs.existsSync(f) })));
          res.end(JSON.stringify({ success: true, result: list.map((_, i) => `http://127.0.0.1:${port}/img/up-${received.length}-${i}.png`) }));
          return;
        }
        res.writeHead(404);
        res.end('{}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const set = async (patch) => { await js(`__zmark.setSetting(${JSON.stringify(patch)})`); await wait(80); };
    const ins = (sources) => js(`__zmark.insertImages(${sources})`);
    const srcPic = path.join(OUT, 'outside pic.png');
    fs.writeFileSync(srcPic, png);
    const cnPic = path.join(OUT, '图 1.png');
    fs.writeFileSync(cnPic, png);
    const pastedData = `[{data: new Uint8Array(${JSON.stringify([...png])}), ext: 'png'}]`;

    try {
      // 复制到指定路径（${filename}）+ 添加 ./
      await set({ imageInsertAction: 'copyToCustom', imageCustomPath: './${filename}.assets', imagePreferRelative: true, imageAddDotSlash: true, imageApplyLocal: true, imageEscapeUrl: false });
      let md = await ins(`[{path: ${JSON.stringify(srcPic)}}]`);
      check('图片：复制到指定路径 ${filename}.assets 并添加 ./', md === '![](./test.assets/outside%20pic.png)' && fs.existsSync(path.join(DOC_DIR, 'test.assets', 'outside pic.png')), md);

      // 不对本地图片应用规则
      await set({ imageInsertAction: 'copyToAssets', imageApplyLocal: false, imageAddDotSlash: false });
      md = await ins(`[{path: ${JSON.stringify(srcPic)}}]`);
      check('图片：未勾选「对本地图片应用」时引用原路径', md === '![](../outside%20pic.png)', md);

      // 复制到当前文件夹 + 转义 URL
      await set({ imageInsertAction: 'copyToCurrent', imageApplyLocal: true, imageEscapeUrl: true });
      md = await ins(`[{path: ${JSON.stringify(cnPic)}}]`);
      check('图片：复制到当前文件夹并转义 URL', md === '![](%E5%9B%BE%201.png)' && fs.existsSync(path.join(DOC_DIR, '图 1.png')), md);

      // 网络图片下载到 ./assets
      await set({ imageInsertAction: 'copyToAssets', imageEscapeUrl: false, imageApplyNetwork: true });
      md = await ins(`[{url: '${base}/img/net-image.png'}]`);
      check('图片：网络图片下载到 ./assets', md === '![](assets/net-image.png)' && fs.existsSync(path.join(DOC_DIR, 'assets', 'net-image.png')), md);
      await set({ imageApplyNetwork: false });
      md = await ins(`[{url: '${base}/img/keep.png'}]`);
      check('图片：未勾选「对网络图片应用」时保留原地址', md === `![](${base}/img/keep.png)`, md);

      // PicGo (app) 上传：粘贴的图片与本地图片
      await set({ imageInsertAction: 'upload', uploadService: 'picgo-app', picgoServer: base, picgoPath: '' });
      md = await ins(pastedData);
      check('上传：PicGo (app) 上传粘贴的图片', /^!\[\]\(http:\/\/127\.0\.0\.1:\d+\/img\/up-1-0\.png\)$/.test(md) && received[0] && received[0][0].existed && /zmark-upload/.test(received[0][0].f), md + ' ' + JSON.stringify(received[0]));
      md = await ins(`[{path: ${JSON.stringify(srcPic)}}, {path: ${JSON.stringify(cnPic)}}]`);
      const last = received[received.length - 1] || [];
      check('上传：PicGo (app) 批量上传本地图片', md.split('\n').length === 2 && md.includes('/img/up-2-1.png') && last.length === 2 && last[0].f === srcPic, md);

      // 验证图片上传选项
      const tr = await js('window.zmark.invoke("image:testUpload")');
      check('上传：验证图片上传选项', tr.ok && /^http:\/\/127\.0\.0\.1/.test(tr.url), JSON.stringify(tr));

      // 偏好设置 → 图像 页面
      await js('__zmark.openPreferences("image")');
      await wait(200);
      await js('document.querySelector(".prefs [data-act=test]").click()');
      for (let i = 0; i < 30 && !(await js('!!document.querySelector(".pref-result.ok, .pref-result.fail")')); i++) await wait(100);
      check('偏好设置「图像」页验证按钮', await js('!!document.querySelector(".pref-result.ok")'), await js('(document.querySelector(".pref-result")||{}).textContent'));
      await wait(300);
      await shot('08-图像设置.png');
      await key('Escape');

      // 上传失败时退回本地图片
      await set({ picgoServer: 'http://127.0.0.1:9' });
      md = await ins(pastedData);
      const m = /^!\[\]\((assets\/image-[^)]+\.png)\)$/.exec(md);
      check('上传失败时自动保存为本地图片', m && fs.existsSync(path.join(DOC_DIR, m[1])), md);

      // YAML：typora-copy-images-to: upload
      await set({ imageInsertAction: 'copyToAssets', imageYamlUpload: true, picgoServer: base });
      const yamlDoc = '---\ntypora-copy-images-to: upload\n---\n\n# 图片\n\n![a](assets/pic.png)\n\n<img src="./assets/pic.png" width="40">\n\n![net](https://example.com/a.png)';
      await js(`__zmark.loadText(${JSON.stringify(yamlDoc)}, {filePath: ${JSON.stringify(DOC)}})`);
      await wait(200);
      md = await ins(`[{path: ${JSON.stringify(srcPic)}}]`);
      check('YAML typora-copy-images-to: upload 自动上传', /^!\[\]\(http:\/\/127\.0\.0\.1:\d+\/img\//.test(md), md);

      // 上传所有本地图片
      const n = await js('__zmark.uploadAllLocal()');
      const t = await text();
      check('「上传所有本地图片」替换本地地址', n === 2 && !/\(assets\/pic\.png\)/.test(t) && !/src="\.\/assets/.test(t) && /!\[a\]\(http:\/\/127\.0\.0\.1:\d+\/img\//.test(t) && t.includes('https://example.com/a.png'), t);

      // 命令行上传（PicGo-Core 输出格式 与 自定义命令）
      let hasNode = false;
      try { execSync('node -v', { stdio: 'ignore' }); hasNode = true; } catch (e) { /* 无 node 时跳过 */ }
      if (hasNode) {
        const fake = path.join(OUT, 'fake-uploader.js');
        fs.writeFileSync(fake, [
          "const path = require('path');",
          'const args = process.argv.slice(2);',
          "if (args[0] === 'upload') {",
          "  console.log('[PicGo INFO]: Before transform');",
          "  console.log('[PicGo SUCCESS]: ');",
          "  args.slice(1).forEach((f) => console.log('https://picgo.example.com/' + encodeURIComponent(path.basename(f))));",
          '} else {',
          "  console.log('uploading ' + args.length + ' file(s)...');",
          "  args.forEach((f) => console.log('https://cdn.example.com/' + encodeURIComponent(path.basename(f))));",
          '}',
        ].join('\n'));
        await set({ imageInsertAction: 'upload', imageYamlUpload: false, uploadService: 'picgo-core', picgoCoreCommand: `node "${fake}"` });
        md = await ins(`[{path: ${JSON.stringify(srcPic)}}]`);
        check('上传：PicGo-Core 命令行', md === '![](https://picgo.example.com/outside%20pic.png)', md);
        await set({ uploadService: 'custom', customUploadCommand: `node "${fake}"` });
        md = await ins(`[{path: ${JSON.stringify(srcPic)}}, {path: ${JSON.stringify(cnPic)}}]`);
        check('上传：自定义命令', md === '![](https://cdn.example.com/outside%20pic.png)\n![](https://cdn.example.com/%E5%9B%BE%201.png)', md);
      }
    } finally {
      server.close();
      await set({ imageInsertAction: 'copyToAssets', uploadService: 'picgo-app', picgoServer: 'http://127.0.0.1:36677', imageApplyNetwork: false, imageYamlUpload: false });
    }
  }

  async function pluginTests() {
    const { Menu } = require('electron');
    const menuFind = (label) => {
      const walk = (items) => {
        for (const it of items) {
          if (it.label === label) return it;
          if (it.submenu) { const f = walk(it.submenu.items); if (f) return f; }
        }
        return null;
      };
      return walk(Menu.getApplicationMenu().items);
    };
    const plist = () => js('__zmark.plugins.list().map(p => ({id: p.id, active: p.active, enabled: p.enabled, error: p.error, commands: p.commands}))');

    // 内置插件
    let list = await plist();
    const byId = (id) => list.find((p) => p.id === id) || {};
    check('插件：内置插件「写作目标」「提示块」已激活', byId('writing-goal').active && byId('callout').active, JSON.stringify(list));
    check('插件：状态栏项', /今日 \d+ \/ 1000/.test(await js('(document.querySelector("#sb-plugins .status-item")||{}).textContent || ""')), await js('document.querySelector("#sb-plugins").textContent'));
    check('插件：侧边栏面板页签', await js('!!document.querySelector(".side-tab[data-tab=\\"plugin-writing-goal-stats\\"]")'));
    const pm = menuFind('插件(&X)');
    check('插件：原生「插件」菜单', !!pm && !!menuFind('提示块 Callout') && !!menuFind('写作目标'), pm && pm.submenu.items.map((i) => i.label).join(','));
    const showItem = menuFind('显示写作统计');
    check('插件：命令快捷键注册到菜单', showItem && showItem.accelerator === 'CmdOrCtrl+Alt+W', showItem && showItem.accelerator);

    // 提示块语法
    const calloutDoc = '# 插件演示\n\n> [!NOTE]\n> 这是一条说明，支持 **Markdown**。\n\n> [!WARNING] 自定义标题\n> 小心！\n\n> [!TIP]\n\n> 普通引用不受影响。\n\n正文：今天写了一些字。';
    await js(`__zmark.loadText(${JSON.stringify(calloutDoc)}, {filePath: ${JSON.stringify(DOC)}})`);
    await wait(300);
    const cr = await js(`(() => {
      const w = document.querySelector('#write');
      const q = [...w.querySelectorAll('blockquote')];
      return {
        note: !!w.querySelector('blockquote.callout-note .callout-title') && w.querySelector('blockquote.callout-note .callout-title').textContent.includes('说明'),
        noteBody: (w.querySelector('blockquote.callout-note strong') || {}).textContent,
        markerGone: !w.querySelector('blockquote.callout-note').textContent.includes('[!NOTE]'),
        warnTitle: (w.querySelector('blockquote.callout-warning .callout-title') || {}).textContent,
        tip: !!w.querySelector('blockquote.callout-tip .callout-title'),
        plain: q.filter(b => !b.classList.contains('callout')).length,
        color: getComputedStyle(w.querySelector('blockquote.callout-warning')).borderLeftColor,
      }; })()`);
    check('提示块插件：渲染 NOTE（标题、正文、隐藏标记）', cr.note && cr.noteBody === 'Markdown' && cr.markerGone, JSON.stringify(cr));
    check('提示块插件：自定义标题 / 仅标记行 / 普通引用', /自定义标题/.test(cr.warnTitle) && cr.tip && cr.plain === 1, JSON.stringify(cr));
    check('提示块插件：文档样式生效', cr.color === 'rgb(154, 103, 0)', cr.color);

    // 插件命令（通过原生菜单触发）
    await js('__zmark.editor.focusEnd()');
    await wait(100);
    const insItem = menuFind('插入「说明」提示块');
    insItem.click(insItem, win);
    await wait(250);
    let v = await val();
    check('提示块插件：菜单命令插入提示块', v === '> [!NOTE]\n> ' && insItem.accelerator === 'CmdOrCtrl+Alt+N', JSON.stringify(v));
    await type('通过命令插入');
    await key('Escape');
    check('提示块插件：插入后渲染', await js('[...document.querySelectorAll("blockquote.callout-note")].some(b => b.textContent.includes("通过命令插入"))'));

    // 写作目标：输入计入今日字数，面板统计（先等上一次输入的防抖刷新落定：连续两次读数相同）
    for (let i = 0, prev = null; i < 20; i++) {
      await wait(300);
      const cur = await js('document.querySelector("#sb-plugins .status-item").textContent');
      if (cur === prev) break;
      prev = cur;
    }
    const before = await js('parseInt(document.querySelector("#sb-plugins .status-item").textContent.match(/今日 (\\d+)/)[1], 10)');
    await clickJs('[...document.querySelectorAll("#write p")].find(p => p.textContent.startsWith("正文"))');
    await type('新增十个汉字用于测试');
    // 插件在停止输入约 250ms 后统计（防抖），机器繁忙时可能更晚，轮询等待最多 3 秒
    const todayCount = () => js('parseInt(document.querySelector("#sb-plugins .status-item").textContent.match(/今日 (\\d+)/)[1], 10)');
    let after = await todayCount();
    for (let i = 0; i < 30 && after - before < 10; i++) { await wait(100); after = await todayCount(); }
    check('写作目标插件：输入计入今日字数', after - before === 10, `${before} -> ${after}；段落：${await val()}`);
    await key('Escape');
    await js('__zmark.runCommand("plugin:writing-goal:show")');
    await wait(300);
    const panel = await js(`(() => { const p = document.querySelector('#panel-plugin-writing-goal-stats');
      return { active: p.classList.contains('active'), ring: !!p.querySelector('.wg-ring svg'), cells: p.querySelectorAll('.wg-cell').length,
        headings: [...p.querySelectorAll('.wg-cell')].find(c => c.textContent.includes('标题')).querySelector('b').textContent,
        bars: p.querySelectorAll('.wg-chart rect').length }; })()`);
    check('写作目标插件：统计面板', panel.active && panel.ring && panel.cells === 10 && panel.headings === '1' && panel.bars === 7, JSON.stringify(panel));
    await js('document.querySelector("#content").scrollTop = 0');
    await shot('09-插件示例.png');

    // 用户插件目录：正常插件 / activate 抛错 / 语法错误
    const udir = path.join(app.getPath('userData'), 'plugins');
    const mk = (name, manifest, code) => {
      fs.mkdirSync(path.join(udir, name), { recursive: true });
      fs.writeFileSync(path.join(udir, name, 'plugin.json'), JSON.stringify(manifest));
      fs.writeFileSync(path.join(udir, name, 'main.js'), code);
    };
    mk('hello', { id: 'test-hello', name: '测试插件', version: '0.1.0' }, [
      'Moyu.definePlugin({',
      '  activate(ctx) {',
      "    ctx.markdown.addFence('hello', (code) => '<p class=\"hello-out\">你好，' + ctx.utils.escapeHtml(code.trim()) + '！</p>');",
      "    ctx.commands.register('stamp', () => ctx.editor.insertText('HELLO-STAMP'), { title: '插入测试戳', accelerator: 'CmdOrCtrl+B' });",
      "    ctx.workspace.onWillSave((text) => text.replace('{{SAVE}}', 'SAVED-BY-PLUGIN'));",
      "    ctx.storage.set('runs', ctx.storage.get('runs', 0) + 1);",
      '    window.__helloActive = true;',
      '  },',
      '  deactivate() { window.__helloActive = false; },',
      '});',
    ].join('\n'));
    mk('broken', { id: 'test-broken', name: '会出错的插件' }, "Moyu.definePlugin({ activate() { throw new Error('故意的错误'); } });");
    mk('syntax', { id: 'test-syntax', name: '语法错误插件' }, 'Moyu.definePlugin({ activate( {');
    mk('legacy', { id: 'test-legacy', name: '旧名插件' }, 'ZMark.definePlugin({ activate(ctx) { window.__legacyActive = ctx.apiVersion; } });');
    mk('nodef',{ id: 'test-nodef', name: '未定义插件' }, 'window.__nodef = 1;');
    list = await js('__zmark.runCommand("plugins.reload").then(l => l.map(p => ({id: p.id, active: p.active, error: p.error})))');
    await wait(200);
    check('用户插件：加载并激活', byIdIn(list, 'test-hello').active && (await js('window.__helloActive === true')), JSON.stringify(list));
    check('用户插件：activate 抛错被隔离并报告', /故意的错误/.test(byIdIn(list, 'test-broken').error || ''), JSON.stringify(byIdIn(list, 'test-broken')));
    check('用户插件：脚本语法错误被捕获', !!byIdIn(list, 'test-syntax').error && !byIdIn(list, 'test-syntax').active, JSON.stringify(byIdIn(list, 'test-syntax')));
    check('用户插件：未调用 definePlugin 时报错', /definePlugin/.test(byIdIn(list, 'test-nodef').error || ''), JSON.stringify(byIdIn(list, 'test-nodef')));
    check('兼容旧名：使用 ZMark.definePlugin 的插件仍可加载', byIdIn(list, 'test-legacy').active && (await js('window.__legacyActive === 1')), JSON.stringify(byIdIn(list, 'test-legacy')));
    check('插件出错不影响其它插件', byIdIn(list, 'writing-goal').active && byIdIn(list, 'callout').active);
    await js(`__zmark.loadText(${JSON.stringify('```hello\nMoyu\n```\n\n{{SAVE}}')}, {filePath: ${JSON.stringify(DOC)}})`);
    await wait(300);
    check('用户插件：自定义代码块语言', (await js('(document.querySelector("#write .hello-out")||{}).textContent')) === '你好，Moyu！');
    const stamp = menuFind('插入测试戳');
    check('用户插件：与内置快捷键冲突的快捷键被忽略', stamp && !stamp.accelerator && menuFind('加粗').accelerator === 'CmdOrCtrl+B', stamp && stamp.accelerator);
    await js('__zmark.editor.focusEnd()');
    await js('__zmark.runCommand("plugin:test-hello:stamp")');
    await wait(150);
    check('用户插件：执行命令', (await val() || '').endsWith('HELLO-STAMP'), await val());
    await key('Escape');
    await js('__zmark.save(false, true)');
    await wait(300);
    check('用户插件：onWillSave 改写保存内容', fs.readFileSync(DOC, 'utf8').includes('SAVED-BY-PLUGIN') && (await text()).includes('SAVED-BY-PLUGIN'));
    const store = path.join(app.getPath('userData'), 'plugin-data', 'test-hello.json');
    await wait(500);
    check('用户插件：storage 持久化', fs.existsSync(store) && JSON.parse(fs.readFileSync(store, 'utf8')).runs >= 1);

    // 偏好设置 → 插件 页面
    await js('__zmark.openPreferences("plugins")');
    await wait(300);
    const cards = await js('[...document.querySelectorAll(".plugin-card")].map(c => c.className)');
    check('插件管理页列出全部插件与状态', cards.length === 7 && cards.filter((c) => c.includes('err')).length === 3, JSON.stringify(cards));
    await shot('10-插件管理.png');
    // 在管理页停用测试插件
    await js('document.querySelector("input[data-plugin=\\"test-hello\\"]").click()');
    for (let i = 0; i < 30 && (await js('window.__helloActive')); i++) await wait(100);
    await wait(300);
    check('停用插件：deactivate 被调用', (await js('window.__helloActive')) === false);
    check('停用插件：语法扩展与菜单命令被移除', !(await js('!!document.querySelector("#write .hello-out")')) && !menuFind('插入测试戳'));
    await key('Escape');
    await js('window.zmark.invoke("plugins:setEnabled", "test-hello", true)');

    // 导出包含插件文档样式
    await js(`__zmark.loadText(${JSON.stringify(calloutDoc)}, {filePath: ${JSON.stringify(DOC)}})`);
    const html = await js('__zmark.buildExportHtml(false)');
    check('导出 HTML 包含插件渲染结果与样式', html.includes('class="callout callout-note"') && html.includes('blockquote.callout'));

    // 帮助 → 插件开发指南（应用内打开，示例提示块由插件渲染）
    await js('__zmark.loadText("", {})');
    await js('__zmark.runCommand("help.pluginGuide")');
    await wait(500);
    check('插件开发指南可在应用内打开', (await text()).startsWith('# Moyu 插件开发指南') && (await js('!!document.querySelector("#write blockquote.callout-warning")')));
  }
  const byIdIn = (list, id) => list.find((p) => p.id === id) || {};

  /** 一键提示词：内容覆盖插件系统真实提供的全部接口；界面可填写功能、套用示例、复制 */
  async function aiPromptTests() {
    const { Menu, clipboard } = require('electron');
    // 临时插件记录 ctx 的真实结构
    const udir = path.join(app.getPath('userData'), 'plugins', 'ctxdump');
    fs.mkdirSync(udir, { recursive: true });
    fs.writeFileSync(path.join(udir, 'plugin.json'), JSON.stringify({ id: 'test-ctxdump', name: '接口结构' }));
    fs.writeFileSync(path.join(udir, 'main.js'), "Moyu.definePlugin({ activate(ctx) { const o = {}; for (const k of Object.keys(ctx)) o[k] = ctx[k] && typeof ctx[k] === 'object' && k !== 'manifest' ? Object.keys(ctx[k]) : typeof ctx[k]; window.__ctxShape = o; } });");
    await js('__zmark.runCommand("plugins.reload")');
    await wait(300);
    const shape = await js('window.__ctxShape');
    const prompt = await js('ZAIPrompt.build("在状态栏显示测试功能", { version: "1.6.1", apiVersion: 1 })');
    const missing = [];
    for (const [k, v] of Object.entries(shape || {})) {
      if (!prompt.includes('ctx.' + k)) missing.push('ctx.' + k);
      if (Array.isArray(v)) for (const sub of v) if (!prompt.includes(sub + '(')) missing.push(`ctx.${k}.${sub}`);
    }
    check('一键提示词：覆盖插件系统真实提供的全部接口', shape && Object.keys(shape).length > 10 && !missing.length, missing.join(', ') || JSON.stringify(shape));
    check('一键提示词：包含功能描述、清单格式、入口约束与输出要求', prompt.includes('在状态栏显示测试功能') && prompt.includes('"apiVersion": 1') && prompt.includes('Moyu.definePlugin') && prompt.includes('# 六、输出格式') && prompt.includes('para.table'));
    fs.rmSync(udir, { recursive: true, force: true });
    await js('__zmark.runCommand("plugins.reload")');
    await wait(300);

    // 界面：偏好设置 → 插件 → 一键提示词
    await js('__zmark.openPreferences("plugins")');
    await wait(300);
    check('一键提示词：按钮位于「插件开发指南」旁', await js('(() => { const a = document.querySelector(".prefs [data-act=plugin-guide]"), b = document.querySelector(".prefs [data-act=plugin-ai]"); return !!a && !!b && a.parentElement === b.parentElement; })()'));
    await js('document.querySelector(".prefs [data-act=plugin-ai]").click()');
    await wait(300);
    await js('document.querySelector(".ai-modal [data-act=copy]").click()');
    await wait(150);
    check('一键提示词：未填写功能时提示先描述', (await js('document.activeElement === document.querySelector(".ai-feature")')));
    await js('document.querySelector(".ai-modal [data-ex=\\"0\\"]").click()');
    await wait(150);
    const ui = await js('({ feature: document.querySelector(".ai-feature").value, prompt: document.querySelector(".ai-prompt").value })');
    check('一键提示词：点击示例填入功能描述并更新提示词', /番茄|倒计时/.test(ui.feature) && ui.prompt.includes(ui.feature), ui.feature.slice(0, 40));
    await shot('24-一键提示词.png');
    await js('document.querySelector(".ai-modal [data-act=copy]").click()');
    await wait(300);
    const copied = String(await clipboard.readText());
    check('一键提示词：复制到剪贴板', copied === ui.prompt, copied.slice(0, 40));
    await key('Escape');
    const walk = (items) => { for (const it of items) { if (it.label === '一键提示词（用 AI 生成插件）…') return true; if (it.submenu && walk(it.submenu.items)) return true; } return false; };
    check('一键提示词：「插件」菜单与命令面板中可用', walk(Menu.getApplicationMenu().items) && (await js('ZExtras.COMMANDS.some(c => c[0] === "plugins.aiPrompt")')));
  }

  /** 启动时的开启动画：显示图标、编辑器就绪后淡出并移除、不阻挡点击 */
  async function splashStartupCheck() {
    const st = await js(`({ on: document.documentElement.classList.contains('splash-on'), visible: !!document.getElementById('splash') && getComputedStyle(document.getElementById('splash')).display === 'flex',
      logo: (document.querySelector('.splash-logo') || {}).naturalWidth || 0, pe: document.getElementById('splash') ? getComputedStyle(document.getElementById('splash')).pointerEvents : '' })`);
    if (st.visible) await shot('00-开启动画.png');
    check('开启动画：启动时显示软件图标', st.on && st.visible && st.logo > 0, JSON.stringify(st));
    check('开启动画：不阻挡鼠标操作', st.pe === 'none', st.pe);
    for (let i = 0; i < 40 && (await js('!!document.getElementById("splash")')); i++) await wait(100);
    check('开启动画：编辑器就绪后自动淡出并移除', !(await js('!!document.getElementById("splash")')) && !(await js('document.documentElement.classList.contains("splash-on")')));
  }

  /** 设置开关：关闭后不显示；新建窗口不重复播放 */
  async function splashWindowTests() {
    const probe = async (w) => {
      for (let i = 0; i < 100 && !(await w.webContents.executeJavaScript('document.body.dataset.ready === "1"').catch(() => false)); i++) await wait(100);
      const r = await w.webContents.executeJavaScript(`({ query: location.search, on: document.documentElement.classList.contains('splash-on') || !!window.__splash })`);
      w.forceClose = true;
      w.destroy();
      return r;
    };
    await js('__zmark.setSetting({ showSplash: true })');
    await wait(200);
    const again = await probe(createWindow());
    check('开启动画：新建窗口不重复播放', !again.on && !/splash=1/.test(again.query), JSON.stringify(again));
    await js('__zmark.setSetting({ showSplash: false })');
    await wait(200);
    check('开启动画：设置中可关闭', getSettings().showSplash === false);
    await js('__zmark.openPreferences("general")');
    await wait(200);
    check('开启动画：偏好设置「通用」中有开关', await js('!!document.querySelector(".prefs [data-k=showSplash]") && document.querySelector(".prefs [data-k=showSplash]").checked === false'));
    await key('Escape');
    await js('__zmark.setSetting({ showSplash: true })');
  }

  /** 生成测试图片：kind = light（浅色平坦）/ dark（深色杂乱）/ blue（饱和蓝色渐变） */
  function makeImage(file, kind) {
    const W = 96;
    const buf = Buffer.alloc(W * W * 4);
    for (let i = 0; i < W * W; i++) {
      const x = i % W;
      const y = Math.floor(i / W);
      let r; let g; let b;
      if (kind === 'light') { r = g = b = 244; } else if (kind === 'dark') { const n = ((x * 37 + y * 91) % 97) * 1.6; r = g = b = (x + y) % 7 < 3 ? 20 : 20 + n; } else { r = 30 + x; g = 80 + y; b = 230; }
      buf[i * 4] = b; buf[i * 4 + 1] = g; buf[i * 4 + 2] = r; buf[i * 4 + 3] = 255; // BGRA
    }
    fs.writeFileSync(file, nativeImage.createFromBitmap(buf, { width: W, height: W }).toPNG());
    return file;
  }

  async function themeFontTests() {
    const set = async (patch) => { await js(`__zmark.setSetting(${JSON.stringify(patch)})`); await wait(500); };
    const imp = async (file) => js(`window.zmark.invoke('theme:import', ${JSON.stringify(file)})`);
    const sample = fs.readFileSync(path.join(ROOT, 'samples', '欢迎使用 Moyu.md'), 'utf8');
    await js(`__zmark.loadText(${JSON.stringify(sample)}, {filePath: ${JSON.stringify(DOC)}})`);
    await wait(400);

    // 背景图片：导入后复制到数据目录
    const light = await imp(makeImage(path.join(OUT, 'bg-light.png'), 'light'));
    const dark = await imp(makeImage(path.join(OUT, 'bg-dark.png'), 'dark'));
    const blue = await imp(makeImage(path.join(OUT, 'bg-blue.png'), 'blue'));
    check('主题：导入图片作为背景（复制到数据目录）', light.type === 'image' && fs.existsSync(light.path) && /backgrounds/.test(light.path), JSON.stringify(light));
    const overlayOf = () => js('({ has: document.body.classList.contains("has-bg"), op: Number(document.querySelector("#bg-overlay").style.opacity), img: document.querySelector("#bg-image").style.backgroundImage, info: __zmark.state.themeInfo })');
    await set({ theme: 'github', bgImage: light.path, bgOpacityAuto: true });
    const oLight = await overlayOf();
    await set({ bgImage: dark.path });
    const oDark = await overlayOf();
    check('主题：设置背景后显示背景层', oLight.has && /bg-light/.test(oLight.img), JSON.stringify(oLight));
    check('主题：自动透明度——深色杂乱图片的遮罩比浅色平坦图片更浓', oDark.op > oLight.op + 0.2 && oLight.op >= 0.45 && oDark.op <= 0.94, `${oLight.op} / ${oDark.op}`);
    await set({ theme: 'night' });
    const oDarkNight = await overlayOf();
    check('主题：切换到深色主题后自动重新计算（深色图片配深色主题遮罩更淡）', oDarkNight.op < oDark.op, `${oDark.op} → ${oDarkNight.op}`);
    await set({ theme: 'github', bgOpacityAuto: false, bgOverlay: 0.3 });
    check('主题：手动遮罩浓度', Math.abs((await overlayOf()).op - 0.3) < 0.01);
    await set({ bgOpacityAuto: true, bgImage: blue.path, accentColor: 'auto', bgPanels: true, bgBlur: 4 });
    const ac = await js('({ accent: getComputedStyle(document.body).getPropertyValue("--accent").trim(), sidebar: getComputedStyle(document.querySelector("#sidebar")).backgroundColor, blur: document.querySelector("#bg-image").style.filter })');
    const rgb = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(ac.accent);
    check('主题：强调色取自背景图片（蓝色图片 → 蓝色强调色）', rgb && parseInt(rgb[3], 16) > parseInt(rgb[1], 16) + 40, ac.accent);
    check('主题：侧边栏半透明、背景模糊', /(,|\/)\s*0?\.\d+\)$/.test(ac.sidebar) && ac.blur === 'blur(4px)', JSON.stringify(ac));
    await set({ accentColor: '#c0392b' });
    check('主题：自定义强调色（按浅色主题调整对比度）', /^#[0-9a-f]{6}$/i.test(await js('getComputedStyle(document.body).getPropertyValue("--accent").trim()')));
    await set({ customCss: '.markdown-body h1 { color: rgb(1, 2, 3); }' });
    check('主题：自定义 CSS', (await js('getComputedStyle(document.querySelector("#write h1")).color')) === 'rgb(1, 2, 3)');

    // 主题包：手工写一个 .moyutheme（含内嵌背景图片）后导入
    const pkgFile = path.join(OUT, '测试主题.moyutheme');
    fs.writeFileSync(pkgFile, JSON.stringify({ format: 'moyu-theme', version: 1, name: '测试主题', settings: { theme: 'midnight', accentColor: '#22aa88', bgOverlay: 0.5 }, background: { ext: 'png', data: 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, 'bg-blue.png')).toString('base64') } }));
    const pkg = await imp(pkgFile);
    check('主题：导入主题包（含背景图片）', pkg.type === 'package' && pkg.settings.theme === 'midnight' && fs.existsSync(pkg.settings.bgImage), JSON.stringify(pkg).slice(0, 200));
    await js('__zmark.openPreferences("theme")');
    await wait(500);
    await shot('18-主题与背景设置.png');
    await key('Escape');
    await set({ theme: 'github', accentColor: 'auto', customCss: '', bgBlur: 0 });
    await js('document.querySelector("#content").scrollTop = 0');
    await wait(300);
    await shot('19-背景图片.png');

    // 字体：导入系统中的字体文件
    const fontSrc = ['consola.ttf', 'arial.ttf', 'times.ttf'].map((f) => path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', f)).find((f) => fs.existsSync(f));
    if (fontSrc) {
      fs.mkdirSync(path.join(app.getPath('userData'), 'fonts'), { recursive: true });
      fs.copyFileSync(fontSrc, path.join(app.getPath('userData'), 'fonts', path.basename(fontSrc)));
      await js('__zmark.refreshFonts()');
      const fonts = await js('__zmark.state.fonts');
      const f = fonts[0];
      check('字体：导入字体文件并读取字体名称', f && /Consolas|Arial|Times/.test(f.name) && f.format === 'truetype', JSON.stringify(f));
      await set({ fontFamily: 'font:' + f.family, codeFont: 'font:' + f.family });
      await js(`document.fonts.load('16px "${f.family}"')`);
      const ff = await js(`({ p: getComputedStyle(document.querySelector('#write p')).fontFamily, code: getComputedStyle(document.querySelector('#write pre code')).fontFamily, ui: getComputedStyle(document.querySelector('#statusbar')).fontFamily, loaded: document.fonts.check('16px "${f.family}"') })`);
      check('字体：正文与代码使用导入的字体，界面不受影响', ff.p.includes(f.family) && ff.code.includes(f.family) && !ff.ui.includes(f.family) && ff.loaded, JSON.stringify(ff));
      const html = await js('__zmark.buildExportHtml(false)');
      check('字体：导出 HTML 内嵌字体', html.includes(`font-family:"${f.family}";src:url("data:font/ttf;base64,`));
      await js(`window.zmark.invoke('font:remove', ${JSON.stringify(f.file)})`);
      await set({ fontFamily: 'default', codeFont: 'default' });
      await js('__zmark.refreshFonts()');
    }
    await set({ bgImage: '', accentColor: '' });
    check('主题：移除背景', !(await js('document.body.classList.contains("has-bg")')));
  }

  async function updateTests() {
    const http = require('http');
    const crypto = require('crypto');
    const payload = crypto.randomBytes(300 * 1024);
    const sha = 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex');
    // 增量更新包：最小的 asar 程序包（格式与 @electron/asar 相同），gzip 压缩
    const zlib = require('zlib');
    const makeAsar = (files) => {
      const header = { files: {} };
      const bufs = [];
      let offset = 0;
      for (const [p, content] of Object.entries(files)) {
        const b = Buffer.from(content);
        const parts = p.split('/');
        let node = header;
        for (const d of parts.slice(0, -1)) { node.files[d] = node.files[d] || { files: {} }; node = node.files[d]; }
        node.files[parts[parts.length - 1]] = { size: b.length, offset: String(offset) };
        offset += b.length;
        bufs.push(b);
      }
      const json = Buffer.from(JSON.stringify(header));
      const padded = json.length + ((4 - (json.length % 4)) % 4);
      const hp = Buffer.alloc(8 + padded);
      hp.writeUInt32LE(4 + padded, 0);
      hp.writeUInt32LE(json.length, 4);
      json.copy(hp, 8);
      const sp = Buffer.alloc(8);
      sp.writeUInt32LE(4, 0);
      sp.writeUInt32LE(hp.length, 4);
      return Buffer.concat([sp, hp, ...bufs]);
    };
    const patchOf = (version) => zlib.gzipSync(makeAsar({ 'package.json': JSON.stringify({ name: 'moyu', version }), 'src/main/main.js': '// main', 'src/renderer/index.html': '<!doctype html>' }));
    const patches = { good: patchOf('9.9.9'), bad: patchOf('1.2.3') };
    const patchName = `Moyu-9.9.9-app-electron-${process.versions.electron}.asar.gz`;
    const shaOf = (b) => 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');
    let mode = 'newer';
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/dl/')) {
        const body = /\.asar\.gz$/.test(req.url) ? patches[mode === 'badpatch' ? 'bad' : 'good'] : payload;
        res.writeHead(200, { 'Content-Length': body.length });
        res.end(body);
        return;
      }
      if (mode === '404') { res.writeHead(404); res.end('{}'); return; }
      const tag = mode === 'same' ? 'v1.0.0' : 'v9.9.9';
      const asset = (name) => ({ name, size: payload.length, browser_download_url: `http://127.0.0.1:${port}/dl/${name}`, digest: mode === 'tampered' ? 'sha256:' + '0'.repeat(64) : sha });
      const patch = (name, b) => ({ name, size: b.length, browser_download_url: `http://127.0.0.1:${port}/dl/${name}`, digest: shaOf(b) });
      const pb = patches[mode === 'badpatch' ? 'bad' : 'good'];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ tag_name: tag, name: 'Moyu ' + tag, body: '## 新功能\n\n- 测试更新说明', html_url: 'https://github.com/Eterna10/Moyu/releases/tag/' + tag, published_at: '2026-11-10T00:00:00Z',
        assets: [patch('Moyu-9.9.9-app-electron-1.0.0.asar.gz', pb), asset('Moyu-Setup-9.9.9.exe'), asset('Moyu-9.9.9-Portable.exe'), patch(patchName, pb)] }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    process.env.MOYU_UPDATE_API = `http://127.0.0.1:${port}`;

    // 增量更新：只下载 app.asar 更新包，退出后由辅助脚本替换
    async function patchTests() {
      const ofs = require('original-fs');
      const { spawn } = require('child_process');
      const updater = require(path.join(ROOT, 'src', 'main', 'updater.js'));
      const pdir = path.join(app.getPath('temp'), 'moyu-patch-test');
      ofs.rmSync(pdir, { recursive: true, force: true });
      ofs.mkdirSync(pdir, { recursive: true });
      mode = 'newer';
      let r = await js("window.zmark.invoke('update:check')");
      check('增量更新：未指定可写的程序目录时不提供更新包', r.ok && !r.patch && !!r.asset);
      process.env.MOYU_PATCH_DIR = pdir;
      try {
        r = await js("window.zmark.invoke('update:check')");
        check('增量更新：只选择与本机 Electron 版本一致的更新包', !!r.patch && r.patch.name === patchName && !!r.asset, JSON.stringify(r.patch));

        // 对话框：优先下载增量更新包，完成后「重启并更新」
        await js('__zmark.runCommand("help.checkUpdate")');
        await wait(600);
        check('增量更新：对话框显示更新包大小', /增量更新/.test(await js('document.querySelector(".update-modal .update-pkg").textContent')));
        await js('document.querySelector(".update-modal [data-act=download]").click()');
        for (let i = 0; i < 50 && !(await js('/校验通过|失败/.test((document.querySelector(".update-progress span")||{}).textContent || "")')); i++) await wait(100);
        const btn = await js('document.querySelector(".update-modal [data-act=download]").textContent');
        check('增量更新：下载并校验后显示「重启并更新」', btn === '重启并更新', btn);
        await shot('26-增量更新.png');
        await js('document.querySelector(".update-modal [data-act=download]").click()');
        await wait(500);
        const staged = path.join(pdir, 'app-update.asar');
        const pkg = ofs.existsSync(staged) && updater.asarPackage(ofs.readFileSync(staged));
        check('增量更新：解压并校验后放到程序目录等待替换', !!pkg && pkg.version === '9.9.9' && !(await js('!!document.querySelector(".update-modal")')), JSON.stringify(pkg));

        // 内容不对（版本号不符）的更新包：拒绝，并改为提供完整安装包
        mode = 'badpatch';
        ofs.rmSync(staged, { force: true });
        await js('__zmark.runCommand("help.checkUpdate")');
        await wait(600);
        await js('document.querySelector(".update-modal [data-act=download]").click()');
        for (let i = 0; i < 50 && !(await js('/校验通过|失败/.test((document.querySelector(".update-progress span")||{}).textContent || "")')); i++) await wait(100);
        await js('document.querySelector(".update-modal [data-act=download]").click()');
        await wait(500);
        const fb = await js('({ btn: document.querySelector(".update-modal [data-act=download]").textContent, msg: document.querySelector(".update-progress span").textContent, meta: document.querySelector(".update-modal .update-pkg").textContent })');
        check('增量更新：更新包内容无效时拒绝，改为提供完整安装包', fb.btn === '下载完整安装包' && /内容无效/.test(fb.msg) && /Moyu-(Setup-)?9\.9\.9(-Portable)?\.exe/.test(fb.meta) && !ofs.existsSync(staged), JSON.stringify(fb));
        await key('Escape');
        await js("window.zmark.invoke('update:cancel')");
      } finally {
        delete process.env.MOYU_PATCH_DIR;
        mode = 'newer';
      }

      // 辅助脚本：等待 Moyu 进程结束后替换 app.asar
      const dst = path.join(pdir, 'app.asar');
      const src = path.join(pdir, 'app-update.asar');
      ofs.writeFileSync(dst, 'OLD');
      ofs.writeFileSync(src, 'NEW');
      const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
      const dummy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 800)'], { env, stdio: 'ignore' });
      let dummyExit = 0;
      dummy.on('exit', () => { dummyExit = Date.now(); });
      const helper = spawn(process.execPath, [updater.writeHelper(), String(dummy.pid), src, dst, path.join(pdir, 'log.txt')], { env, stdio: 'ignore' });
      const helperExit = await new Promise((r) => helper.on('exit', () => r(Date.now())));
      const swapped = ofs.existsSync(dst) && ofs.readFileSync(dst, 'utf8') === 'NEW' && !ofs.existsSync(src) && !ofs.existsSync(dst + '.old');
      check('增量更新：辅助脚本等进程退出后替换 app.asar', swapped && dummyExit > 0 && helperExit >= dummyExit, JSON.stringify({ swapped, wait: helperExit - dummyExit }));
      ofs.rmSync(pdir, { recursive: true, force: true });
    }
    try {
      let r = await js("window.zmark.invoke('update:check')");
      // 便携版应选择 Portable 安装包，安装版与开发模式选择 Setup 安装包
      const assetName = r.kind === 'portable' ? 'Moyu-9.9.9-Portable.exe' : 'Moyu-Setup-9.9.9.exe';
      check(`更新：检查到新版本并选择对应安装包（${r.kind}）`, r.ok && r.newer && r.latest === '9.9.9' && r.asset && r.asset.name === assetName, JSON.stringify(r).slice(0, 200));
      await js('__zmark.runCommand("help.checkUpdate")');
      await wait(600);
      check('更新：对话框显示版本与更新说明', await js('!!document.querySelector(".update-modal") && document.querySelector(".update-modal").textContent.includes("9.9.9") && !!document.querySelector(".update-notes h2")'));
      await js('document.querySelector(".update-modal [data-act=download]").click()');
      for (let i = 0; i < 50 && !(await js('/校验通过|失败/.test((document.querySelector(".update-progress span")||{}).textContent || "")')); i++) await wait(100);
      const st = await js('({ msg: document.querySelector(".update-progress span").textContent, btn: document.querySelector(".update-modal [data-act=download]").textContent, bar: document.querySelector(".update-progress i").style.width })');
      const dl = path.join(app.getPath('temp'), 'moyu-update', assetName);
      check('更新：下载并通过 SHA-256 校验', /SHA-256 校验通过/.test(st.msg) && fs.existsSync(dl) && fs.statSync(dl).size === payload.length && st.bar === '100%', JSON.stringify(st));
      check('更新：下载完成后状态栏恢复为「新版本」', await js('document.querySelector("#sb-update").dataset.state') === 'newer');
      await shot('20-检查更新.png');
      await key('Escape');
      fs.rmSync(dl, { force: true });
      mode = 'tampered';
      r = await js("window.zmark.invoke('update:check')");
      const err = await js(`window.zmark.invoke('update:download', ${JSON.stringify(r.asset)}).then(() => 'ok', (e) => e.message)`);
      check('更新：校验值不符时拒绝并删除文件', /校验失败/.test(err) && !fs.existsSync(dl) && !fs.existsSync(dl + '.part'), err);
      mode = 'same';
      r = await js("window.zmark.invoke('update:check')");
      check('更新：已是最新版本', r.ok && !r.newer);
      mode = '404';
      r = await js("window.zmark.invoke('update:check')");
      check('更新：仓库没有发布版本时给出提示', !r.ok && /还没有发布版本/.test(r.error), r.error);

      // 启动时的自动检查（静默模式）：状态栏显示检查状态与结果
      const badge = () => js('({ st: document.querySelector("#sb-update").dataset.state, text: document.querySelector("#sb-update").textContent, hidden: document.querySelector("#sb-update").hidden, modal: !!document.querySelector(".update-modal") })');
      const autoCheck = async () => { const b = await js('(() => { const p = __zmark.extras.checkUpdate(true); window.__uc = p; return document.querySelector("#sb-update").dataset.state; })()'); await js('window.__uc.then(() => 1)'); await wait(100); return b; };
      mode = 'same';
      const during = await autoCheck();
      let b = await badge();
      check('更新：自动检查时状态栏显示「正在检查」', during === 'checking');
      check('更新：已是最新时状态栏显示「已是最新」且不弹窗', b.st === 'latest' && /已是最新/.test(b.text) && !b.hidden && !b.modal, JSON.stringify(b));
      mode = '404';
      await autoCheck();
      b = await badge();
      check('更新：检查失败时状态栏显示失败且不弹窗', b.st === 'error' && /失败/.test(b.text) && !b.modal, JSON.stringify(b));
      await js('__zmark.setSetting({ skippedVersion: "" })');
      mode = 'newer';
      await autoCheck();
      b = await badge();
      const btns = await js('Array.from(document.querySelectorAll(".update-modal .actions button")).filter((x) => !x.hidden).map((x) => x.textContent.trim())');
      check('更新：发现新版本时状态栏提示并弹窗', b.st === 'newer' && b.text.includes('9.9.9') && b.modal && /发现新版本/.test(await js('document.querySelector(".update-modal h3").textContent')), JSON.stringify(b));
      check('更新：弹窗提供 立即更新 / 跳过此版本 / 取消', ['立即更新', '跳过此版本', '取消'].every((t) => btns.includes(t)), JSON.stringify(btns));
      check('更新：开始下载前不显示进度条', await js('getComputedStyle(document.querySelector(".update-modal .update-progress")).display === "none"'));
      await shot('25-发现新版本.png');
      await js('document.querySelector(".update-modal [data-act=close]").click()');
      await wait(200);
      check('更新：取消后关闭弹窗、不记录跳过', !(await badge()).modal && (await js('__zmark.state.settings.skippedVersion')) === '');
      await autoCheck();
      check('更新：取消后下次检查仍会弹窗', (await badge()).modal);
      await js('document.querySelector(".update-modal [data-act=skip]").click()');
      await wait(200);
      check('更新：跳过此版本后关闭弹窗并记住版本', !(await badge()).modal && (await js('__zmark.state.settings.skippedVersion')) === '9.9.9');
      await autoCheck();
      b = await badge();
      check('更新：已跳过的版本不再弹窗，状态栏仍提示', !b.modal && b.st === 'newer', JSON.stringify(b));
      await js('document.querySelector("#sb-update").click()');
      await wait(300);
      check('更新：点击状态栏「新版本」打开更新对话框', (await badge()).modal);
      await key('Escape');
      await js('__zmark.setSetting({ skippedVersion: "" })');
      await patchTests();
      const bad = await js("window.zmark.invoke('update:download', { name: 'x.exe', size: 1, url: 'http://evil.example.com/x.exe' }).then(() => 'ok', (e) => e.message)");
      check('更新：拒绝非 HTTPS 的下载地址', /无效的下载地址/.test(bad), bad);
      await js('document.querySelector("#sb-update").hidden = true');
    } finally {
      delete process.env.MOYU_UPDATE_API;
      server.close();
    }
  }

  async function featureTests() {
    const set = async (patch) => { await js(`__zmark.setSetting(${JSON.stringify(patch)})`); await wait(150); };
    // 历史版本：首次保存保留磁盘原内容，5 分钟内的多次保存合并
    const hf = path.join(DOC_DIR, 'history-test.md');
    fs.writeFileSync(hf, '# 历史测试\n\n原始内容\n');
    await js(`__zmark.openPath(${JSON.stringify(hf)}, {force: true, skipConfirm: true})`);
    await wait(300);
    await js('__zmark.editor.replaceAllText("# 历史测试\\n\\n第二版内容")');
    await js('__zmark.save(false, true)');
    await wait(200);
    let list = await js(`window.zmark.invoke('history:list', ${JSON.stringify(hf)})`);
    check('历史版本：首次保存时保留原内容与新内容', list.length === 2, JSON.stringify(list));
    await js('__zmark.editor.replaceAllText("# 历史测试\\n\\n第三版内容\\n\\n新增一段")');
    await js('__zmark.save(false, true)');
    await wait(200);
    list = await js(`window.zmark.invoke('history:list', ${JSON.stringify(hf)})`);
    check('历史版本：短时间内的连续保存合并为一个快照', list.length === 2 && (await js(`window.zmark.invoke('history:read', ${JSON.stringify(hf)}, ${JSON.stringify(list[0].id)})`)).includes('第三版'), JSON.stringify(list));
    await js('__zmark.runCommand("file.history")');
    await wait(500);
    await js('document.querySelectorAll(".history-item")[1].click()');
    await wait(300);
    const hv = await js('({ items: document.querySelectorAll(".history-item").length, add: document.querySelectorAll(".history-diff .dl.add").length, del: document.querySelectorAll(".history-diff .dl.del").length, stat: document.querySelector(".history-stat").textContent })');
    check('历史版本：列表与逐行对比', hv.items === 2 && hv.add >= 2 && hv.del >= 1, JSON.stringify(hv));
    await shot('21-历史版本.png');
    await js('document.querySelector(".history-modal [data-act=restore]").click()');
    await wait(300);
    check('历史版本：恢复旧版本（可撤销）', (await text()) === '# 历史测试\n\n原始内容');
    await js('__zmark.runCommand("edit.undo")');
    await wait(200);
    check('历史版本：恢复后可撤销', (await text()).includes('第三版内容'));

    // 快速打开与命令面板
    await js(`__zmark.loadFolder(${JSON.stringify(DOC_DIR)})`);
    await wait(300);
    await js('__zmark.runCommand("file.quickOpen")');
    await wait(300);
    await type('histest');
    await wait(300);
    const first = await js('(document.querySelector(".palette-item") || {}).textContent || ""');
    check('快速打开：模糊搜索文件夹中的文件', first.includes('history-test.md'), first);
    await shot('22-快速打开.png');
    await js('document.querySelector(".palette-input").value = ""; document.querySelector(".palette-input").dispatchEvent(new Event("input"))');
    await type('test.md');
    await wait(300);
    await key('Enter');
    await wait(400);
    check('快速打开：回车打开文件', (await js('__zmark.state.filePath')) === DOC, await js('__zmark.state.filePath'));
    await js('__zmark.runCommand("edit.commandPalette")');
    await wait(300);
    await type('午夜');
    await wait(200);
    await key('Enter');
    await wait(400);
    check('命令面板：搜索并执行命令', (await js('document.body.dataset.theme')) === 'midnight' && !(await js('!!document.querySelector(".palette-mask")')));
    await set({ theme: 'github' });

    // 斜杠命令
    await js('__zmark.editor.appendEmptyBlock()');
    await type('/');
    await wait(150);
    const n0 = await js('document.querySelectorAll(".slash-item").length');
    await type('table');
    await wait(150);
    const firstSlash = await js('(document.querySelector(".slash-item.active") || {}).textContent');
    await shot('23-斜杠命令.png');
    await key('Enter');
    await wait(200);
    check('斜杠命令：输入 / 弹出菜单并按关键词筛选', n0 >= 14 && firstSlash === '表格', `${n0} ${firstSlash}`);
    check('斜杠命令：回车插入表格', /^\| 列1 \| 列2 \| 列3 \|/.test(await val()) && !(await js('!!document.querySelector(".slash-menu")')), await val());
    await key('Escape');
    await set({ richMode: true });
    await js('__zmark.editor.appendEmptyBlock()');
    await type('/h2');
    await wait(150);
    await key('Enter');
    await wait(200);
    await type('斜杠标题');
    check('斜杠命令：纯文本模式下插入二级标题', (await val()) === '## 斜杠标题' && (await js('!!__zmark.editor.richEl.querySelector("h2")')), await val());
    await key('Escape');
    await js('__zmark.editor.appendEmptyBlock()');
    await type('/');
    await key('Escape');
    await wait(100);
    check('斜杠命令：Esc 关闭菜单并保留输入', !(await js('!!document.querySelector(".slash-menu")')));
    // 斜杠菜单：键盘选择时菜单随选中项滚动
    await js('__zmark.editor.applyEdit("", 0)');
    await type('/');
    await wait(150);
    const slashView = () => js(`(() => { const m = document.querySelector('.slash-menu'); const a = m.querySelector('.slash-item.active'); const mr = m.getBoundingClientRect(); const ar = a.getBoundingClientRect();
      return { idx: Array.from(m.querySelectorAll('.slash-item')).indexOf(a), scroll: Math.round(m.scrollTop), overflow: m.scrollHeight > m.clientHeight, visible: ar.top >= mr.top - 1 && ar.bottom <= mr.bottom + 1 }; })()`);
    const slashCount = await js('document.querySelectorAll(".slash-item").length');
    for (let i = 1; i < slashCount; i++) await key('Down');
    let sv = await slashView();
    check('斜杠菜单：向下选到最后一项时菜单滚动，选中项可见', sv.overflow && sv.idx === slashCount - 1 && sv.visible && sv.scroll > 0, JSON.stringify(sv));
    await key('Down');
    sv = await slashView();
    check('斜杠菜单：从最后一项循环到第一项时滚回顶部', sv.idx === 0 && sv.visible && sv.scroll === 0, JSON.stringify(sv));
    await key('Up');
    sv = await slashView();
    check('斜杠菜单：从第一项向上循环到最后一项时滚到底部', sv.idx === slashCount - 1 && sv.visible, JSON.stringify(sv));
    await key('Escape');
    await js('__zmark.editor.applyEdit("", 0)');
    await key('Escape');

    // 空段落中连续回车：每次都向下新增一行（空行写作 <br>，编辑时显示为空行）
    const enterRun = async (rich) => {
      await set({ richMode: rich });
      await js(`__zmark.loadText(${JSON.stringify('第一段\n\n第二段')}, {})`);
      await js('__zmark.editor.activateRange(0, 1)');
      await wait(100);
      const y0 = await js('__zmark.editor.editorEl.getBoundingClientRect().top');
      await key('Enter');
      await key('Enter');
      await key('Enter');
      const y1 = await js('__zmark.editor.editorEl.getBoundingClientRect().top');
      await type('第三行');
      return { y0, y1, t: await text() };
    };
    const want = '第一段\n\n<br>\n\n<br>\n\n第三行\n\n第二段';
    let er = await enterRun(false);
    check('回车：空段落中连续回车每次都新增一行（源码编辑）', er.t.trim() === want && er.y1 - er.y0 > 60, JSON.stringify(er));
    await key('Escape');
    await wait(100);
    const blanks = await js('Array.from(document.querySelectorAll(".md-block.blk-blank")).map((b) => b.offsetHeight)');
    check('回车：离开后空行保留并显示为空白行', blanks.length === 2 && blanks.every((h) => h > 15) && !(await js('document.querySelector("#write").textContent.includes("<br>")')), JSON.stringify(blanks));
    await js('__zmark.editor.activateRange(2, 3)');
    await wait(100);
    const blankVal = await val();
    await key('Backspace');
    await wait(100);
    check('回车：空行编辑时不显示 <br>，退格删除空行', blankVal === '' && (await text()).trim() === '第一段\n\n<br>\n\n第三行\n\n第二段', JSON.stringify({ blankVal, t: await text() }));
    await js('__zmark.editor.activateRange(0, 1)');
    await key('Enter');
    await key('Enter');
    await key('Escape');
    await wait(100);
    check('回车：未输入内容就离开时只保留已经回车经过的空行', (await text()).trim() === '第一段\n\n<br>\n\n<br>\n\n第三行\n\n第二段', await text());
    er = await enterRun(true);
    check('回车：空段落中连续回车每次都新增一行（纯文本模式）', er.t.trim() === want && er.y1 - er.y0 > 60, JSON.stringify(er));
    await key('Escape');

    // 全选：回车后光标在空行中，Ctrl+A 仍应选中整篇文档
    const selDoc = '第一段\n\n```js\nlet a = 1;\nlet b = 2;\n```\n\n第二段';
    const allSel = () => js('({ all: __zmark.editor.isAllSelected(), sel: window.getSelection().toString(), editing: __zmark.editor.isEditing() })');
    const copyData = (type) => js(`(() => { const dt = new DataTransfer(); document.dispatchEvent(new ClipboardEvent(${JSON.stringify(type)}, { clipboardData: dt, bubbles: true, cancelable: true })); return dt.getData('text/plain'); })()`);
    for (const rich of [false, true]) {
      const tag = rich ? '纯文本模式' : '源码编辑';
      await set({ richMode: rich });
      await js(`__zmark.loadText(${JSON.stringify(selDoc)}, {})`);
      await js('__zmark.editor.activateRange(0, 1)');
      await key('Enter');
      await key('A', ['control']);
      await wait(150);
      let s = await allSel();
      check(`全选：回车后在空行中按 Ctrl+A 选中整篇文档（${tag}）`, s.all && !s.editing && s.sel.includes('第一段') && s.sel.includes('let b = 2;') && s.sel.includes('第二段'), JSON.stringify(s));
      check(`全选：复制得到完整的 Markdown 源码（${tag}）`, (await copyData('copy')) === selDoc);
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'x' });
      wc.sendInputEvent({ type: 'char', keyCode: 'x' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'x' });
      await wait(200);
      check(`全选：直接输入替换整篇文档（${tag}）`, (await text()).trim() === 'x', await text());
      await key('Z', ['control']);
      const afterOne = (await text()).trim();
      await key('Z', ['control']);
      await wait(150);
      check(`全选：替换后可以逐步撤销（${tag}）`, afterOne === '' && (await text()).trim() === selDoc, JSON.stringify([afterOne, await text()]));
      await key('Escape');
      await js('__zmark.editor.activateRange(2, 6, 3)');
      await wait(100);
      await key('A', ['control']);
      await wait(150);
      s = await allSel();
      const inBlock = !s.all && s.editing;
      await key('A', ['control']);
      await wait(150);
      s = await allSel();
      check(`全选：代码块中第一次选中块内内容，再按一次选中整篇（${tag}）`, inBlock && s.all && s.sel.includes('第二段'), JSON.stringify({ inBlock, s }));
      await key('Backspace');
      await wait(150);
      check(`全选：退格清空文档并可撤销（${tag}）`, (await text()).trim() === '' && (await js('__zmark.editor.isEditing()')), await text());
      await key('Z', ['control']);
      await wait(150);
      check(`撤销：清空文档后在空编辑框中按 Ctrl+Z 可以恢复（${tag}）`, (await text()).trim() === selDoc, await text());
      await key('A', ['control']);
      await wait(100);
      await key('Right');
      await wait(100);
      s = await allSel();
      check(`全选：方向键取消全选并把光标放到文末（${tag}）`, !s.all && s.editing && (await text()).trim() === selDoc && (await val()) === '第二段', JSON.stringify({ s, v: await val(), t: await text() }));
      await key('Escape');
    }
    await js('__zmark.runCommand("edit.find")');
    await wait(150);
    await type('查找内容');
    await key('A', ['control']);
    await wait(100);
    const fsel = await js('({ a: document.activeElement.id, s: document.activeElement.selectionStart, e: document.activeElement.selectionEnd, all: __zmark.editor.isAllSelected() })');
    check('全选：查找框中只选中输入框内容', fsel.a === 'find-input' && fsel.s === 0 && fsel.e === 4 && !fsel.all, JSON.stringify(fsel));
    await key('Escape');
    await set({ richMode: false });

    // 图片放大：双击图片
    await js(`__zmark.loadText(${JSON.stringify('# 图片\n\n![logo](assets/pic.png)')}, {filePath: ${JSON.stringify(DOC)}})`);
    await wait(400);
    // 图片为懒加载：自检窗口被其它窗口遮住时 Chromium 会推迟加载，这里明确要求加载并等待完成
    await js('document.querySelectorAll("#write img").forEach((im) => { im.loading = "eager"; })');
    for (let i = 0; i < 30 && !(await js('document.querySelector("#write img").complete && document.querySelector("#write img").naturalWidth > 0')); i++) await wait(100);
    const r = await js('(() => { const b = document.querySelector("#write img").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()');
    await clickAt(r.x, r.y);
    await wait(60);
    await clickAt(r.x, r.y);
    await wait(300);
    check('图片放大：双击图片打开预览', await js('!!document.querySelector(".lightbox img")'), JSON.stringify(r));
    await key('Escape');
    check('图片放大：Esc 关闭', !(await js('!!document.querySelector(".lightbox")')));
    await key('Escape');
  }

  /** 纯文本模式：编辑时不显示源码，源码由编辑区内容还原 */
  async function richTests() {
    const set = async (patch) => { await js(`__zmark.setSetting(${JSON.stringify(patch)})`); await wait(150); };
    const sample = fs.readFileSync(path.join(ROOT, 'samples', '欢迎使用 Moyu.md'), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
    await set({ richMode: true });
    await js(`__zmark.loadText(${JSON.stringify(sample)}, {filePath: ${JSON.stringify(DOC)}})`);
    await wait(600);
    const rich = () => js('({ on: document.querySelector(".md-editing").classList.contains("rich"), srcShown: getComputedStyle(document.querySelector(".md-editing .hl-wrap")).display !== "none", html: __zmark.editor.richEl.innerHTML.slice(0, 300) })');
    const selectText = (needle) => js(`(() => { const w = document.createTreeWalker(__zmark.editor.richEl, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) { const i = n.data.indexOf(${JSON.stringify(needle)}); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ${needle.length}); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } } return false; })()`);
    // 由浏览器自身处理的回车（列表、代码块）需要同时发送字符事件
    const enterNative = async () => {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      wc.sendInputEvent({ type: 'char', keyCode: '\r' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await wait(200);
    };
    const caretEnd = () => js('(() => { const r = document.createRange(); r.selectNodeContents(__zmark.editor.richHost()); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()');

    // 各类块能否直接编辑
    const kinds = await js('__zmark.editor.blocks.map(b => [b.type, __zmark.editor.richKind(__zmark.editor.srcOf(b))])');
    const fallback = kinds.filter((k) => !k[1]).map((k) => k[0]);
    console.log('    纯文本模式回退为代码编辑的块：' + [...new Set(fallback)].join('、'));
    check('纯文本模式：段落 / 标题 / 列表 / 引用 / 表格 / 代码块均可直接编辑', kinds.filter((k) => /^(paragraph|heading|list|quote|table|code|hr)/.test(k[0])).every((k) => k[1]), JSON.stringify(kinds.filter((k) => !k[1])));
    check('纯文本模式：公式块 / 图表 / Front Matter / 目录按代码编辑', fallback.every((t) => /^(math|mermaid|frontmatter|toc|raw|html)/.test(t)), fallback.join(','));

    // 点击段落：不显示源码，内容与文档不变
    await clickJs('[...document.querySelectorAll("#write .blk-paragraph p")].find(p => p.textContent.includes("所见即所得"))', 0.3, 0.3);
    let st = await rich();
    check('纯文本模式：点击段落后不显示源码', st.on && !st.srcShown && /<strong>Moyu<\/strong>/.test(st.html), JSON.stringify(st));
    check('纯文本模式：仅点击不改动文档', (await text()) === sample && !(await js('__zmark.isDirty()')));
    check('纯文本模式：光标定位到点击处', (await js('__zmark.editor.richCaretOffset()')) > 0);
    await caretEnd();
    await type('直接输入');
    let t = await text();
    check('纯文本模式：输入文字，原有格式标记保留', t.includes('离开后立即重新渲染。直接输入') && t.includes('**Moyu** 是一款*所见即所得*的'), t.slice(60, 200));
    await selectText('直接输入');
    await js('__zmark.runCommand("fmt.bold")');
    await wait(150);
    check('纯文本模式：加粗（Ctrl+B）', (await text()).includes('**直接输入**'), (await text()).slice(100, 220));
    st = await rich();
    check('纯文本模式：加粗后仍不显示源码', st.on && !st.srcShown);
    await shot('17-纯文本模式.png');

    // 回车拆分；输入 Markdown 标记后离开自动成形
    await caretEnd();
    await key('Enter');
    check('纯文本模式：回车新建段落', (await val()) === '' && (await rich()).on, JSON.stringify(await val()));
    await type('## 纯文本标题');
    await key('Escape');
    check('纯文本模式：输入 ## 后离开即成为标题', await js('[...document.querySelectorAll("#write h2")].some(h => h.textContent === "纯文本标题")'));
    await clickJs('[...document.querySelectorAll("#write h2")].find(h => h.textContent === "纯文本标题")');
    st = await rich();
    check('纯文本模式：编辑标题不显示 #', st.on && /<h2/.test(st.html) && !/##/.test(st.html), st.html);
    await js('__zmark.runCommand("para.h3")');
    await wait(150);
    check('纯文本模式：Ctrl+3 改为三级标题', (await val()) === '### 纯文本标题' && /<h3/.test((await rich()).html), await val());
    await js('__zmark.runCommand("edit.undo")');
    await wait(150);
    check('纯文本模式：撤销', (await val()) === '## 纯文本标题', await val());
    await key('Escape');

    // 列表
    await clickJs('[...document.querySelectorAll("#write ol li")].find(li => li.textContent.includes("点击这段文字"))', 0.9, 0.5);
    await caretEnd();
    await type('（已读）');
    await enterNative();
    await type('第五步');
    t = await text();
    check('纯文本模式：列表中输入与回车新增列表项', /4\. 按 `Ctrl\+\/` 切换到\*\*源代码模式\*\*，再按一次切回来。（已读）\n5\. 第五步/.test(t), t.slice(t.indexOf('1. 点击'), t.indexOf('1. 点击') + 220));
    await key('Escape');

    // 表格
    await clickJs('[...document.querySelectorAll("#write td")].find(td => td.textContent === "选中文字后使用")');
    await type('✓');
    await key('Tab');
    await type('新');
    t = await text();
    check('纯文本模式：表格单元格内编辑、Tab 跳格', /\| 加粗 \| `Ctrl\+B` \| 选中文字后✓使用 \|/.test(t) && /\| 插入表格新 \|/.test(t) && t.includes('| :--- | :---: | --- |'), t.slice(t.indexOf('| 功能'), t.indexOf('| 功能') + 200));
    await key('Escape');

    // 代码块
    await clickJs('document.querySelector("#write .blk-code pre")', 0.5, 0.5);
    st = await rich();
    check('纯文本模式：代码块不显示围栏', st.on && !st.srcShown && (await js('__zmark.editor.richKindName')) === 'code');
    await caretEnd();
    await enterNative();
    await type('// 新增一行');
    v0 = await val();
    check('纯文本模式：代码块内输入，围栏与语言保留', /^```javascript\n/.test(v0) && v0.endsWith("console.log(greet('Moyu'));\n// 新增一行\n```"), v0.slice(-60));
    await key('Escape');

    // 行内公式、提示块
    await clickJs('[...document.querySelectorAll("#write p")].find(p => p.textContent.startsWith("行内公式"))', 0.05, 0.5);
    await caretEnd();
    await type('完');
    check('纯文本模式：含行内公式的段落', (await val()) === '行内公式：质能方程 $E = mc^2$，欧拉恒等式 $e^{i\\pi} + 1 = 0$。完', await val());
    await key('Escape');
    await clickJs('document.querySelector("#write blockquote.callout p")', 0.5, 0.5);
    await caretEnd();
    await type('！');
    v0 = await val();
    check('纯文本模式：提示块（插件语法）', (await rich()).on && v0.startsWith('> [!TIP] 试试插件') && v0.endsWith('「写作目标」。！'), v0);
    await key('Escape');
    check('纯文本模式：提示块编辑后仍正确渲染', await js('!!document.querySelector("#write blockquote.callout-tip .callout-title")'));

    // 公式块：按代码编辑
    await clickJs('document.querySelector("#write .math-block")');
    st = await rich();
    check('纯文本模式：公式块以代码形式编辑', !st.on && st.srcShown && (await val()).startsWith('$$'));
    await key('Escape');

    // 关闭后恢复为显示源码
    await set({ richMode: false });
    await clickJs('[...document.querySelectorAll("#write .blk-paragraph p")].find(p => p.textContent.includes("所见即所得"))');
    st = await rich();
    check('关闭纯文本模式后显示源码', !st.on && st.srcShown);
    await key('Escape');
  }
  let v0;

  /** 约 1 万行、30 万字符的文档：打开、点击编辑、逐字输入、输入后的统计刷新耗时 */
  async function perfTests() {
    const parts = [];
    for (let i = 1; i <= 400; i++) {
      parts.push(`## 第 ${i} 节`, '', `这是第 ${i} 节的正文，包含**加粗**、*斜体*、\`代码\`和[链接](https://example.com/${i})。`.repeat(4), '',
        `- 列表项 A${i}`, `- 列表项 B${i}`, '', '```js', `function f${i}(x) {`, '  return x * 2;', '}', '```', '',
        `| 列 | 值 |`, '| --- | --- |', `| a | ${i} |`, '', `> 引用 ${i}`, '');
    }
    const big = '# 性能测试\n\n' + parts.join('\n');
    const r = await js(`(async () => {
      const z = __zmark;
      // 模拟用了一段时间之后的状态：渲染缓存里已有不少其它文档的内容。
      // （缓存曾经在装满时整个清空，此时再打开大文档，每次点击都要把全文重新净化一遍，约半秒）
      for (let i = 0; i < 1500; i++) ZMD.sanitize('<p>之前打开过的文档中的第 ' + i + ' 段</p>');
      const t0 = performance.now();
      z.loadText(${JSON.stringify(big)}, {});
      const load = performance.now() - t0;
      await new Promise(r => setTimeout(r, 600));
      const blocks = z.editor.blocks;
      const mid = blocks[Math.floor(blocks.length / 2)];
      const t1 = performance.now();
      z.editor.activateRange(mid.start, mid.end, 0);
      const activate = performance.now() - t1;
      const ta = z.editor.hl.ta;
      ta.setSelectionRange(ta.value.length, ta.value.length);
      let worst = 0, total = 0;
      for (let i = 0; i < 30; i++) {
        const t = performance.now();
        document.execCommand('insertText', false, '字');
        const d = performance.now() - t; total += d; worst = Math.max(worst, d);
      }
      const t2 = performance.now();
      z.bus.emit('change');
      z.editor.computeHeadings();
      z.countWords(z.getText());
      const refresh = performance.now() - t2;
      const t3 = performance.now();
      z.editor.commit();
      const commit = performance.now() - t3;
      // 耗时拆分：解析 / 渲染（含解析）/ 排版
      const p0 = performance.now(); z.editor.md.parse(z.getText(), {}); const parse = performance.now() - p0;
      const p1 = performance.now(); z.editor.render(); const render = performance.now() - p1;
      const p2 = performance.now(); document.querySelector('#write').getBoundingClientRect(); void document.body.offsetHeight; const layout = performance.now() - p2;
      // 点击大纲中靠后（约 80% 处）的标题；最后几个标题离文末太近，无法滚动到顶部
      await new Promise(r => setTimeout(r, 400));
      const heads = z.editor.computeHeadings();
      const k = Math.floor(heads.length * 0.8);
      const last = heads[k];
      document.querySelectorAll('.outline-item')[k].click();
      await new Promise(r => setTimeout(r, 600));
      const lastTop = document.querySelector('#' + CSS.escape(last.id)).getBoundingClientRect().top - document.querySelector('#content').getBoundingClientRect().top;
      return { lines: z.getText().split('\\n').length, chars: z.getText().length, blocks: blocks.length,
        load: Math.round(load), activate: Math.round(activate), keyAvg: +(total / 30).toFixed(1), keyWorst: Math.round(worst),
        refresh: Math.round(refresh), commit: Math.round(commit),
        breakdown: { parse: Math.round(parse), render: Math.round(render), layout: Math.round(layout) }, lastTop: Math.round(lastTop) };
    })()`);
    console.log('    性能：' + JSON.stringify(r));
    check(`大文档：打开 ${r.lines} 行 / ${r.chars} 字符 < 2.5 秒`, r.load < 2500, r.load + 'ms');
    check('大文档：点击进入编辑 < 300ms', r.activate < 300, r.activate + 'ms');
    check('大文档：每次按键处理 < 16ms（一帧）', r.keyAvg < 16, `平均 ${r.keyAvg}ms，最慢 ${r.keyWorst}ms`);
    check('大文档：输入后统计 / 大纲 / 插件刷新 < 300ms', r.refresh < 300, r.refresh + 'ms');
    check('大文档：离开编辑块重新渲染 < 500ms', r.commit < 500, r.commit + 'ms');
    check('大文档：大纲跳转到文档后部的标题位置准确', Math.abs(r.lastTop - 16) < 40, r.lastTop + 'px');
    await js('__zmark.loadText("", {})');
  }

  /** 输入框中的撤销 / 格式快捷键不影响文档；Ctrl+Shift+Z 重做；代码块标签不遮挡代码 */
  async function polishTests() {
    await js(`__zmark.loadText(${JSON.stringify('# 输入框测试\n\n```python\nprint("a very long first line of code that reaches the right edge of the block ................................")\n```')}, {filePath: ${JSON.stringify(DOC)}})`);
    await wait(300);
    const docBefore = await text();
    await js('__zmark.runCommand("edit.find")');
    await wait(150);
    await type('abc');
    await js('__zmark.runCommand("edit.undo")');
    await wait(100);
    const findVal = await js('document.querySelector("#find-input").value');
    await js('__zmark.runCommand("fmt.bold")');
    await wait(100);
    check('查找框中撤销只作用于输入框、格式命令不修改文档', findVal !== 'abc' && (await text()) === docBefore, JSON.stringify([findVal, await text() === docBefore]));
    await js('document.querySelector("#find-close").click()');
    await clickJs('[...document.querySelectorAll("#write h1")][0]');
    await type('甲');
    await key('Escape');
    await js('__zmark.runCommand("edit.undo")');
    await wait(150);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control', 'shift'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control', 'shift'] });
    await wait(200);
    check('Ctrl+Shift+Z 重做', (await text()).includes('甲'), await text());
    // 源代码模式下的全部替换可以撤销（焦点仍在替换框中）
    const srcBefore = await text();
    await js('__zmark.runCommand("view.source")');
    await wait(200);
    await js('__zmark.runCommand("edit.replace")');
    await js('{ const fi = document.querySelector("#find-input"); fi.value = "print"; fi.dispatchEvent(new Event("input")); }');
    await js('{ const ri = document.querySelector("#replace-input"); ri.focus(); ri.value = "PRINT"; ri.dispatchEvent(new Event("input")); document.querySelector("#replace-all").click(); }');
    await wait(200);
    const replaced = (await text()).includes('PRINT');
    await js('document.querySelector("#replace-input").focus(); __zmark.runCommand("edit.undo")');
    await wait(200);
    check('源代码模式：全部替换后在替换框中 Ctrl+Z 撤销替换', replaced && (await text()) === srcBefore, String(replaced));
    await js('document.querySelector("#find-close").click(); __zmark.runCommand("view.source")');
    await wait(200);
    const overlap = await js(`(() => { const b = document.querySelector('#write .code-block'); const tb = b.querySelector('.code-toolbar').getBoundingClientRect(); const line = b.querySelector('pre').getBoundingClientRect();
      return tb.bottom <= line.top + 4; })()`);
    check('代码块语言标签不遮挡代码', overlap);
  }

  /** 深色主题下的提示块 / 统计面板 / 偏好设置，以及最小窗口宽度下的布局 */
  async function visualTests() {
    const set = async (patch) => { await js(`__zmark.setSetting(${JSON.stringify(patch)})`); await wait(200); };
    const demo = '# 深色主题检查\n\n> [!TIP]\n> 提示块在深色主题下的配色。\n\n> [!CAUTION] 注意事项\n> 第二种提示块。\n\n## 代码与表格\n\n```python\ndef hello(name):\n    return f"你好，{name}"\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 插件 | ==已启用== |\n\n- [x] 已完成\n- [ ] 未完成\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$';
    await js(`__zmark.loadText(${JSON.stringify(demo)}, {filePath: ${JSON.stringify(DOC)}})`);
    await set({ theme: 'midnight', sidebar: true, sidebarTab: 'plugin-writing-goal-stats' });
    await wait(500);
    await js('document.querySelector("#content").scrollTop = 0');
    await shot('14-午夜蓝主题.png');
    await set({ theme: 'night' });
    await js('__zmark.openPreferences("plugins")');
    await wait(400);
    await shot('15-夜间主题-偏好设置.png');
    await key('Escape');
    // 最小窗口宽度（640px）
    const [w0, h0] = win.getContentSize();
    win.setContentSize(640, 560);
    await wait(500);
    const narrow = await js(`(() => {
      const sb = document.querySelector('#statusbar'), w = document.querySelector('#write');
      return { overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
        statusOverflow: sb.scrollWidth > sb.clientWidth + 1, writeWidth: Math.round(w.getBoundingClientRect().width) }; })()`);
    await shot('16-窄窗口.png');
    check('窄窗口（640px）：无横向溢出、状态栏不溢出', !narrow.overflowX && !narrow.statusOverflow && narrow.writeWidth > 250, JSON.stringify(narrow));
    win.setContentSize(w0, h0);
    await set({ theme: 'github', sidebarTab: 'outline' });
    await wait(300);
  }

  async function settingsTests() {
    const set = async (patch) => { await js(`__zmark.setSetting(${JSON.stringify(patch)})`); await wait(150); };
    const settings = () => js('window.zmark.invoke("settings:get")');
    /** 在当前焦点元素上派发按键（用于验证自动配对等 keydown 逻辑），返回是否被处理 */
    const kd = (k) => js(`(() => { const e = new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(e); return e.defaultPrevented; })()`);
    const caret = () => js('__zmark.editor.hl.ta.selectionStart');
    let v;

    /* 界面 */
    await js('__zmark.openPreferences("appearance")');
    await wait(300);
    const secs = await js('[...document.querySelectorAll(".prefs-nav [data-sec]")].map(b => b.textContent)');
    check('偏好设置：8 个分栏', secs.join(',') === '通用,外观,主题与背景,编辑器,Markdown,图像,导出,插件', secs.join(','));
    const n = await js('document.querySelectorAll(".prefs [data-k]").length');
    check('偏好设置：设置项数量', n >= 60, n);
    check('偏好设置：关联项默认隐藏（自定义字体）', await js('document.querySelector(".prefs [data-k=customFont]").closest(".row").hidden === true'));
    await js('const f = document.querySelector(".prefs [data-k=fontFamily]"); f.value = "custom"; f.dispatchEvent(new Event("change"))');
    await wait(150);
    check('偏好设置：修改立即保存并显示关联项', await js('document.querySelector(".prefs [data-k=customFont]").closest(".row").hidden === false') && (await settings()).fontFamily === 'custom');
    await shot('11-偏好设置-外观.png');
    await js('document.querySelector(".prefs [data-sec=markdown]").click()');
    await wait(200);
    await shot('12-偏好设置-Markdown.png');
    await key('Escape');

    /* 外观与 Markdown 渲染 */
    const doc = '# 标题\n\n## 第一章\n\n正文段落一。\n\n### 小节\n\n正文段落二。\n\n## 第二章\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\n$$\nE=mc^2\n$$\n\n$$\na^2+b^2=c^2\n$$\n\nH~2~O 与 x^2^，==高亮==，$y$，https://example.com ，"引号"\n\nA行\nB行\n\n```mermaid\ngraph LR\nA-->B\n```';
    await js(`__zmark.loadText(${JSON.stringify(doc)}, {filePath: ${JSON.stringify(DOC)}})`);
    await set({ fontFamily: 'kai', paragraphSpacing: 'loose', firstLineIndent: true, headingNumbering: true, codeLineNumbers: true, mathNumbering: true, supSubSyntax: true, typographer: true });
    await wait(400);
    const ap = await js(`(() => {
      const w = document.querySelector('#write');
      const p = [...w.querySelectorAll('p')].find(x => x.textContent.startsWith('正文段落一'));
      const cs = getComputedStyle(p);
      return {
        font: cs.fontFamily, margin: Math.min(parseFloat(cs.marginTop), parseFloat(cs.marginBottom)), indent: cs.textIndent,
        nums: [...w.querySelectorAll('h2, h3')].map(h => h.dataset.num).join(','),
        h2: getComputedStyle(w.querySelectorAll('h2')[1], '::before').content,
        eqs: [...w.querySelectorAll('.math-block')].map(m => m.dataset.eq).join(','),
        uiFont: getComputedStyle(document.querySelector('#statusbar')).fontFamily,
        lines: w.querySelectorAll('.code-line').length, lineH: w.querySelector('.code-line').offsetHeight,
        copy: w.querySelector('.with-lines pre').textContent,
        eq: getComputedStyle(w.querySelector('.math-block'), '::after').content,
        sub: (w.querySelector('sub') || {}).textContent, sup: (w.querySelector('sup') || {}).textContent,
        quotes: [...w.querySelectorAll('p')].some(x => x.textContent.includes('“引号”')),
        br: !![...w.querySelectorAll('p')].find(x => x.textContent.includes('A行')).querySelector('br'),
      }; })()`);
    check('外观：正文字体（楷体）只作用于文档、不影响界面', /KaiTi/.test(ap.font) && !/KaiTi/.test(ap.uiFont), ap.font + ' | ' + ap.uiFont);
    check('外观：段落间距（宽松）', ap.margin > 16, ap.margin);
    check('外观：首行缩进两字', ap.indent === '32px', ap.indent);
    check('外观：标题自动编号（1 / 1.1 / 2，跨块连续）', ap.nums === '1,1.1,2' && ap.h2 !== 'none', ap.nums + ' | ' + ap.h2);
    check('Markdown：代码块行号（复制内容不变）', ap.lines === 2 && ap.lineH < 32 && ap.copy === 'const a = 1;\nconst b = 2;\n', JSON.stringify([ap.lines, ap.lineH, ap.copy]));
    check('Markdown：公式块自动编号（跨块连续）', ap.eqs === '1,2' && ap.eq !== 'none', ap.eqs + ' | ' + ap.eq);
    check('Markdown：上标 / 下标', ap.sub === '2' && ap.sup === '2', ap.sub + ap.sup);
    check('Markdown：智能标点', ap.quotes);
    check('Markdown：单个换行显示为换行（默认开启）', ap.br);
    await js('document.querySelector("#content").scrollTop = 0');
    await shot('13-排版选项.png');
    await set({ codeWrap: true });
    check('Markdown：代码块自动换行', (await js('getComputedStyle(document.querySelector("#write pre")).whiteSpace')) === 'pre-wrap');

    await set({ mathSyntax: false, markSyntax: false, mermaid: false, linkify: false, supSubSyntax: false, typographer: false, breaks: false });
    await wait(400);
    const off = await js(`(() => { const w = document.querySelector('#write'); return {
      katex: w.querySelectorAll('.katex').length, mark: !!w.querySelector('mark'), mermaid: !!w.querySelector('.mermaid-block'),
      mermaidCode: !!w.querySelector('code.language-mermaid'), link: [...w.querySelectorAll('a')].some(a => a.href.startsWith('https://example.com')),
      sub: !!w.querySelector('sub'), br: !![...w.querySelectorAll('p')].find(x => x.textContent.includes('A行')).querySelector('br') }; })()`);
    check('Markdown：关闭公式 / 高亮 / 图表 / 自动链接 / 上下标 / 换行', off.katex === 0 && !off.mark && !off.mermaid && off.mermaidCode && !off.link && !off.sub && !off.br, JSON.stringify(off));
    await set({ mathSyntax: true, markSyntax: true, mermaid: true, linkify: true, breaks: true, codeWrap: false, codeLineNumbers: false });

    /* 界面 */
    await set({ showWordCount: false });
    check('外观：隐藏状态栏字数', await js('document.querySelector("#sb-count").hidden && getComputedStyle(document.querySelector("#sb-count")).display === "none"'));
    await set({ showStatusBar: false });
    check('外观：隐藏状态栏', (await js('getComputedStyle(document.querySelector("#statusbar")).display')) === 'none');
    await set({ sidebarPosition: 'right', sidebar: true });
    check('外观：侧边栏位于右侧', await js('document.querySelector("#sidebar").getBoundingClientRect().left > document.querySelector("#content-wrap").getBoundingClientRect().left'));
    await set({ showWordCount: true, showStatusBar: true, sidebarPosition: 'left' });

    /* 编辑器 */
    await set({ enterMode: 'newline' });
    await js('__zmark.editor.appendEmptyBlock()');
    await type('第一行');
    await key('Enter');
    await type('第二行');
    v = await val();
    check('编辑器：Enter 换行模式', v === '第一行\n第二行', JSON.stringify(v));
    await key('Enter', ['shift']);
    check('编辑器：Enter 换行模式下 Shift+Enter 新段落', (await val()) === '', JSON.stringify(await val()));
    await key('Escape');
    await set({ enterMode: 'paragraph' });

    await js('__zmark.editor.appendEmptyBlock()');
    await type('调用 f');
    const p1 = await kd('(');
    v = await val();
    check('编辑器：自动配对括号', p1 && v === '调用 f()' && (await caret()) === 5, JSON.stringify([v, await caret()]));
    await type('x');
    await kd(')');
    check('编辑器：输入右括号时跳过自动补全的括号', (await val()) === '调用 f(x)' && (await caret()) === 7, JSON.stringify([await val(), await caret()]));
    await kd('[');
    await kd('Backspace');
    check('编辑器：退格成对删除', (await val()) === '调用 f(x)', await val());
    await type(' it');
    check('编辑器：英文撇号不配对', (await kd("'")) === false);
    await type('“');
    check('编辑器：输入法全角引号自动配对', (await val()).endsWith('“”'), await val());
    await type('”');
    check('编辑器：全角右引号跳过已补全的引号', (await val()).endsWith('“”') && (await caret()) === (await val()).length, JSON.stringify([await val(), await caret()]));
    await js('__zmark.editor.hl.ta.setSelectionRange(0, 2)');
    await kd('*');
    check('编辑器：选中文字后输入 * 自动包裹', (await val()).startsWith('*调用*'), await val());
    await set({ autoPair: false, wrapSelection: false });
    await js('__zmark.editor.hl.ta.setSelectionRange(1, 3)');
    check('编辑器：关闭自动配对与包裹', (await kd('(')) === false && (await kd('*')) === false);
    await set({ autoPair: true, wrapSelection: true });
    await key('Escape');

    await set({ livePreview: false });
    await js('__zmark.editor.appendEmptyBlock()');
    await type('| a | b |\n| --- | --- |\n| 1 | 2 |');
    await wait(350);
    check('编辑器：关闭实时预览', await js('document.querySelector(".md-live-preview").hidden'));
    await set({ livePreview: true });
    await wait(100);
    check('编辑器：开启实时预览', await js('!document.querySelector(".md-live-preview").hidden && !!document.querySelector(".md-live-preview table")'));
    await key('Escape');

    await set({ tabSize: 2 });
    await js('__zmark.editor.appendEmptyBlock()');
    await type('```js');
    await key('Enter');
    await key('Tab');
    check('编辑器：Tab 宽度 2', (await val()) === '```js\n  \n```', JSON.stringify(await val()));
    await set({ insertSpaces: false });
    await key('Tab');
    check('编辑器：使用制表符缩进', (await val()) === '```js\n  \t\n```', JSON.stringify(await val()));
    await set({ tabSize: 4, insertSpaces: true });
    await key('Escape');

    await set({ listMarker: '*', strongMarker: '__', emMarker: '_' });
    await js('__zmark.editor.appendEmptyBlock()');
    await type('项目');
    await js('__zmark.runCommand("para.ul")');
    check('Markdown：无序列表符号 *', (await val()) === '* 项目', await val());
    await js('__zmark.editor.hl.ta.setSelectionRange(2, 4)');
    await js('__zmark.runCommand("fmt.bold")');
    check('Markdown：加粗符号 __', (await val()) === '* __项目__', await val());
    await js('__zmark.runCommand("fmt.italic")');
    check('Markdown：斜体符号 _（加粗文字上叠加斜体）', (await val()) === '* ___项目___', await val());
    await js('__zmark.runCommand("fmt.italic")');
    check('编辑器：再次切换斜体只移除斜体、保留加粗', (await val()) === '* __项目__', await val());
    await set({ listMarker: '-', strongMarker: '**', emMarker: '*' });
    await key('Escape');

    /* 通用：保存相关 */
    await set({ defaultEol: 'CRLF', trimTrailingWhitespace: true });
    const f2 = path.join(OUT, 'eol-test.md');
    await js(`__zmark.loadText(${JSON.stringify('第一行   \n第二行\t\n\n```\ncode   \n```')}, {})`);
    await js(`__zmark.state.filePath = ${JSON.stringify(f2)}; __zmark.save(false, true)`);
    await wait(300);
    const raw2 = fs.readFileSync(f2, 'utf8');
    check('通用：新建文件使用 CRLF、保存时删除行尾空格（保留硬换行与代码块）', raw2 === '第一行  \r\n第二行\r\n\r\n```\r\ncode   \r\n```\r\n', JSON.stringify(raw2));
    await set({ defaultEol: 'LF', trimTrailingWhitespace: false, insertFinalNewline: true });
    const f3 = path.join(OUT, 'final-newline.md');
    fs.writeFileSync(f3, 'abc');
    await js(`__zmark.openPath(${JSON.stringify(f3)}, {force: true, skipConfirm: true})`);
    await wait(200);
    await js('__zmark.save(false, true)');
    await wait(300);
    check('通用：保存时确保文件以换行结尾', fs.readFileSync(f3, 'utf8') === 'abc\n', JSON.stringify(fs.readFileSync(f3, 'utf8')));
    check('通用：记录上次打开的文件', (await settings()).lastFile === f3, (await settings()).lastFile);
    await set({ insertFinalNewline: false });

    await set({ saveOnBlur: true });
    await js('__zmark.editor.replaceAllText("失焦保存 测试")');
    await js('window.dispatchEvent(new Event("blur"))');
    await wait(400);
    check('通用：失去焦点时自动保存', fs.readFileSync(f3, 'utf8').includes('失焦保存'), fs.readFileSync(f3, 'utf8'));
    await set({ saveOnBlur: false, autoSave: true, autoSaveDelay: 1 });
    await js('__zmark.editor.replaceAllText("自动保存 测试")');
    await wait(500);
    const early = fs.readFileSync(f3, 'utf8').includes('自动保存');
    await wait(1200);
    check('通用：自动保存延迟 1 秒', !early && fs.readFileSync(f3, 'utf8').includes('自动保存'), String(early));
    await set({ autoSave: false, autoSaveDelay: 2, externalChange: 'ignore' });

    await wait(50);
    fs.writeFileSync(f3, '外部修改\n');
    await js('window.dispatchEvent(new Event("focus"))');
    await wait(400);
    check('通用：外部修改「不检测」', !(await text()).includes('外部修改'));
    await set({ externalChange: 'auto' });
    await js('window.dispatchEvent(new Event("focus"))');
    await wait(500);
    check('通用：外部修改自动重新加载', (await text()) === '外部修改', await text());

    // 保存前检查磁盘上的文件是否被其它程序改动：不悄悄覆盖
    await js('__zmark.editor.replaceAllText("我的修改")');
    await wait(1100); // 保证修改时间不同
    fs.writeFileSync(f3, '别的程序写入\n');
    const autoRes = await js('__zmark.save(false, true)');
    await wait(300);
    check('保存：文件被其它程序改动后，自动保存不覆盖', autoRes === false && fs.readFileSync(f3, 'utf8') === '别的程序写入\n', String(autoRes));
    await wait(1100);
    fs.writeFileSync(f3, '别的程序再次写入\n');
    const manRes = await js('__zmark.save(false, false)');
    check('保存：手动保存时先询问，取消则不覆盖', manRes === false && fs.readFileSync(f3, 'utf8') === '别的程序再次写入\n', String(manRes));
    await set({ externalChange: 'ignore' });
    const forced = await js('__zmark.save(false, true)');
    check('保存：原子写入内容正确且不留临时文件', forced !== false && fs.readFileSync(f3, 'utf8') === '我的修改\n' && !fs.readdirSync(path.dirname(f3)).some((n) => /\.tmp$/.test(n)), fs.readdirSync(path.dirname(f3)).join(','));
    await set({ externalChange: 'auto' });

    // 编码：GBK / UTF-16 文件按原编码读取，保存后为 UTF-8（内容为 GBK 编码的「# 中文标题 / 你好」，CRLF 换行）
    const gbk = path.join(OUT, 'gbk.md');
    fs.writeFileSync(gbk, Buffer.from([0x23, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xea, 0xcc, 0xe2, 0x0d, 0x0a, 0x0d, 0x0a, 0xc4, 0xe3, 0xba, 0xc3]));
    await js(`__zmark.openPath(${JSON.stringify(gbk)}, { force: true, skipConfirm: true })`);
    await wait(300);
    const gbkText = await text();
    const gbkToast = await js('Array.from(document.querySelectorAll("#toast-root > *")).map((x) => x.textContent).join("|")');
    check('编码：GBK 文件正确读取并提示', gbkText === '# 中文标题\n\n你好' && /GB18030/.test(gbkToast), JSON.stringify([gbkText, gbkToast]));
    await js(`__zmark.editor.replaceAllText(${JSON.stringify('# 中文标题\n\n你好，世界')})`);
    await js('__zmark.save(false, true)');
    check('编码：保存为 UTF-8 并保留原换行符', fs.readFileSync(gbk, 'utf8') === '# 中文标题\r\n\r\n你好，世界', JSON.stringify(fs.readFileSync(gbk, 'utf8')));
    const u16 = path.join(OUT, 'utf16.md');
    fs.writeFileSync(u16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('UTF-16 文档', 'utf16le')]));
    await js(`__zmark.openPath(${JSON.stringify(u16)}, { force: true, skipConfirm: true })`);
    await wait(300);
    check('编码：UTF-16（BOM）文件正确读取', (await text()) === 'UTF-16 文档', await text());
    await js(`__zmark.openPath(${JSON.stringify(f3)}, { force: true, skipConfirm: true })`);
    await wait(200);

    await set({ recentLimit: 5 });
    for (let i = 0; i < 7; i++) await js(`window.zmark.invoke('app:addRecent', ${JSON.stringify(path.join(OUT, `recent-${i}.md`))})`);
    const rec = (await settings()).recentFiles;
    check('通用：最近文件数量', rec.length === 5 && rec[0].endsWith('recent-6.md'), JSON.stringify(rec));

    /* 导出 */
    await set({ theme: 'night', exportTheme: 'github', exportEmbedImages: true, headingNumbering: true, pdfPageSize: 'A5', pdfLandscape: true, pdfHeaderFooter: 'titlePage', pdfMargin: 'wide' });
    await js(`__zmark.loadText(${JSON.stringify('# 导出测试\n\n![logo](assets/pic.png)\n\n## 第一节\n\n正文')}, {filePath: ${JSON.stringify(DOC)}})`);
    await wait(300);
    const html = await js('__zmark.buildExportHtml(false)');
    check('导出：使用指定主题、嵌入图片、保留标题编号', html.includes('data-theme="github"') && /src="data:image\/png;base64,/.test(html) && /<body[^>]*class="[^"]*heading-numbering/.test(html));
    const pdf2 = path.join(OUT, 'export-a5-landscape.pdf');
    await js(`__zmark.exportDoc('pdf', ${JSON.stringify(pdf2)})`);
    const pdfText = fs.existsSync(pdf2) ? fs.readFileSync(pdf2).toString('latin1') : '';
    const mb = /\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(pdfText);
    check('导出：PDF 纸张 A5 横向', mb && Number(mb[1]) > Number(mb[2]) && Number(mb[1]) < 700, mb ? mb[0] : 'MediaBox not found');

    /* 恢复默认 */
    const recBefore = (await settings()).recentFiles.length;
    await js('__zmark.resetSettings()');
    await wait(300);
    const after = await settings();
    const ui = await js('({ cls: document.body.className, theme: document.body.dataset.theme, enter: __zmark.editor.prefs.enterMode, md: __zmark.editor.mdOptions })');
    check('恢复默认设置', after.theme === 'github' && !after.headingNumbering && after.recentLimit === 10 && after.exportTheme === 'current' && after.recentFiles.length === recBefore
      && ui.theme === 'github' && !/heading-numbering/.test(ui.cls) && ui.enter === 'paragraph' && ui.md.math === true && ui.md.lineNumbers === false, JSON.stringify(ui));
  }

  wc.once('did-finish-load', () => {
    run().catch((e) => check('自检脚本异常', false, e.stack || e.message)).finally(() => {
      const failed = results.filter((x) => !x.ok);
      const report = { time: new Date().toISOString(), total: results.length, passed: results.length - failed.length, failed: failed.length, results, consoleErrors };
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
      console.log(`\n自检完成：${report.passed}/${report.total} 通过`);
      app.exit(failed.length ? 1 : 0);
    });
  });
};
