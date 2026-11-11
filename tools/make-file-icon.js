// 生成 .md 文档的文件图标：带折角的白色页面 + Markdown 标志（M↓）
// 用法：npx electron tools/make-file-icon.js [预览图输出路径]
// 输出 build/md-file.ico（多尺寸）与 build/md-file.png（256px），由 package.json 的 fileAssociations 引用
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'build');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const PREVIEW = process.argv.find((a) => /\.png$/i.test(a) && !a.startsWith('-'));

function toIco(pngs) {
  const header = Buffer.alloc(6);
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

// 在页面中执行：逐个尺寸用矢量方式绘制（小尺寸也保持清晰），返回各尺寸 PNG 与一张预览图
const PAGE_SCRIPT = `((sizes, wantPreview) => {
  function draw(S) {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const lw = Math.max(1, S / 128);
    const snap = (v) => Math.round(v) + (lw % 2 === 1 ? 0.5 : 0);

    // 页面
    const x0 = snap(S * 0.15), x1 = snap(S * 0.85), y0 = snap(S * 0.03), y1 = snap(S * 0.97);
    const w = x1 - x0, f = Math.round(w * 0.3), r = Math.max(1, S * 0.03);
    const page = new Path2D();
    page.moveTo(x0 + r, y0);
    page.lineTo(x1 - f, y0);
    page.lineTo(x1, y0 + f);
    page.lineTo(x1, y1 - r);
    page.arcTo(x1, y1, x1 - r, y1, r);
    page.lineTo(x0 + r, y1);
    page.arcTo(x0, y1, x0, y1 - r, r);
    page.lineTo(x0, y0 + r);
    page.arcTo(x0, y0, x0 + r, y0, r);
    page.closePath();
    g.save();
    if (S >= 32) { g.shadowColor = 'rgba(40, 52, 130, 0.28)'; g.shadowBlur = S / 36; g.shadowOffsetY = S / 96; }
    const pg = g.createLinearGradient(0, y0, 0, y1);
    pg.addColorStop(0, '#ffffff');
    pg.addColorStop(1, '#eef0ff');
    g.fillStyle = pg;
    g.fill(page);
    g.restore();
    g.lineWidth = lw;
    g.strokeStyle = '#8d98dc';
    g.lineJoin = 'round';
    g.stroke(page);

    // 折角
    const fold = new Path2D();
    fold.moveTo(x1 - f, y0);
    fold.lineTo(x1 - f, y0 + f - r);
    fold.arcTo(x1 - f, y0 + f, x1 - f + r, y0 + f, r);
    fold.lineTo(x1, y0 + f);
    fold.closePath();
    const fg = g.createLinearGradient(x1 - f, y0 + f, x1, y0);
    fg.addColorStop(0, '#b9c1f4');
    fg.addColorStop(1, '#e3e6fc');
    g.fillStyle = fg;
    g.fill(fold);
    g.stroke(fold);

    // Markdown 标志：蓝色圆角块 + 白色 M↓（页面中只有这一个元素）
    const bw = Math.round(w * (S >= 64 ? 0.78 : 0.84));
    const bh = Math.round(bw * 0.62);
    const cy = S >= 64 ? S * 0.56 : S * 0.6;
    const bx = Math.round((x0 + x1) / 2 - bw / 2);
    const by = Math.round(cy - bh / 2);
    const br = Math.max(1, bh * 0.18);
    const mark = new Path2D();
    mark.roundRect(bx, by, bw, bh, br);
    const mg = g.createLinearGradient(bx, by, bx + bw, by + bh);
    mg.addColorStop(0, '#7186f2');
    mg.addColorStop(1, '#4553c4');
    g.fillStyle = mg;
    g.fill(mark);

    g.strokeStyle = '#ffffff';
    g.fillStyle = '#ffffff';
    g.lineCap = 'butt';
    g.lineJoin = 'miter';
    const t = Math.max(1.2, bh * 0.15);           // 笔画粗细
    const pad = bw * 0.13, top = by + bh * 0.25, bot = by + bh * 0.75;
    const mx0 = bx + pad, mx1 = bx + bw * 0.56;  // M 的左右边
    g.lineWidth = t;
    g.beginPath();
    g.moveTo(mx0 + t / 2, bot);
    g.lineTo(mx0 + t / 2, top);
    g.lineTo((mx0 + mx1) / 2, top + (bot - top) * 0.5);
    g.lineTo(mx1 - t / 2, top);
    g.lineTo(mx1 - t / 2, bot);
    g.stroke();
    const ax = bx + bw - pad - bw * 0.09;          // 箭头
    const aw = bw * 0.13;
    g.beginPath();
    g.moveTo(ax, top);
    g.lineTo(ax, bot - aw * 0.9);
    g.stroke();
    g.beginPath();
    g.moveTo(ax - aw, bot - aw * 1.1);
    g.lineTo(ax + aw, bot - aw * 1.1);
    g.lineTo(ax, bot + t * 0.15);
    g.closePath();
    g.fill();
    return c;
  }

  const out = {};
  const canvases = {};
  for (const s of sizes) { canvases[s] = draw(s); out[s] = canvases[s].toDataURL('image/png'); }

  if (wantPreview) {
    // 预览：浅色 / 深色背景各一行，每个尺寸按 2 倍像素放大展示
    const show = [256, 96, 48, 32, 24, 16];
    const W = show.reduce((a, s) => a + Math.max(s, 32) * (s < 64 ? 3 : 1) + 24, 24);
    const H = 2 * (256 + 48);
    const p = document.createElement('canvas');
    p.width = W; p.height = H;
    const pg = p.getContext('2d');
    ['#f3f3f3', '#202020'].forEach((bg, row) => {
      pg.fillStyle = bg;
      pg.fillRect(0, row * H / 2, W, H / 2);
      let x = 24;
      for (const s of show) {
        const k = s < 64 ? 3 : 1;
        pg.imageSmoothingEnabled = false;
        pg.drawImage(canvases[s], x, row * H / 2 + 24, s * k, s * k);
        x += Math.max(s, 32) * k + 24;
      }
    });
    out.preview = p.toDataURL('image/png');
  }
  return out;
})`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { webSecurity: false } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'css', 'themes.css')); // 任意本地页面，提供 canvas 环境
  const urls = await win.webContents.executeJavaScript(`${PAGE_SCRIPT}(${JSON.stringify(SIZES)}, ${!!PREVIEW})`);
  const png = (u) => Buffer.from(u.split(',')[1], 'base64');
  const pngs = SIZES.map((size) => ({ size, data: png(urls[size]) }));
  fs.writeFileSync(path.join(OUT, 'md-file.png'), pngs[pngs.length - 1].data);
  fs.writeFileSync(path.join(OUT, 'md-file.ico'), toIco(pngs));
  if (PREVIEW) fs.writeFileSync(PREVIEW, png(urls.preview));
  console.log('md-file icon written');
  app.quit();
});
