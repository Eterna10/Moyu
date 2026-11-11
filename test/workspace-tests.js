// 工作区功能自检：智能粘贴、表格操作、右键菜单、文件树管理、文件夹内搜索、复制为、崩溃恢复
const fs = require('fs');
const path = require('path');

module.exports = async function workspaceTests(t) {
  const { js, wc, check, wait, key, text, val, OUT, shot } = t;
  const set = async (patch) => { await js(`__zmark.setSetting(${JSON.stringify(patch)})`); await wait(150); };
  const load = (md, meta) => js(`__zmark.loadText(${JSON.stringify(md)}, ${JSON.stringify(meta || {})})`);
  // 在当前焦点处模拟粘贴，返回是否被智能粘贴接管
  const paste = (data) => js(`(() => {
    const dt = new DataTransfer();
    const d = ${JSON.stringify(data)};
    for (const k of Object.keys(d)) dt.setData(k, d[k]);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(ev);
    return ev.defaultPrevented;
  })()`);
  const center = (sel) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const labels = (items) => items.map((i) => (i.type === 'separator' ? '-' : i.label));
  const menuAt = async (pt, extra) => js(`(() => { const m = __zmark.ws.buildMenu(Object.assign({ x: ${pt.x}, y: ${pt.y}, isEditable: true, canCut: true, canCopy: true, canPaste: true, misspelledWord: '', suggestions: [] }, ${JSON.stringify(extra || {})})); return m ? m.items : null; })()`);

  /* ---------------- 智能粘贴 ---------------- */
  const HTML = '<meta charset="utf-8"><h2>标题</h2>\n<p>段落 <strong>加粗</strong> 和\n   <a href="https://example.com/a">链接</a></p><ul><li>一</li><li>二</li></ul>' +
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><p>2</p><p>3</p></td></tr></tbody></table><script>alert(1)</script>';
  const MD = '## 标题\n\n段落 **加粗** 和 [链接](https://example.com/a)\n\n- 一\n- 二\n\n| A | B |\n| --- | --- |\n| 1 | 2<br>3 |';
  for (const rich of [false, true]) {
    const tag = rich ? '纯文本模式' : '源码编辑';
    await set({ richMode: rich, smartPaste: true });
    await load('');
    await wait(100);
    const handled = await paste({ 'text/html': HTML, 'text/plain': '标题 段落 加粗 和 链接 一 二 A B 1 2 3' });
    await wait(200);
    check(`智能粘贴：网页内容转为 Markdown（${tag}）`, handled && (await text()).trim() === MD, JSON.stringify(await text()));
  }
  await set({ richMode: false });
  await load('点击这里查看');
  await js('__zmark.editor.activateRange(0, 1, 2, 4)');
  await wait(100);
  let handled = await paste({ 'text/plain': ' https://moyu.example/a?b=1 ' });
  await wait(150);
  check('智能粘贴：在选中的文字上粘贴网址生成链接', handled && (await text()) === '点击[这里](https://moyu.example/a?b=1)查看', await text());
  await load('');
  await js('__zmark.ws.pastePlain()');
  handled = await paste({ 'text/html': HTML, 'text/plain': 'x' });
  check('智能粘贴：「粘贴为纯文本」不转换', handled === false);
  await wait(900);
  await load('```js\nlet a;\n```');
  await js('__zmark.editor.activateRange(0, 3, 5)');
  handled = await paste({ 'text/html': HTML, 'text/plain': 'x' });
  check('智能粘贴：代码块中保持原样粘贴', handled === false);
  await key('Escape');
  await load('');
  handled = await paste({ 'text/html': '<div style="color:#ccc;font-family:Consolas;white-space: pre;"><div><span style="font-weight:bold">const</span> a = 1;</div></div>', 'text/plain': 'const a = 1;' });
  check('智能粘贴：代码编辑器复制的着色代码按纯文本处理', handled === false);
  handled = await paste({ 'text/html': '<b style="font-weight:normal"><p><span style="font-weight:700">粗</span><span>体和</span><span style="font-style:italic">斜</span><span>体</span></p></b>', 'text/plain': '粗体和斜体' });
  await wait(150);
  check('智能粘贴：识别用样式表示的加粗与斜体（Google 文档 / Word）', handled && (await text()).trim() === '**粗**体和*斜*体', await text());
  await load('');
  await set({ smartPaste: false });
  handled = await paste({ 'text/html': HTML, 'text/plain': 'x' });
  check('智能粘贴：可在偏好设置中关闭', handled === false);
  await set({ smartPaste: true });
  const conv = await js(`ZWorkspace.htmlToMarkdown(${JSON.stringify('<p>图 <img src="data:image/png;base64,AAAA"><img src="https://a.example/x.png" alt="网图"></p><pre><code class="language-js">a<br>b</code></pre><blockquote><p>引用</p></blockquote><ol start="3"><li>三</li></ol>')}, __zmark.editor.serOpts())`);
  check('智能粘贴：代码块、引用、有序列表与图片', conv === '图 ![网图](https://a.example/x.png)\n\n```\na\nb\n```\n\n> 引用\n\n3. 三', JSON.stringify(conv));

  /* ---------------- 表格操作 ---------------- */
  const TABLE = '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |';
  for (const rich of [false, true]) {
    const tag = rich ? '纯文本模式' : '源码编辑';
    await set({ richMode: rich });
    await load(TABLE);
    await js(`__zmark.editor.activateRange(0, 4, ${TABLE.indexOf('1')})`);
    await wait(150);
    if (rich) await js('__zmark.editor.richFocusCell(__zmark.editor.richEl.querySelectorAll("td")[0])'); // 相当于在该单元格中点击
    const ctx0 = await js('(() => { const c = __zmark.editor.tableContext(); return c && [c.row, c.col]; })()');
    await js('__zmark.editor.tableOp("rowBelow")');
    const v1 = await val();
    await js('__zmark.editor.tableOp("colRight")');
    const v2 = await val();
    await js('__zmark.editor.tableOp("alignCenter")');
    const v3 = await val();
    check(`表格：定位光标所在的单元格（${tag}）`, JSON.stringify(ctx0) === '[2,0]', JSON.stringify(ctx0));
    check(`表格：在下方插入行（${tag}）`, v1 === '| A | B |\n| --- | --- |\n| 1 | 2 |\n|   |   |\n| 3 | 4 |', JSON.stringify(v1));
    check(`表格：在右侧插入列并设置居中（${tag}）`, v2 === '| A |   | B |\n| --- | --- | --- |\n| 1 |   | 2 |\n|   |   |   |\n| 3 |   | 4 |' && v3.split('\n')[1] === '| --- | :---: | --- |', JSON.stringify([v2, v3]));
    await js('__zmark.editor.tableOp("delCol")');
    await js('__zmark.editor.tableOp("delRow")');
    const v4 = await val();
    check(`表格：删除列与行，表头不能删除（${tag}）`, v4 === TABLE && (await js(`(() => { const e = __zmark.editor; e.activateRange(0, 4, 2); if (e.rich) e.richFocusCell(e.richEl.querySelector("th")); return e.tableOp("delRow"); })()`)) === false, JSON.stringify(v4));
    await key('Z', ['control']);
    check(`表格：操作可以撤销（${tag}）`, (await text()).split('\n').length === 5, await text());
    await key('Escape');
  }
  await set({ richMode: true });

  /* ---------------- 右键菜单 ---------------- */
  await load(TABLE + '\n\n正文 teh 文字 [链接](https://example.com)');
  await wait(150);
  let pt = await center('#write td');
  let items = await menuAt(pt);
  const tbl = items && items.find((i) => i.label === '表格');
  check('右键菜单：在渲染的表格上点右键即可进行表格操作', !!tbl && labels(tbl.submenu).includes('在下方插入行') && (await js('__zmark.editor.isEditing()')), JSON.stringify(items && labels(items)));
  check('右键菜单：包含剪切 / 复制 / 粘贴、复制为、格式、段落、插入', ['剪切', '复制', '粘贴', '粘贴为纯文本', '全选', '复制为', '格式', '段落', '插入'].every((l) => labels(items).includes(l)), JSON.stringify(labels(items)));
  items = await menuAt(pt, { misspelledWord: 'teh', suggestions: ['the', 'ten'] });
  check('右键菜单：拼写建议排在最前，并可添加到词典', labels(items).slice(0, 3).join() === 'the,ten,将“teh”添加到词典', JSON.stringify(labels(items).slice(0, 4)));
  await key('Escape');
  pt = await center('#write a[href]');
  items = await menuAt(pt);
  check('右键菜单：链接上可打开或复制地址', labels(items).slice(0, 2).join() === '打开链接,复制链接地址', JSON.stringify(labels(items).slice(0, 3)));
  // 完整链路：主进程的右键事件 → 页面组装菜单 → 选择「加粗」
  await load('需要加粗的文字');
  await set({ richMode: false });
  await js('__zmark.editor.activateRange(0, 1, 2, 4)');
  await wait(100);
  pt = await center('.md-editing');
  let popped = null;
  global.__moyuMenuPick = (list) => { popped = list; return 'cmd:fmt.bold'; };
  wc.send('context-menu', { x: pt.x, y: pt.y, isEditable: true, canCut: true, canCopy: true, canPaste: true, misspelledWord: '', suggestions: [], selectionText: '加粗' });
  await wait(400);
  global.__moyuMenuPick = null;
  check('右键菜单：从菜单执行命令（加粗）', !!popped && (await text()) === '需要**加粗**的文字', await text());
  // 真实的右键事件：由 Chromium 产生 context-menu 事件，经主进程转给页面
  popped = null;
  global.__moyuMenuPick = (list) => { popped = list; return null; };
  wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'right', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'right', clickCount: 1 });
  for (let i = 0; i < 20 && !popped; i++) await wait(100);
  global.__moyuMenuPick = null;
  check('右键菜单：真实的右键事件能弹出菜单', !!popped && labels(popped).includes('粘贴') && labels(popped).includes('格式'), JSON.stringify(popped && labels(popped)));
  await key('Escape');
  await js('__zmark.runCommand("edit.find")');
  await wait(150);
  pt = await center('#find-input');
  items = await menuAt(pt);
  check('右键菜单：输入框中只有编辑操作', labels(items).join() === '剪切,复制,粘贴,-,全选', JSON.stringify(labels(items)));
  await key('Escape');

  /* ---------------- 文件树管理 ---------------- */
  const dir = path.join(OUT, 'ws');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'pic.bin'), 'x');
  fs.writeFileSync(path.join(dir, 'a.md'), '# Alpha\n\n第一段 Moyu 编辑器\n\n第二段 moyu 小写\n');
  fs.writeFileSync(path.join(dir, 'sub', 'b.md'), '子目录文档\r\n\r\nMoyu 在第三行，Moyu 出现两次\r\n');
  fs.writeFileSync(path.join(dir, 'c.txt'), '没有关键词');
  await set({ sidebar: true, sidebarTab: 'files' });
  await js(`__zmark.loadFolder(${JSON.stringify(dir)})`);
  await wait(200);
  const treeNames = () => js('Array.from(document.querySelectorAll("#file-tree .tree-item .label")).map((x) => x.textContent.replace("📁 ", ""))');
  const created = await js(`__zmark.ws.newFolderIn(${JSON.stringify(dir)}, "新文件夹")`);
  await wait(200);
  let names = await treeNames();
  check('文件树：新建文件夹（空文件夹也显示，只有图片的文件夹不显示）', !!created && fs.statSync(created).isDirectory() && names.includes('新文件夹') && !names.includes('assets'), JSON.stringify(names));
  const inNew = await js(`window.zmark.invoke('fs:newFile', ${JSON.stringify(path.join(dir, '新文件夹'))}, '笔记')`);
  check('文件树：在子文件夹中新建文件', fs.existsSync(inNew) && inNew.endsWith('笔记.md'));
  await js(`__zmark.openPath(${JSON.stringify(path.join(dir, 'a.md'))}, { force: true, skipConfirm: true })`);
  await wait(200);
  const renamed = await js(`__zmark.ws.renamePath(${JSON.stringify(path.join(dir, 'a.md'))}, "改名后")`);
  await wait(250);
  names = await treeNames();
  check('文件树：重命名（省略扩展名时沿用原扩展名），正在编辑的文档跟随到新路径', renamed === path.join(dir, '改名后.md') && fs.existsSync(renamed) && !fs.existsSync(path.join(dir, 'a.md')) && (await js('__zmark.state.filePath')) === renamed && names.includes('改名后.md') && (await js('document.querySelector(".tree-item.current .label").textContent')) === '改名后.md', JSON.stringify(names));
  const badName = await js(`__zmark.ws.renamePath(${JSON.stringify(renamed)}, "a/b")`);
  const dup = await js(`__zmark.ws.renamePath(${JSON.stringify(renamed)}, "c.txt")`);
  check('文件树：非法名称与重名被拒绝', badName === null && dup === null && fs.existsSync(renamed));
  const subRenamed = await js(`__zmark.ws.renamePath(${JSON.stringify(path.join(dir, 'sub'))}, "子目录")`);
  check('文件树：重命名文件夹', subRenamed === path.join(dir, '子目录') && fs.existsSync(path.join(dir, '子目录', 'b.md')));
  pt = await center('#file-tree > .tree-item.file');
  items = await menuAt(pt);
  check('文件树：文件的右键菜单', labels(items).join() === '打开,-,重命名…,删除,-,复制路径,在资源管理器中显示', JSON.stringify(labels(items)));
  pt = await center('#file-tree > .tree-item.dir');
  items = await menuAt(pt);
  check('文件树：文件夹的右键菜单', labels(items).slice(0, 2).join() === '新建文件…,新建文件夹…' && labels(items).includes('删除'), JSON.stringify(labels(items)));
  await shot('27-文件树管理.png');

  /* ---------------- 文件夹内搜索 ---------------- */
  let r = await js('__zmark.ws.openSearch("moyu")');
  await wait(200);
  check('搜索：在文件夹中查找（不区分大小写，含子目录与 CRLF 文件）', r && r.files.length === 2 && r.total === 4 && (await js('document.querySelector(".side-tab.active").dataset.tab')) === 'search' && (await js('document.querySelectorAll(".search-hit").length')) === 4, JSON.stringify(r && { n: r.files.length, total: r.total }));
  await shot('28-文件夹内搜索.png');
  const bi = r.files.findIndex((f) => f.name === 'b.md');
  await js(`__zmark.ws.openHit(${bi}, 1)`);
  await wait(400);
  const hit = await js('({ file: __zmark.state.filePath, sel: __zmark.editor.getSelectedText(), editing: __zmark.editor.isEditing(), v: __zmark.editor.hl.value })');
  check('搜索：点击结果打开文件并定位到匹配处', hit.file === path.join(dir, '子目录', 'b.md') && hit.editing && /Moyu 出现两次/.test(hit.v), JSON.stringify(hit));
  await js('document.querySelector("#search-case").click()');
  await wait(300);
  r = await js('__zmark.ws.searchState()');
  check('搜索：区分大小写', r.total === 1 && r.files.length === 1, String(r.total));
  await js('document.querySelector("#search-case").click()');
  await js('document.querySelector("#search-regex").click()');
  await wait(200);
  r = await js('__zmark.ws.openSearch("第.段")');
  check('搜索：正则表达式', r && r.total === 2 && r.files.length === 1, JSON.stringify(r && r.total));
  r = await js('__zmark.ws.openSearch("(")');
  await wait(100);
  check('搜索：无效的正则表达式给出提示', r === null && /正则表达式无效/.test(await js('document.querySelector("#search-status").textContent')));
  await js('document.querySelector("#search-regex").click()');
  r = await js('__zmark.ws.openSearch("改名")');
  check('搜索：文件名也参与匹配', r && r.files.length === 1 && r.files[0].nameHit && r.total === 0, JSON.stringify(r && r.files.map((f) => f.name)));
  r = await js('__zmark.ws.openSearch("不存在的内容xyz")');
  await wait(100);
  check('搜索：没有结果时给出提示', r.files.length === 0 && /没有找到/.test(await js('document.querySelector("#search-status").textContent')));

  /* ---------------- 删除 ---------------- */
  await js(`__zmark.openPath(${JSON.stringify(renamed)}, { force: true, skipConfirm: true })`);
  await wait(200);
  const before = await text();
  const del = await js(`__zmark.ws.deletePath(${JSON.stringify(renamed)}, { skipConfirm: true })`);
  await wait(250);
  const st = await js('({ file: __zmark.state.filePath, dirty: __zmark.isDirty(), name: __zmark.docName() })');
  check('文件树：删除正在编辑的文档后，内容保留为未保存的新文档', del === true && !fs.existsSync(renamed) && st.file === null && st.dirty && (await text()) === before && /改名后\.md/.test(st.name), JSON.stringify(st));
  check('文件树：删除需要确认（取消则保留）', (await js(`__zmark.ws.deletePath(${JSON.stringify(path.join(dir, 'c.txt'))})`)) === false && fs.existsSync(path.join(dir, 'c.txt')));

  /* ---------------- 复制为 ---------------- */
  await set({ sidebarTab: 'outline' });
  await load('# 标题\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [x] 完成\n\n`code`');
  const cMd = await js('__zmark.ws.copyAs("markdown")');
  const cHtml = await js('__zmark.ws.copyAs("html")');
  const cRich = await js('__zmark.ws.copyAs("rich")');
  check('复制为：Markdown 源码 / HTML 代码', cMd === (await text()) && /<h1[^>]*>.*标题/.test(cHtml) && /<table>/.test(cHtml), cHtml.slice(0, 80));
  check('复制为：富文本自带表格边框等样式，可粘贴到 Word / 公众号', /<table style="border-collapse:collapse/.test(cRich) && /<td style="border:1px solid/.test(cRich) && /☑/.test(cRich) && !/task-checkbox/.test(cRich), cRich.slice(0, 200));

  // 富文本需要窗口处于前台才能写入剪贴板；设置 MOYU_TEST_FOCUS=1 时把窗口切到前台实际验证一次
  if (process.env.MOYU_TEST_FOCUS) {
    t.win.show();
    t.win.focus();
    await wait(600);
    await js('__zmark.ws.copyAs("rich")');
    await wait(300);
    const back = await js(`navigator.clipboard.read().then(async (items) => { const it = items[0]; return { types: it.types, html: await (await it.getType('text/html')).text(), text: await (await it.getType('text/plain')).text() }; }).catch((e) => ({ error: String(e) }))`);
    check('复制为：前台窗口中富文本与纯文本同时写入剪贴板', !back.error && /border-collapse/.test(back.html) && /标题/.test(back.text), JSON.stringify(back).slice(0, 300));
  }

  /* ---------------- 崩溃恢复 ---------------- */
  await load('');
  await js('window.zmark.invoke("recovery:list").then((l) => Promise.all(l.map((x) => window.zmark.invoke("recovery:clear", x.key))))');
  await js('__zmark.editor.replaceAllText("尚未保存的重要内容\\n\\n第二段")');
  await js('__zmark.ws.syncRecovery()');
  const key1 = await js('__zmark.ws.recoveryKey()');
  const recFile = path.join(t.app.getPath('userData'), 'recovery', key1 + '.json');
  check('崩溃恢复：未保存的内容定期写入恢复区', fs.existsSync(recFile) && JSON.parse(fs.readFileSync(recFile, 'utf8')).text === '尚未保存的重要内容\n\n第二段');
  check('崩溃恢复：仍在运行的窗口的文档不会被当作可恢复项', (await js('window.zmark.invoke("recovery:list")')).length === 0);
  // 模拟崩溃后重新启动：恢复区留有上次的文件，而当前窗口是全新的
  const orphan = path.join(path.dirname(recFile), 'crashed-session-1.json');
  fs.copyFileSync(recFile, orphan);
  await load('');
  await js('__zmark.ws.syncRecovery()');
  check('崩溃恢复：文档变为已保存 / 为空后清除恢复数据', !fs.existsSync(recFile));
  const shown = await js('__zmark.ws.showRecovery(false)');
  await wait(200);
  check('崩溃恢复：启动时列出上次未保存的文档', shown === true && /尚未保存的重要内容/.test(await js('(document.querySelector(".recover-modal") || {}).textContent || ""')));
  await shot('29-崩溃恢复.png');
  await js('document.querySelector(".recover-item [data-act=restore]").click()');
  await wait(400);
  const rec = await js('({ t: __zmark.getText(), dirty: __zmark.isDirty(), modal: !!document.querySelector(".recover-modal") })');
  check('崩溃恢复：恢复后内容回到编辑器并标记为未保存', rec.t === '尚未保存的重要内容\n\n第二段' && rec.dirty && !rec.modal && !fs.existsSync(orphan), JSON.stringify(rec));
  await load('');
  await js('__zmark.ws.syncRecovery()');
  check('崩溃恢复：没有可恢复的内容时不弹窗', (await js('__zmark.ws.showRecovery(false)')) === false);

  /* ---------------- 跳转到标题 / 阅读位置 ---------------- */
  const longDoc = ['# 第一章', ''].concat(Array.from({ length: 60 }, (_, i) => `段落 ${i}\n`), ['## 第二节', ''], Array.from({ length: 60 }, (_, i) => `内容 ${i}\n`), ['### 小结', '', '结束']).join('\n');
  const posFile = path.join(OUT, 'position.md');
  fs.writeFileSync(posFile, longDoc);
  await set({ restoreScroll: true });
  await js(`__zmark.openPath(${JSON.stringify(posFile)}, { force: true, skipConfirm: true })`);
  await wait(300);
  await js('__zmark.runCommand("edit.gotoHeading")');
  await wait(250);
  const heads = await js('Array.from(document.querySelectorAll(".palette-item .pi-label")).map((x) => x.textContent)');
  await t.type('小结');
  await wait(200);
  const firstHead = await js('(document.querySelector(".palette-item.active .pi-label") || {}).textContent');
  // 平滑滚动需要动画帧，自检窗口被遮住时不会推进：这里直接确认滚动的目标是哪个标题
  await js('window.__scrolled = null; window.__siv = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = function (o) { window.__scrolled = this.textContent; return window.__siv.call(this, o); }; 1');
  await key('Enter');
  await wait(300);
  const afterJump = await js('(() => { Element.prototype.scrollIntoView = window.__siv; return window.__scrolled; })()');
  check('跳转到标题：Ctrl+G 列出当前文档的标题并跳转', heads.join() === '第一章,第二节,小结' && firstHead === '小结' && afterJump === '小结' && !(await js('!!document.querySelector(".palette-mask")')), JSON.stringify([heads, firstHead, afterJump]));
  await js('document.querySelector("#content").scrollTop = 1234');
  await wait(1300);
  const saved = (await js('window.zmark.invoke("settings:get")')).docPositions || {};
  await load('');
  await js(`__zmark.openPath(${JSON.stringify(posFile)}, { force: true, skipConfirm: true })`);
  await wait(500);
  const restored = await js('document.querySelector("#content").scrollTop');
  check('阅读位置：重新打开文件时回到上次滚动到的位置', saved[posFile] === 1234 && Math.abs(restored - 1234) < 3, JSON.stringify([saved[posFile], restored]));
  await set({ restoreScroll: false });

  /* ---------------- 无法识别的编码 ---------------- */
  const bad = path.join(OUT, 'binary.md');
  fs.writeFileSync(bad, Buffer.from([0x61, 0xff, 0xff, 0x80, 0x62]));
  await js(`__zmark.openPath(${JSON.stringify(bad)}, { force: true, skipConfirm: true })`);
  await wait(200);
  const lossy = await js('({ file: __zmark.state.filePath, title: __zmark.docName() })');
  check('编码：无法识别的文件作为副本打开，保存不会覆盖原文件', lossy.file === null && /binary（副本）\.md/.test(lossy.title), JSON.stringify(lossy));

  await load('');
  await set({ richMode: false, sidebarTab: 'outline' });
  await js('__zmark.loadFolder(null)').catch(() => {});
};
