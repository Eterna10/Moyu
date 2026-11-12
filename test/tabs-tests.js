// 标签页自检：打开 / 切换 / 关闭、各自独立的撤销记录与滚动位置、未保存修改的确认、
// 改名与删除、崩溃恢复、会话恢复、关闭标签页功能后的单文档模式
const fs = require('fs');
const path = require('path');

module.exports = async function tabsTests(t) {
  const { js, check, wait, key, type, text, val, OUT, shot, app } = t;
  const set = async (patch) => { await js(`__zmark.setSetting(${JSON.stringify(patch)})`); await wait(150); };
  const open = async (p, opts) => { await js(`__zmark.openPath(${JSON.stringify(p)}, ${JSON.stringify(opts || {})})`); await wait(150); };
  const list = () => js('__zmark.tabs.list()');
  const names = async () => (await list()).map((x) => x.name + (x.dirty ? '*' : '') + (x.active ? '<' : ''));
  const clickTab = async (i, sel) => { await js(`document.querySelectorAll('#tabbar .tab')[${i}]${sel ? `.querySelector(${JSON.stringify(sel)})` : ''}.click()`); await wait(250); };
  const confirmWith = (v) => { global.__moyuConfirmSave = v; };
  const dir = path.join(OUT, 'tabs');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const A = path.join(dir, 'a.md');
  const B = path.join(dir, 'b.md');
  const C = path.join(dir, 'c.md');
  const A2 = path.join(dir, 'sub', 'a.md');
  fs.writeFileSync(A, '# A\n\n甲文档\n');
  fs.writeFileSync(B, '# B\n\n乙文档\n');
  fs.writeFileSync(C, ['# C', ''].concat(Array.from({ length: 80 }, (_, i) => `丙文档第 ${i} 段\n`)).join('\n'));
  fs.writeFileSync(A2, '子目录里的 A\n');
  await set({ tabs: true, richMode: false, autoSave: false, externalChange: 'auto', restoreScroll: false });

  /* ---------------- 打开与切换 ---------------- */
  confirmWith(1); // 清理之前的测试留下的标签页：不保存
  await js('__zmark.tabs.closeAll()');
  await wait(200);
  let l = await list();
  check('标签页：只有一个文档时不显示标签栏', l.length === 1 && !l[0].path && (await js('document.querySelector("#tabbar").hidden')), JSON.stringify(l));
  await open(A);
  check('标签页：空白文档被直接复用，不会多出一个标签页', (await names()).join() === 'a.md<');
  await open(B);
  check('标签页：再打开文件时在新标签页中打开，原文档保留', (await names()).join() === 'a.md,b.md<' && !(await js('document.querySelector("#tabbar").hidden')) && (await js('document.querySelectorAll("#tabbar .tab").length')) === 2 && (await text()) === '# B\n\n乙文档');
  await js('__zmark.editor.activateRange(2, 3)');
  await type('，已修改');
  await wait(150);
  await clickTab(0);
  l = await list();
  check('标签页：点击标签切换文档，未保存的文档带有标记', l[0].active && l[1].dirty && (await text()) === '# A\n\n甲文档' && (await js('document.querySelectorAll("#tabbar .tab")[1].classList.contains("dirty")')) && (await js('__zmark.docName()')) === 'a.md', JSON.stringify(l));
  await clickTab(1);
  const backB = { t: await text(), editing: await js('__zmark.editor.isEditing()'), v: await val() };
  check('标签页：切回后内容与光标位置都还在', backB.t === '# B\n\n乙文档，已修改' && backB.editing && backB.v === '乙文档，已修改', JSON.stringify(backB));
  await key('Z', ['control']);
  await wait(150);
  check('标签页：每个标签页有自己的撤销记录', (await text()) === '# B\n\n乙文档', await text());
  await key('Y', ['control']);
  await key('Escape');
  await open(C);
  await js('document.querySelector("#content").scrollTop = 900');
  await wait(100);
  await clickTab(0);
  const topA = await js('document.querySelector("#content").scrollTop');
  await clickTab(2);
  await wait(100);
  check('标签页：每个标签页记住自己的滚动位置', topA === 0 && Math.abs((await js('document.querySelector("#content").scrollTop')) - 900) < 3, String(await js('document.querySelector("#content").scrollTop')));
  await open(A);
  check('标签页：打开已经开着的文件时切换过去，不重复打开', (await names()).join() === 'a.md<,b.md*,c.md');
  await open(A2);
  const dirs = await js('Array.from(document.querySelectorAll("#tabbar .tab")).map((x) => (x.querySelector(".tab-dir") || {}).textContent || "")');
  check('标签页：同名文件用所在文件夹区分', (await names()).join() === 'a.md,a.md<,b.md*,c.md' && dirs.join() === 'tabs,sub,,', JSON.stringify(dirs));
  await shot('30-标签页.png');

  /* ---------------- 源代码模式 ---------------- */
  await js('__zmark.toggleSource()');
  await wait(200);
  const srcA2 = await js('__zmark.source.value');
  await js(`__zmark.tabs.switchTo(${(await list()).findIndex((x) => x.path === C)})`);
  await wait(300);
  const srcC = await js('__zmark.source.value');
  await js('__zmark.source.ta.focus(); __zmark.source.ta.setSelectionRange(0, 0); document.execCommand("insertText", false, "源码模式下的修改 "); 1');
  await wait(200);
  await js(`__zmark.tabs.switchTo(${(await list()).findIndex((x) => x.path === A2)})`);
  await wait(300);
  const srcBack = await js('__zmark.source.value');
  await js('__zmark.toggleSource()');
  await wait(200);
  l = await list();
  check('标签页：源代码模式下切换标签页，各自的源码与修改都保留', srcA2 === '子目录里的 A' && /^# C/.test(srcC) && srcBack === '子目录里的 A' && l.find((x) => x.path === C).dirty && (await text()) === '子目录里的 A', JSON.stringify([srcA2, srcC.slice(0, 10), srcBack]));
  confirmWith(1);
  await js(`__zmark.tabs.close(${l.findIndex((x) => x.path === C)})`);
  await open(C);
  await open(A2);

  /* ---------------- 键盘 ---------------- */
  await js('__zmark.editor.activateRange(0, 1)');
  const before = await text();
  await key('Tab', ['control']);
  await wait(250);
  const afterNext = (await list()).findIndex((x) => x.active);
  await key('Tab', ['control', 'shift']);
  await wait(250);
  check('标签页：Ctrl+Tab / Ctrl+Shift+Tab 切换，不会在文档里插入缩进', afterNext === 2 && (await list()).findIndex((x) => x.active) === 1 && (await text()) === before, JSON.stringify([afterNext, await text()]));
  await js('__zmark.runCommand("file.close")'); // 菜单快捷键 Ctrl+W 对应的命令
  await wait(250);
  check('标签页：Ctrl+W 关闭当前标签页（窗口保持打开）', (await names()).join() === 'a.md,b.md*<,c.md', JSON.stringify(await names()));
  await js('__zmark.runCommand("file.reopenClosed")');
  await wait(300);
  check('标签页：重新打开关闭的标签页', (await list()).some((x) => x.active && x.path === A2), JSON.stringify(await names()));

  /* ---------------- 关闭与确认 ---------------- */
  const bi = async () => (await list()).findIndex((x) => x.path === B);
  confirmWith(2); // 取消
  await clickTab(await bi(), '.tab-close');
  check('标签页：关闭有未保存修改的标签页时先询问，取消则保留', (await list()).some((x) => x.path === B && x.dirty && x.active));
  check('标签页：关闭窗口前逐个确认未保存的标签页，取消则不关闭', (await js('__zmark.tabs.confirmAll()')) === false);
  confirmWith(0); // 保存
  await clickTab(await bi(), '.tab-close');
  check('标签页：选择保存后写入磁盘并关闭', !(await list()).some((x) => x.path === B) && fs.readFileSync(B, 'utf8') === '# B\n\n乙文档，已修改\n', JSON.stringify(await names()));
  await open(B);
  await js('__zmark.editor.replaceAllText("不想保存的内容")');
  confirmWith(1); // 不保存
  await clickTab(await bi(), '.tab-close');
  check('标签页：选择不保存则丢弃修改', !(await list()).some((x) => x.path === B) && fs.readFileSync(B, 'utf8') === '# B\n\n乙文档，已修改\n');
  const ai = (await list()).findIndex((x) => x.path === A);
  await js(`document.querySelectorAll('#tabbar .tab')[${ai}].dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }))`);
  await wait(250);
  check('标签页：鼠标中键关闭', !(await list()).some((x) => x.path === A), JSON.stringify(await names()));

  /* ---------------- 顺序与右键菜单 ---------------- */
  await open(A);
  await open(B);
  let order = (await list()).map((x) => path.basename(path.dirname(x.path)) + '/' + x.name);
  await js('__zmark.tabs.move(0, null)');
  const moved = (await list()).map((x) => path.basename(path.dirname(x.path)) + '/' + x.name);
  check('标签页：拖动调整顺序', moved.join() === order.slice(1).concat(order[0]).join() && (await js('Array.from(document.querySelectorAll("#tabbar .tab .tab-name")).map((x) => x.firstChild.textContent)')).join() === moved.map((x) => x.split('/')[1]).join(), JSON.stringify([order, moved]));
  const menu = await js('__zmark.tabs.menu(0).items.map((i) => i.type === "separator" ? "-" : i.label + (i.enabled === false ? "(x)" : ""))');
  check('标签页：右键菜单', menu.join() === '关闭,关闭其他标签页,关闭右侧的标签页,-,复制路径,在资源管理器中显示', JSON.stringify(menu));
  const pt = await js('(() => { const r = document.querySelector("#tabbar .tab").getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + 10) }; })()');
  const viaWs = await js(`(() => { const m = __zmark.ws.buildMenu({ x: ${pt.x}, y: ${pt.y}, suggestions: [] }); return m && m.items[0].label; })()`);
  check('标签页：在标签上点右键弹出标签页菜单', viaWs === '关闭');
  const keep = (await list()).findIndex((x) => x.path === C);
  await js(`__zmark.tabs.menu(${keep}).run('others')`);
  await wait(300);
  check('标签页：关闭其他标签页', (await names()).join() === 'c.md<' && (await js('document.querySelector("#tabbar").hidden')), JSON.stringify(await names()));

  /* ---------------- 自动保存、外部修改、改名、删除 ---------------- */
  await open(A);
  await open(B);
  await set({ autoSave: true, autoSaveDelay: 30 });
  await js('__zmark.editor.replaceAllText("# B\\n\\n切换前自动保存")');
  await js('__zmark.tabs.switchTo(1)'); // a.md
  await wait(400);
  check('标签页：开着自动保存时，切换标签页前先保存', fs.readFileSync(B, 'utf8') === '# B\n\n切换前自动保存\n' && !(await list()).some((x) => x.dirty), JSON.stringify(await names()));
  await set({ autoSave: false, autoSaveDelay: 2 });
  await wait(1100);
  fs.writeFileSync(B, '# B\n\n别的程序改过了\n');
  await js(`__zmark.tabs.switchTo(${await bi()})`);
  await wait(600);
  check('标签页：后台标签页的文件被其他程序修改，切换过去时重新载入', (await text()) === '# B\n\n别的程序改过了', await text());
  await js(`__zmark.tabs.switchTo(${(await list()).findIndex((x) => x.path === A)})`);
  await wait(200);
  const B2 = await js(`__zmark.ws.renamePath(${JSON.stringify(B)}, "b2")`);
  await wait(250);
  check('标签页：后台标签页的文件被改名后跟随到新路径', B2 === path.join(dir, 'b2.md') && (await list()).some((x) => x.path === B2 && x.name === 'b2.md') && !(await list()).some((x) => x.path === B), JSON.stringify(await list()));
  await js(`__zmark.ws.deletePath(${JSON.stringify(B2)}, { skipConfirm: true })`);
  await wait(250);
  l = await list();
  const orphan = l.find((x) => x.name === 'b2.md');
  check('标签页：后台标签页的文件被删除后，内容保留为未保存的文档', !!orphan && orphan.path === null && orphan.dirty && !fs.existsSync(B2), JSON.stringify(l));
  await js(`__zmark.tabs.switchTo(${l.indexOf(orphan)})`);
  await wait(200);
  check('标签页：被删除文件的内容仍然可以取回', (await text()) === '# B\n\n别的程序改过了');

  /* ---------------- 崩溃恢复 ---------------- */
  await js('window.zmark.invoke("recovery:list").then((x) => Promise.all(x.map((d) => window.zmark.invoke("recovery:clear", d.key))))');
  await js(`__zmark.tabs.switchTo(${(await list()).findIndex((x) => x.path === A)})`);
  await wait(200);
  await js('__zmark.editor.replaceAllText("# A\\n\\n甲文档的未保存修改")');
  await js('__zmark.ws.syncRecovery()');
  const recDir = path.join(app.getPath('userData'), 'recovery');
  const recs = () => fs.readdirSync(recDir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(recDir, n), 'utf8')).name).sort();
  check('崩溃恢复：每个有未保存修改的标签页各有一份恢复数据', recs().join() === 'a.md,b2.md', recs().join());
  confirmWith(1);
  await js(`__zmark.tabs.close(${(await list()).findIndex((x) => x.name === 'b2.md')})`);
  await wait(300);
  check('崩溃恢复：关闭标签页后清除它的恢复数据', recs().join() === 'a.md', recs().join());
  // 模拟崩溃后重启：恢复区里留有两份文档，逐个恢复到各自的标签页
  const one = fs.readdirSync(recDir).find((n) => n.endsWith('.json'));
  fs.copyFileSync(path.join(recDir, one), path.join(recDir, 'crash-aaa-1.json'));
  fs.writeFileSync(path.join(recDir, 'crash-bbb-2.json'), JSON.stringify({ filePath: null, name: '草稿', text: '还没保存过的草稿', savedAt: Date.now() - 5000 }));
  const nBefore = (await list()).length;
  await js('__zmark.ws.showRecovery(false)');
  await wait(250);
  await js('document.querySelector(".recover-item [data-act=restore]").click()');
  await wait(400);
  const still = await js('document.querySelectorAll(".recover-item").length');
  await js('document.querySelector(".recover-item [data-act=restore]").click()');
  await wait(400);
  l = await list();
  // a.md 已经开着：恢复到它所在的标签页；草稿是新文档：占一个新标签页
  check('崩溃恢复：多份文档可以连续恢复，已打开的文件恢复到原标签页，不重复打开', still === 1 && !(await js('!!document.querySelector(".recover-modal")')) && l.length === nBefore + 1 && l.filter((x) => x.path === A).length === 1 && l.find((x) => x.path === A).dirty && l.some((x) => x.name === '草稿' && x.dirty), JSON.stringify(l));

  /* ---------------- 会话恢复 ---------------- */
  confirmWith(1);
  await js('__zmark.tabs.closeAll()');
  await open(A);
  await open(C);
  await open(A2);
  await js('__zmark.tabs.switchTo(1)');
  await wait(300);
  const s = await js('window.zmark.invoke("settings:get")');
  check('会话：记住打开着的标签页与当前文档', JSON.stringify(s.sessionTabs) === JSON.stringify([A, C, A2]) && s.sessionActive === C, JSON.stringify([s.sessionTabs, s.sessionActive]));
  await js('__zmark.tabs.closeAll()');
  await wait(200);
  fs.rmSync(A2);
  await set({ sessionTabs: [A, C, A2, path.join(dir, '不存在.md')], sessionActive: C });
  const ok = await js('__zmark.tabs.restoreSession()');
  await wait(400);
  l = await list();
  check('会话：启动时恢复上次的标签页（已不存在的文件跳过），当前文档立即显示', ok === true && l.map((x) => x.name).join() === 'a.md,c.md' && l[1].active && /丙文档第 0 段/.test(await text()), JSON.stringify(l));
  await js('__zmark.tabs.switchTo(0)');
  await wait(300);
  check('会话：后台恢复的标签页切换过去即可使用', (await text()) === '# A\n\n甲文档' && !(await list())[0].dirty);

  /* ---------------- 另存为、新建 ---------------- */
  await js('__zmark.newDoc()');
  await wait(200);
  check('标签页：新建文档在新标签页中打开', (await names()).join() === 'a.md,未命名<,c.md', JSON.stringify(await names()));
  await js('__zmark.newDoc()');
  check('标签页：已经是空白文档时不再新建', (await list()).length === 3);

  /* ---------------- 关闭标签页功能 ---------------- */
  confirmWith(1);
  await js('__zmark.tabs.closeAll()');
  await set({ tabs: false });
  await open(A);
  await js('__zmark.editor.replaceAllText("单文档模式下的修改")');
  confirmWith(2);
  await open(C);
  const kept = (await js('__zmark.state.filePath')) === A;
  confirmWith(1);
  await open(C);
  l = await list();
  check('单文档模式：关闭「在标签页中打开文档」后，打开文件替换当前文档并先询问', kept && l.length === 1 && l[0].path === C && (await js('document.querySelector("#tabbar").hidden')), JSON.stringify(l));
  await set({ tabs: true });
  global.__moyuConfirmSave = undefined;
  await js('__zmark.loadText("", {})');
};
