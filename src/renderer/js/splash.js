/* Moyu — 开启动画的启动开关
 * 在 <head> 中同步执行：主进程通过页面地址参数决定是否显示（?splash=1&bg=…&dark=…），
 * 因此关闭动画时不会出现一闪而过的画面，背景色也与当前主题一致。
 */
(function () {
  'use strict';
  const q = new URLSearchParams(location.search);
  if (q.get('splash') !== '1') return;
  const de = document.documentElement;
  de.classList.add('splash-on');
  if (q.get('dark') === '1') de.classList.add('splash-dark');
  const bg = q.get('bg');
  if (/^#[0-9a-f]{6}$/i.test(bg || '')) de.style.setProperty('--splash-bg', bg);
  window.__splash = { start: performance.now(), shown: true };
})();
