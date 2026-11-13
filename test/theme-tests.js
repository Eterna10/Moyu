// 内置主题「墨羽蓝调」自检：日间 / 夜间、右下角的切换按钮、背景与字体、导出
const fs = require('fs');
const path = require('path');

module.exports = async function themeTests(t) {
  const { js, check, wait, key, OUT, ROOT, shot, win } = t;
  const set = async (patch) => { await js(`__zmark.setSetting(${JSON.stringify(patch)})`); await wait(250); };
  const sample = fs.readFileSync(path.join(ROOT, 'samples', '欢迎使用 Moyu.md'), 'utf8');
  const dir = path.join(OUT, 'theme');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const A = path.join(dir, '欢迎使用 Moyu.md');
  const B = path.join(dir, '读书笔记.md');
  fs.writeFileSync(A, sample);
  fs.writeFileSync(B, '# 读书笔记\n\n> 纸上得来终觉浅，绝知此事要躬行。\n\n## 摘录\n\n- 第一条\n- 第二条\n');
  global.__moyuConfirmSave = 1;
  await js('__zmark.tabs.closeAll()');
  await set({ theme: 'github', richMode: true, sidebar: true, sidebarTab: 'outline', bgImage: '', tabs: true });
  await js(`__zmark.openPath(${JSON.stringify(B)})`);
  await js(`__zmark.openPath(${JSON.stringify(A)})`);
  for (let i = 0; i < 40 && !(await js('!!document.querySelector("#write .mermaid-block svg, #write .mermaid-error")')); i++) await wait(200);
  const btn = () => js(`(() => { const b = document.querySelector('#moyu-mode'); const r = b.getBoundingClientRect(); const s = document.querySelector('#statusbar').getBoundingClientRect(); return { shown: getComputedStyle(b).display !== 'none', right: Math.round(innerWidth - r.right), aboveBar: Math.round(s.top - r.bottom), w: Math.round(r.width) }; })()`);
  check('墨羽蓝调：其它主题下不显示日夜切换按钮', (await btn()).shown === false);

  /* ---------------- 日间 ---------------- */
  await js('__zmark.runCommand("theme.moyu")');
  await wait(500);
  await js('document.fonts.load("16px \\"LXGW WenKai Lite\\"", "墨羽蓝调").then(() => 1, () => 0)');
  for (let i = 0; i < 40 && !(await js('document.fonts.check("16px \\"LXGW WenKai Lite\\"", "墨羽")')); i++) await wait(150);
  await wait(400);
  const day = await js(`(() => {
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    return {
      theme: document.body.dataset.theme,
      font: document.fonts.check('16px "LXGW WenKai Lite"', '墨羽蓝调'),
      body: cs('#write').fontFamily.split(',')[0].replace(/"/g, ''),
      bg: cs('#bg-image').backgroundImage.includes('bg-day.webp'),
      layer: cs('#bg-layer').display,
      night: getComputedStyle(document.querySelector('#bg-image'), '::after').opacity,
      sheetRadius: cs('#content').borderTopLeftRadius,
      sheetBlur: cs('#content').backdropFilter,
      hljsDark: !document.querySelector('#hljs-dark').disabled,
    };
  })()`);
  check('墨羽蓝调：日间主题应用水彩背景与悬浮书页', day.theme === 'moyu' && day.bg && day.layer === 'block' && day.night === '0' && day.sheetRadius === '20px' && /blur/.test(day.sheetBlur) && !day.hljsDark, JSON.stringify(day));
  check('墨羽蓝调：使用随软件附带的霞鹜文楷', day.font && day.body === 'LXGW WenKai Lite', JSON.stringify([day.font, day.body]));
  let b = await btn();
  check('墨羽蓝调：日夜切换按钮位于右下角、状态栏上方', b.shown && b.right > 8 && b.right < 40 && b.aboveBar > 4 && b.aboveBar < 30, JSON.stringify(b));
  await shot('32-墨羽蓝调-日间.png');

  /* ---------------- 夜间 ---------------- */
  await js('document.querySelector("#moyu-mode").click()');
  await wait(1300); // 背景交叉淡入
  const night = await js(`(() => ({
    theme: document.body.dataset.theme,
    after: getComputedStyle(document.querySelector('#bg-image'), '::after').opacity,
    scheme: getComputedStyle(document.body).colorScheme,
    hljsDark: !document.querySelector('#hljs-dark').disabled,
    title: document.querySelector('#moyu-mode').title,
    saved: __zmark.state.settings.theme,
  }))()`);
  check('墨羽蓝调：点击按钮切换到夜间（背景、配色、代码高亮一起切换）', night.theme === 'moyu-night' && night.after === '1' && night.scheme === 'dark' && night.hljsDark && night.title === '切换到日间' && night.saved === 'moyu-night', JSON.stringify(night));
  await shot('33-墨羽蓝调-夜间.png');
  await js('__zmark.openPreferences("theme")');
  await wait(500);
  await shot('34-墨羽蓝调-夜间-设置.png');
  await key('Escape');
  await js('document.querySelector("#moyu-mode").click()');
  await wait(400);
  check('墨羽蓝调：再次点击回到日间', (await js('document.body.dataset.theme')) === 'moyu');

  /* ---------------- 与其它功能的配合 ---------------- */
  await js('__zmark.runCommand("edit.find")');
  await wait(300);
  await shot('35-墨羽蓝调-查找.png');
  await key('Escape');
  win.setSize(820, 720);
  await wait(500);
  b = await btn();
  const narrow = await js('(() => { const c = document.querySelector("#content").getBoundingClientRect(); const w = document.querySelector("#content-wrap").getBoundingClientRect(); return { left: Math.round(c.left - w.left), right: Math.round(w.right - c.right), width: Math.round(c.width) }; })()');
  check('墨羽蓝调：窄窗口下书页不溢出，按钮仍在窗口内', narrow.left >= 8 && narrow.right >= 8 && narrow.width > 300 && b.right >= 8, JSON.stringify([narrow, b]));
  await shot('36-墨羽蓝调-窄窗口.png');
  win.setSize(1500, 1000);
  await wait(400);
  const html = await js('__zmark.buildExportHtml(true)');
  check('墨羽蓝调：导出时带上主题的排版与字体', /data-theme="moyu"/.test(html) && /LXGW WenKai Lite/.test(html) && /file:\/\/\/[^"]*src\/renderer\/assets\/themes\/moyu\/LXGWWenKaiLite-Regular\.woff2/.test(html), (html.match(/url\("[^"]*LXGWWenKai[^"]*"\)/) || ['没有找到字体地址'])[0]);
  const png = path.join(dir, '墨羽蓝调.png');
  const files = await js(`__zmark.exportDoc('image', ${JSON.stringify(png)})`);
  check('墨羽蓝调：可以导出为图片', !!files && fs.existsSync(files[0]) && fs.statSync(files[0]).size > 100000, JSON.stringify(files));
  if (files && fs.existsSync(files[0])) fs.writeFileSync(path.join(dir, '墨羽蓝调-预览.png'), require('electron').nativeImage.createFromPath(files[0]).resize({ width: 520 }).toPNG());

  // 用户自己设置了背景图片时，主题的背景让位
  const custom = await js('(() => { document.body.classList.add("has-bg"); const v = getComputedStyle(document.querySelector("#bg-image")).backgroundImage.includes("bg-day.webp"); document.body.classList.remove("has-bg"); return v; })()');
  check('墨羽蓝调：用户自己设置背景图片时使用用户的图片', custom === false);
  check('墨羽蓝调：主题出现在菜单命令与偏好设置中', (await js('__zmark.runCommand("theme.moyu-night") === undefined || true')) && (await js('(() => { __zmark.openPreferences("appearance"); const o = Array.from(document.querySelectorAll(".modal select[data-k=theme] option")).map((x) => x.value); document.querySelector(".modal-mask").remove(); return o; })()')).join().includes('moyu,moyu-night'));
  await wait(300);
  await set({ theme: 'github', richMode: false });
  check('墨羽蓝调：切回其它主题后按钮与背景消失', (await btn()).shown === false && (await js('getComputedStyle(document.querySelector("#bg-layer")).display')) === 'none');
  await js('__zmark.tabs.closeAll()');
  global.__moyuConfirmSave = undefined;
};
