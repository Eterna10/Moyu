// 生成应用图标：把 build/icon-source.(webp|png|jpg) 转换为 build/icon.png（256px）与 build/icon.ico（多尺寸）
// 用法：npx electron tools/make-icon.js
// 图片四角的纯白背景会被去掉（从边缘向内填充为透明，遇到图标的深色描边即停止）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const OUT = path.join(__dirname, '..', 'build');
const SOURCE = ['webp', 'png', 'jpg'].map((e) => path.join(OUT, 'icon-source.' + e)).find((p) => fs.existsSync(p));
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function toIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    dir.push(e);
  }
  return Buffer.concat([header, ...dir, ...pngs.map((p) => p.data)]);
}

// 在页面中执行：载入图片 → 去掉边缘白底 → 逐级缩小到各尺寸，返回 PNG data URL
const PAGE_SCRIPT = `(async (src, sizes) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  const S = Math.min(img.naturalWidth, img.naturalHeight);
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.drawImage(img, (img.naturalWidth - S) / 2, (img.naturalHeight - S) / 2, S, S, 0, 0, S, S);
  const d = g.getImageData(0, 0, S, S);
  const px = d.data;
  const white = (i) => px[i] > 232 && px[i + 1] > 232 && px[i + 2] > 232;
  const seen = new Uint8Array(S * S);
  const stack = [];
  for (let k = 0; k < S; k++) stack.push(k, k + (S - 1) * S, k * S, k * S + S - 1);
  while (stack.length) {
    const p = stack.pop();
    if (seen[p] || !white(p * 4)) continue;
    seen[p] = 1;
    px[p * 4 + 3] = 0;
    const x = p % S, y = (p - x) / S;
    if (x > 0) stack.push(p - 1);
    if (x < S - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - S);
    if (y < S - 1) stack.push(p + S);
  }
  // 透明区域边界上的浅色像素按亮度淡出，避免白边
  for (let p = 0; p < S * S; p++) {
    if (seen[p]) continue;
    const x = p % S, y = (p - x) / S;
    const near = (x > 0 && seen[p - 1]) || (x < S - 1 && seen[p + 1]) || (y > 0 && seen[p - S]) || (y < S - 1 && seen[p + S]);
    if (near) { const m = Math.min(px[p * 4], px[p * 4 + 1], px[p * 4 + 2]); if (m > 150) px[p * 4 + 3] = Math.round(255 * (255 - m) / 105); }
  }
  g.putImageData(d, 0, 0);
  const out = {};
  for (const size of sizes) {
    let cur = c;
    while (cur.width / 2 >= size) { // 每次缩小一半，保证小尺寸清晰
      const h = document.createElement('canvas');
      h.width = h.height = Math.floor(cur.width / 2);
      const hg = h.getContext('2d');
      hg.imageSmoothingQuality = 'high';
      hg.drawImage(cur, 0, 0, h.width, h.height);
      cur = h;
    }
    const t = document.createElement('canvas');
    t.width = t.height = size;
    const tg = t.getContext('2d');
    tg.imageSmoothingQuality = 'high';
    tg.drawImage(cur, 0, 0, size, size);
    out[size] = t.toDataURL('image/png');
  }
  return out;
})`;

app.whenReady().then(async () => {
  if (!SOURCE) { console.error('未找到 build/icon-source.(webp|png|jpg)'); app.exit(1); return; }
  const win = new BrowserWindow({ show: false, webPreferences: { webSecurity: false } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'css', 'themes.css')); // 任意本地页面，用于读取本地图片
  const urls = await win.webContents.executeJavaScript(`${PAGE_SCRIPT}(${JSON.stringify(pathToFileURL(SOURCE).href)}, ${JSON.stringify(SIZES)})`);
  const pngs = SIZES.map((size) => ({ size, data: Buffer.from(urls[size].split(',')[1], 'base64') }));
  fs.writeFileSync(path.join(OUT, 'icon.png'), pngs[pngs.length - 1].data);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), toIco(pngs));
  console.log('icon written from', path.basename(SOURCE));
  app.quit();
});
