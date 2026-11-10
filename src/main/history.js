// Moyu 本地历史版本（主进程）：每次保存时为文档留一份快照，可查看、对比、恢复
const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MERGE_WINDOW = 5 * 60 * 1000; // 5 分钟内的多次保存合并为一个快照（自动保存不会刷屏）

const root = () => path.join(app.getPath('userData'), 'history');
const dirFor = (docPath) => path.join(root(), crypto.createHash('sha1').update(path.resolve(docPath).toLowerCase()).digest('hex').slice(0, 16));

function stamp(t) {
  const d = new Date(t);
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

function parseStamp(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})\.md$/.exec(name);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime() : 0;
}

function list(docPath) {
  const dir = dirFor(docPath);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => parseStamp(n)); } catch (e) { return []; }
  return names.sort().reverse().map((n) => ({ id: n, time: parseStamp(n), size: fs.statSync(path.join(dir, n)).size }));
}

const norm = (s) => String(s).replace(/\r\n/g, '\n').replace(/\n+$/, '');

/** 保存快照；与上一份内容相同时跳过，5 分钟内的连续保存覆盖上一份 */
function snapshot(docPath, text, max) {
  const dir = dirFor(docPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'source.txt'), docPath, 'utf8');
  // 第一次保存时，先把磁盘上原有的内容存为基线版本（时间取文件修改时间）
  if (!list(docPath).length && fs.existsSync(docPath)) {
    const disk = fs.readFileSync(docPath, 'utf8').replace(/^﻿/, '');
    if (norm(disk) !== norm(text) && disk.trim()) fs.writeFileSync(path.join(dir, stamp(fs.statSync(docPath).mtimeMs) + '.md'), disk, 'utf8');
  }
  const items = list(docPath);
  const last = items[0];
  if (last) {
    const prev = fs.readFileSync(path.join(dir, last.id), 'utf8');
    if (norm(prev) === norm(text)) return { skipped: true };
    if (Date.now() - last.time < MERGE_WINDOW && items.length > 1) fs.unlinkSync(path.join(dir, last.id));
  }
  fs.writeFileSync(path.join(dir, stamp(Date.now()) + '.md'), text, 'utf8');
  for (const old of list(docPath).slice(Math.max(5, max || 50))) fs.unlinkSync(path.join(dir, old.id));
  return { saved: true };
}

function register(h, ctx) {
  h('history:list', (e, docPath) => (docPath ? list(docPath) : []));
  h('history:read', (e, docPath, id) => {
    if (!/^\d{8}-\d{6}-\d{3}\.md$/.test(id)) throw new Error('无效的历史版本');
    return fs.readFileSync(path.join(dirFor(docPath), id), 'utf8');
  });
  h('history:snapshot', (e, docPath, text) => {
    const s = ctx.getSettings();
    if (!s.historyEnabled || !docPath) return { skipped: true };
    return snapshot(docPath, String(text), s.historyMax);
  });
  h('history:clear', (e, docPath) => { fs.rmSync(dirFor(docPath), { recursive: true, force: true }); return true; });
}

module.exports = { register };
