/* Moyu — 自定义主题：背景图片（自动遮罩透明度）、强调色（可取自图片）、自定义 CSS、导入的字体 */
(function () {
  'use strict';

  const cache = new Map(); // 图片路径 → 分析结果
  let current = { path: null, stats: null };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const toHex = (rgb) => '#' + rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
  const fromHex = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
  const lumOf = (rgb) => (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;

  function parseCss(c) {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(c || '');
    return m ? [+m[1], +m[2], +m[3]] : (fromHex(c) || [255, 255, 255]);
  }

  /** 当前主题的背景色（用于计算遮罩） */
  function themeBg() {
    return parseCss(getComputedStyle(document.body).getPropertyValue('--bg').trim());
  }

  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }

  /** 分析图片：逐像素亮度（48×48 采样）与最突出的颜色 */
  async function analyze(dataUrl) {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const N = 48;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, N, N);
    const px = g.getImageData(0, 0, N, N).data;
    const lums = new Float32Array(N * N);
    const bins = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    let sum = 0;
    for (let i = 0; i < N * N; i++) {
      const rgb = [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]];
      const L = lumOf(rgb);
      lums[i] = L;
      sum += L;
      const [h, s, l] = rgbToHsl(rgb);
      if (s > 0.25 && l > 0.2 && l < 0.85) {
        const bin = bins[Math.floor(h / 15) % 24];
        const w = s * (1 - Math.abs(l - 0.5));
        bin.w += w; bin.r += rgb[0] * w; bin.g += rgb[1] * w; bin.b += rgb[2] * w;
      }
    }
    const mean = sum / (N * N);
    let v = 0;
    for (const L of lums) v += (L - mean) * (L - mean);
    const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
    const accent = best.w > N * N * 0.01 ? [best.r / best.w, best.g / best.w, best.b / best.w] : null;
    return { lums, mean, std: Math.sqrt(v / (N * N)), accent };
  }

  /**
   * 自动遮罩：遮罩为主题背景色，不透明度 a 使「图片亮度与主题背景的平均差异 + 图片自身的明暗起伏」被压到可读范围内。
   * 图片越接近主题底色、越平坦，遮罩越淡；越反差、越花哨，遮罩越浓。
   */
  function autoOverlay(stats, bgRgb) {
    const Lb = lumOf(bgRgb);
    let d = 0;
    for (const L of stats.lums) d += Math.abs(L - Lb);
    d /= stats.lums.length;
    const busy = d + 0.6 * stats.std;
    return Math.round(clamp(1 - 0.12 / Math.max(busy, 0.01), 0.45, 0.94) * 100) / 100;
  }

  /** 让强调色与主题明暗匹配：深色主题提亮、浅色主题压暗，保证与背景有足够对比 */
  function fitAccent(rgb, dark) {
    let c = rgb.slice();
    for (let i = 0; i < 12; i++) {
      const L = lumOf(c);
      if (dark && L < 0.42) c = c.map((v) => v + (255 - v) * 0.15);
      else if (!dark && L > 0.38) c = c.map((v) => v * 0.85);
      else break;
    }
    return c;
  }

  function ensureLayer() {
    let layer = document.getElementById('bg-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'bg-layer';
      layer.innerHTML = '<div id="bg-image"></div><div id="bg-overlay"></div>';
      document.body.insertBefore(layer, document.body.firstChild);
    }
    return layer;
  }

  function styleEl(id) {
    let el = document.getElementById(id);
    if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }
    return el;
  }

  /**
   * 应用个性化设置。api：window.moyu 预加载接口；dark：当前主题是否为深色。
   * 返回 { overlay, accent }（实际使用的遮罩不透明度与强调色），供设置界面显示
   */
  async function apply(s, api, dark) {
    const body = document.body;
    const layer = ensureLayer();
    let stats = null;
    let url = null;
    if (s.bgImage) {
      url = await api.invoke('theme:bgUrl', s.bgImage);
      if (url) {
        stats = cache.get(s.bgImage);
        if (!stats) {
          const data = await api.invoke('theme:bgData', s.bgImage);
          if (data) { stats = await analyze(data).catch(() => null); if (stats) cache.set(s.bgImage, stats); }
        }
      }
    }
    current = { path: url ? s.bgImage : null, stats };
    body.classList.toggle('has-bg', !!url);
    body.classList.toggle('bg-panels', !!url && s.bgPanels !== false);
    let overlay = null;
    if (url) {
      const img = layer.firstChild;
      img.style.backgroundImage = `url("${url}")`;
      img.style.backgroundSize = s.bgFit === 'contain' ? 'contain' : s.bgFit === 'tile' ? 'auto' : 'cover';
      img.style.backgroundRepeat = s.bgFit === 'tile' ? 'repeat' : 'no-repeat';
      const blur = clamp(Number(s.bgBlur) || 0, 0, 30);
      img.style.filter = blur ? `blur(${blur}px)` : '';
      img.style.inset = blur ? `-${blur * 2}px` : '0'; // 模糊时放大一点，避免边缘透出
      overlay = s.bgOpacityAuto !== false && stats ? autoOverlay(stats, themeBg()) : clamp(Number(s.bgOverlay), 0, 1);
      layer.lastChild.style.opacity = overlay;
    } else {
      layer.firstChild.style.backgroundImage = '';
    }

    // 强调色
    let accent = null;
    if (s.accentColor === 'auto' && stats && stats.accent) accent = fitAccent(stats.accent, dark);
    else if (fromHex(s.accentColor)) accent = fitAccent(fromHex(s.accentColor), dark);
    const vars = ['--accent', '--accent-soft', '--sidebar-active', '--hl-link', '--edit-border', '--sel'];
    if (accent) {
      const [r, g, b] = accent.map(Math.round);
      const a = (x) => `rgba(${r}, ${g}, ${b}, ${x})`;
      const values = [toHex(accent), a(0.13), a(0.13), toHex(accent), a(0.4), a(0.25)];
      vars.forEach((v, i) => body.style.setProperty(v, values[i]));
    } else vars.forEach((v) => body.style.removeProperty(v));

    styleEl('user-css').textContent = s.customCss || '';
    return { overlay, accent: accent && toHex(accent), imageAccent: stats && stats.accent ? toHex(fitAccent(stats.accent, dark)) : null };
  }

  /** 为导入的字体文件注册 @font-face */
  function registerFonts(fonts) {
    styleEl('user-font-faces').textContent = (fonts || [])
      .map((f) => `@font-face { font-family: "${f.family}"; src: url("${f.url}") format("${f.format}"); font-display: swap; }`).join('\n');
  }

  window.ZTheme = { apply, analyze, autoOverlay, fitAccent, registerFonts, current: () => current, toHex, fromHex };
})();
