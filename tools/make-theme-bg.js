// 生成「墨羽蓝调」主题的背景图：由同一张水彩原图得到日间版与夜间版（WebP）
// 用法：npx electron tools/make-theme-bg.js <原图.png> [预览图输出目录]
// 输出：src/renderer/assets/themes/moyu/bg-day.webp、bg-night.webp
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

dialog.showErrorBox = () => {};
const args = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/make-theme-bg\.js$/.test(a));
const SOURCE = args[0];
const PREVIEW = args[1];
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'themes', 'moyu');

// 在页面中执行：日间版保持原图；夜间版按明度做渐变映射，保留水彩的层次，
// 最亮的星星与云心留一点微光，四周再压暗一圈，让中间的书页成为视觉中心。
const PAGE_SCRIPT = `(async (src) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const make = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };

  const day = make();
  day.getContext('2d').drawImage(img, 0, 0);

  const night = make();
  const g = night.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H);
  const px = d.data;
  // 渐变映射：按原图的明度取色，从深夜蓝过渡到靛蓝、长春花蓝，最亮处（星星、云心）是带一点紫的微光。
  // 原图近似单色，这样得到的夜景干净，没有逐像素换算色相带来的杂色。
  const RAMP = [[0.00, 9, 12, 36], [0.30, 15, 20, 56], [0.55, 24, 31, 84], [0.78, 36, 46, 112], [0.92, 58, 70, 150], [1.00, 150, 162, 232]];
  const ramp = (t) => {
    for (let k = 1; k < RAMP.length; k++) {
      if (t <= RAMP[k][0]) {
        const a = RAMP[k - 1], b = RAMP[k];
        const u = (t - a[0]) / (b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
      }
    }
    return RAMP[RAMP.length - 1].slice(1);
  };
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], gg = px[i + 1], b = px[i + 2];
    const lum = (0.299 * r + 0.587 * gg + 0.114 * b) / 255;
    const t = Math.max(0, Math.min(1, (lum - 0.42) / 0.58));
    const c = ramp(Math.pow(t, 1.25));
    // 原图偏紫的部分（山丘、羽毛）保留一点紫调
    const purple = Math.max(0, Math.min(1, (r - gg) / 60)) * (1 - t * 0.6);
    px[i] = Math.round(Math.min(255, c[0] + 16 * purple));
    px[i + 1] = Math.round(c[1]);
    px[i + 2] = Math.round(Math.min(255, c[2] + 10 * purple));
  }
  g.putImageData(d, 0, 0);
  // 四周压暗
  const v = g.createRadialGradient(W / 2, H * 0.46, H * 0.25, W / 2, H * 0.5, W * 0.72);
  v.addColorStop(0, 'rgba(8, 11, 30, 0)');
  v.addColorStop(1, 'rgba(6, 8, 24, 0.5)');
  g.fillStyle = v;
  g.fillRect(0, 0, W, H);

  return { w: W, h: H, day: day.toDataURL('image/webp', 0.9), night: night.toDataURL('image/webp', 0.9), nightPng: night.toDataURL('image/png') };
})`;

app.whenReady().then(async () => {
  let code = 0;
  try {
    if (!SOURCE || !fs.existsSync(SOURCE)) throw new Error('用法：npx electron tools/make-theme-bg.js <原图.png>');
    const win = new BrowserWindow({ show: false, webPreferences: { webSecurity: false } });
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'css', 'themes.css')); // 任意本地页面，提供 canvas 环境
    const r = await win.webContents.executeJavaScript(`${PAGE_SCRIPT}(${JSON.stringify(pathToFileURL(SOURCE).href)})`);
    const bin = (u) => Buffer.from(u.split(',')[1], 'base64');
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'bg-day.webp'), bin(r.day));
    fs.writeFileSync(path.join(OUT, 'bg-night.webp'), bin(r.night));
    if (PREVIEW) fs.writeFileSync(path.join(PREVIEW, 'bg-night-preview.png'), bin(r.nightPng));
    console.log(`theme backgrounds written (${r.w}x${r.h})`);
  } catch (e) {
    console.error(e.message);
    code = 1;
  }
  app.exit(code);
});
