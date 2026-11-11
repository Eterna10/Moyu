/* Moyu — 工作区功能：右键菜单、文件树管理、文件夹内搜索、智能粘贴、复制为富文本、崩溃恢复 */
/* global BlockEditor, DOMPurify */
(function () {
  'use strict';

  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const basename = (p) => String(p).replace(/^.*[\\/]/, '');
  const dirname = (p) => String(p).replace(/[\\/][^\\/]*$/, '');
  const SEP = { type: 'separator' };

  /* ======================= HTML → Markdown（粘贴） ======================= */

  const PASTE_TAGS = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'br',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'strong', 'b', 'em', 'i', 'del', 's', 'strike', 'mark', 'a', 'img', 'u', 'kbd', 'sup', 'sub', 'span'];
  const CONTAINER_TAGS = 'section, article, main, header, footer, nav, aside, figure, figcaption, details, summary, address, dl, dt, dd, center';
  const FORMAT_RE = /<(h[1-6]|ul|ol|table|pre|blockquote|strong|em|del|mark|code|a\s[^>]*href|img\s|b|i)[\s>]|font-weight:\s*(bold|[6-9]00)|font-style:\s*italic/i;

  /** 剪贴板中的 HTML 是否带有值得保留的格式（标题、列表、表格、链接、加粗等） */
  function hasFormatting(html) {
    if (!html || /white-space:\s*pre/i.test(html.slice(0, 3000))) return false; // 代码编辑器复制出的着色代码按纯文本处理
    return FORMAT_RE.test(html);
  }

  function unwrap(el) {
    const p = el.parentNode;
    while (el.firstChild) p.insertBefore(el.firstChild, el);
    p.removeChild(el);
  }

  function rename(el, tag) {
    const n = el.ownerDocument.createElement(tag);
    while (el.firstChild) n.appendChild(el.firstChild);
    el.parentNode.replaceChild(n, el);
    return n;
  }

  /**
   * 把网页、Word、Excel 等复制出的 HTML 转为 Markdown；无法可靠转换时返回 null（调用方退回纯文本）。
   * opts 同编辑器的序列化选项（列表符号、加粗 / 斜体标记等）。
   */
  function htmlToMarkdown(html, opts) {
    let doc;
    try { doc = new DOMParser().parseFromString(String(html), 'text/html'); } catch (e) { return null; }
    const body = doc.body;
    if (!body) return null;
    // KaTeX 渲染的公式：取回其中保存的 TeX 源码（行内 $…$，独立公式 $$…$$）
    body.querySelectorAll('.katex-display, .katex').forEach((el) => {
      if (!el.isConnected) return;
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      if (!ann) return;
      const tex = ann.textContent.trim();
      if (el.classList.contains('katex-display')) { const p = doc.createElement('p'); p.textContent = '$$' + tex + '$$'; el.replaceWith(p); } else if (!el.closest('.katex-display')) el.replaceWith('$' + tex + '$');
    });
    // 代码块上的「复制」按钮、语言标签、标题锚点等界面元素不是正文
    body.querySelectorAll('.code-copy, .code-lang, .heading-anchor, .footnote-backref').forEach((el) => el.remove());
    body.querySelectorAll('script, style, meta, link, title, head, noscript, template, svg, math, iframe, object, button, select, textarea, input').forEach((el) => el.remove());
    // 用样式表示的加粗 / 斜体 / 删除线（Google 文档、Word 等）转为对应的标签；font-weight: normal 的 <b> 只是容器
    body.querySelectorAll('[style]').forEach((el) => {
      const st = el.getAttribute('style') || '';
      if (/^(b|strong)$/i.test(el.tagName) && /font-weight:\s*(normal|400)/i.test(st)) { rename(el, 'span'); return; }
      if (!/^(span|font)$/i.test(el.tagName)) return;
      let inner = el;
      const wrapIn = (tag) => { const w = doc.createElement(tag); while (inner.firstChild) w.appendChild(inner.firstChild); inner.appendChild(w); inner = w; };
      if (/font-weight:\s*(bold|[6-9]00)/i.test(st)) wrapIn('strong');
      if (/font-style:\s*italic/i.test(st)) wrapIn('em');
      if (/text-decoration[^;]*line-through/i.test(st)) wrapIn('del');
    });
    // 代码块的语言写在 class 里（language-js、highlight-source-js 等），清理属性前先记到 title 上
    body.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code');
      const cls = [pre.className, code && code.className, pre.parentElement && pre.parentElement.className].filter(Boolean).join(' ');
      const m = /(?:language-|lang-|highlight-source-)([\w+#.-]+)/.exec(cls);
      if (m) pre.setAttribute('title', 'lang:' + m[1]); else pre.removeAttribute('title');
    });
    body.querySelectorAll(CONTAINER_TAGS).forEach((el) => rename(el, 'div'));
    const clean = DOMPurify.sanitize(body.innerHTML, { ALLOWED_TAGS: PASTE_TAGS, ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'start'], KEEP_CONTENT: true });
    const root = document.createElement('div');
    root.innerHTML = clean;

    // 行内标签里包着段落、列表等块级内容（Google 文档把全文包在一个 <b> 里）：去掉这层外壳
    const BLOCKS = 'p, div, h1, h2, h3, h4, h5, h6, ul, ol, table, pre, blockquote, hr';
    for (let guard = 0; guard < 200; guard++) {
      const el = Array.from(root.querySelectorAll('span, b, strong, em, i, u, a, del, s, strike, mark, sup, sub, kbd, code')).find((x) => !x.closest('pre') && x.querySelector(BLOCKS));
      if (!el) break;
      unwrap(el);
    }
    // 图片只保留网络地址（内嵌的 data: 图片体积巨大，本地临时路径也无法引用）
    root.querySelectorAll('img').forEach((img) => { if (!/^https?:\/\//i.test(img.getAttribute('src') || '')) img.remove(); });
    root.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (!href || !/^(https?:|mailto:|#|\/|\.)/i.test(href)) unwrap(a);
    });
    // 代码块：<br> 是换行，内部的着色标签去掉
    root.querySelectorAll('pre').forEach((pre) => {
      pre.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
      const lang = /^lang:(.+)$/.exec(pre.getAttribute('title') || '');
      pre.removeAttribute('title');
      const code = document.createElement('code');
      if (lang) code.className = 'language-' + lang[1];
      code.textContent = pre.textContent;
      pre.textContent = '';
      pre.appendChild(code);
    });
    // 单元格中的段落、列表等块级内容压平成用 <br> 分隔的行内内容
    root.querySelectorAll('td, th').forEach((cell) => {
      if (cell.querySelector('table')) return;
      cell.querySelectorAll('pre').forEach((pre) => { const c = document.createElement('code'); c.textContent = pre.textContent.trim(); pre.replaceWith(c); });
      let guard = 0;
      for (let b = cell.querySelector('p, div, ul, ol, li, blockquote, h1, h2, h3, h4, h5, h6, hr'); b && guard < 500; b = cell.querySelector('p, div, ul, ol, li, blockquote, h1, h2, h3, h4, h5, h6, hr'), guard++) {
        if (b.tagName === 'HR') { b.remove(); continue; }
        if (b.nextSibling || b.parentNode !== cell) b.after(document.createElement('br'));
        unwrap(b);
      }
      while (cell.lastChild && cell.lastChild.nodeName === 'BR') cell.lastChild.remove();
    });
    // 表格的行首单元格用了 <td> 也没关系；没有任何行的表格去掉
    root.querySelectorAll('table').forEach((t) => { if (!t.querySelector('tr')) t.remove(); });
    // 行内代码之外的文字：HTML 源码里的换行与缩进只是空白
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n);
    for (const n of texts) {
      if (n.parentElement && n.parentElement.closest('pre')) continue;
      n.data = n.data.replace(/[\t\n\r ]+/g, ' ');
    }
    // 空的格式标签会生成 ** ** 之类的碎片
    root.querySelectorAll('strong, b, em, i, del, s, strike, mark, a, u, sup, sub, code').forEach((el) => { if (!el.textContent.trim() && !el.querySelector('img')) el.remove(); });

    let md;
    try { md = BlockEditor.htmlToMd(root, opts); } catch (e) { return null; }
    if (md === null) return null;
    return md.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ======================= 复制为富文本 ======================= */

  const INLINE_STYLES = [
    ['table', 'border-collapse:collapse;margin:12px 0;'],
    ['th', 'border:1px solid #d0d7de;padding:6px 13px;background:#f6f8fa;font-weight:600;'],
    ['td', 'border:1px solid #d0d7de;padding:6px 13px;'],
    ['pre', 'background:#f6f8fa;padding:12px 16px;border-radius:6px;font-family:Consolas,Menlo,monospace;font-size:13px;line-height:1.5;overflow:auto;'],
    ['code', 'font-family:Consolas,Menlo,monospace;font-size:0.9em;'],
    [':not(pre) > code', 'background:#eff1f3;padding:2px 5px;border-radius:4px;'],
    ['blockquote', 'border-left:4px solid #d0d7de;margin:12px 0;padding:0 1em;color:#57606a;'],
    ['h1', 'font-size:2em;border-bottom:1px solid #d8dee4;padding-bottom:0.3em;'],
    ['h2', 'font-size:1.5em;border-bottom:1px solid #d8dee4;padding-bottom:0.3em;'],
    ['img', 'max-width:100%;'],
    ['mark', 'background:#fff3a3;'],
    ['hr', 'border:0;border-top:2px solid #d8dee4;margin:20px 0;'],
  ];

  /** 把渲染结果整理成自带样式的 HTML：粘贴到 Word、邮件、公众号等不认识样式表的地方也保持排版 */
  function richHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll('.code-copy, .code-lang, .heading-anchor, .footnote-backref').forEach((el) => el.remove());
    div.querySelectorAll('input.task-checkbox').forEach((cb) => cb.replaceWith(cb.checked ? '☑ ' : '☐ '));
    for (const [sel, css] of INLINE_STYLES) div.querySelectorAll(sel).forEach((el) => el.setAttribute('style', css + (el.getAttribute('style') || '')));
    div.querySelectorAll('[data-line], [data-num], [data-k]').forEach((el) => { el.removeAttribute('data-line'); el.removeAttribute('data-k'); });
    return div.innerHTML;
  }

  /* ======================= 初始化 ======================= */

  function init(ctx) {
    const { api, state } = ctx;
    const ed = () => ctx.editor();

    /* ---------------- 智能粘贴 ---------------- */

    let plainUntil = 0; // 「粘贴为纯文本」生效的截止时间
    const pastePlain = () => { plainUntil = Date.now() + 800; };

    /** 返回 true 表示已处理（并已阻止默认粘贴） */
    function smartPaste(e) {
      if (!e.clipboardData || state.settings.smartPaste === false || Date.now() < plainUntil) return false;
      const editor = ed();
      if (!editor.active) return false;
      const v = editor.hl.value;
      // 代码块、公式块、HTML、Front Matter、表格中粘贴的都是原样文字
      if (/^\s*(`{3,}|~{3,}|\$\$|<|\|)/.test(v) || (editor.active.start === 0 && /^---\s*$/.test(v.split('\n')[0]))) return false;
      const text = e.clipboardData.getData('text/plain') || '';
      // 从 Moyu 里复制的整篇文档带有 Markdown 原文：原样粘贴，不经过 HTML 转换
      const own = e.clipboardData.getData('text/x-moyu-markdown');
      if (own && own.includes('\n')) { e.preventDefault(); editor.pasteMarkdown(own); return true; }
      const sel = editor.getSelectedText();
      const url = text.trim();
      if (sel && !sel.includes('\n') && /^(https?:\/\/|mailto:)\S+$/i.test(url) && !/^(https?:\/\/|mailto:)\S+$/i.test(sel.trim())) {
        e.preventDefault();
        editor.insertText(`[${sel}](${url})`);
        return true;
      }
      const html = e.clipboardData.getData('text/html');
      if (!hasFormatting(html)) return false;
      const md = htmlToMarkdown(html, editor.serOpts());
      const norm = (s) => s.replace(/\s+/g, ' ').trim();
      if (!md || norm(md) === norm(text)) return false; // 转换结果与纯文本相同：交给默认粘贴
      e.preventDefault();
      editor.pasteMarkdown(md);
      return true;
    }

    /* ---------------- 复制为 ---------------- */

    /** 取得要复制的 Markdown：源码编辑中有选区时为选中的部分，否则为全文 */
    function copySource() {
      if (state.sourceMode) {
        const ta = ctx.source.ta;
        if (ta.selectionStart !== ta.selectionEnd) return { md: ta.value.slice(ta.selectionStart, ta.selectionEnd), part: true };
      } else {
        const editor = ed();
        if (editor.active && !editor.rich) {
          const ta = editor.hl.ta;
          if (ta.selectionStart !== ta.selectionEnd) return { md: ta.value.slice(ta.selectionStart, ta.selectionEnd), part: true };
        }
      }
      return { md: ctx.getText(), part: false };
    }

    /** 同时写入富文本与纯文本两种格式 */
    async function writeRich(html, text) {
      const on = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.clipboardData.setData('text/html', html);
        e.clipboardData.setData('text/plain', text);
      };
      document.addEventListener('copy', on, true);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.removeEventListener('copy', on, true);
      if (ok) return true;
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
        return true;
      } catch (e) { return false; }
    }

    async function copyAs(kind) {
      const { md, part } = copySource();
      if (!md.trim()) { ctx.toast('没有可复制的内容'); return null; }
      const what = part ? '选中内容' : '全文';
      if (kind === 'markdown') { await api.invoke('app:copyText', md); ctx.toast(`已复制${what}的 Markdown 源码`); return md; }
      const html = ctx.renderMarkdown(md);
      if (kind === 'html') { await api.invoke('app:copyText', html); ctx.toast(`已复制${what}的 HTML 代码`); return html; }
      const rich = richHtml(html);
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      if (await writeRich(rich, tmp.textContent)) ctx.toast(`已复制${what}为富文本，可直接粘贴到 Word、邮件或公众号编辑器`);
      else { await api.invoke('app:copyText', tmp.textContent); ctx.toast('无法写入富文本，已复制为纯文本', true); }
      return rich;
    }

    /* ---------------- 文件树管理 ---------------- */

    const reloadTree = () => (state.folder ? ctx.loadFolder(state.folder) : Promise.resolve());

    async function newFileIn(dir) {
      if (!dir) { ctx.toast('请先打开一个文件夹'); return null; }
      const name = await ctx.promptText('新建 Markdown 文件', '未命名.md');
      if (!name) return null;
      try {
        const p = await api.invoke('fs:newFile', dir, name);
        state.expanded.add(dir);
        await reloadTree();
        await ctx.openPath(p);
        return p;
      } catch (err) { ctx.toast(errText(err), true); return null; }
    }

    async function newFolderIn(dir, name) {
      if (!dir) { ctx.toast('请先打开一个文件夹'); return null; }
      if (name === undefined) name = await ctx.promptText('新建文件夹', '新建文件夹');
      if (!name) return null;
      try {
        const p = await api.invoke('fs:newFolder', dir, name);
        state.expanded.add(dir);
        await reloadTree();
        return p;
      } catch (err) { ctx.toast(errText(err), true); return null; }
    }

    /** 路径 p 是否就是 base 或位于 base 之内 */
    const within = (p, base) => !!p && (p === base || p.startsWith(base + '\\') || p.startsWith(base + '/'));

    async function renamePath(p, name) {
      if (name === undefined) name = await ctx.promptText('重命名', basename(p));
      if (!name || name === basename(p)) return null;
      try {
        const dst = await api.invoke('fs:rename', p, name);
        // 正在编辑的文档（或其所在的文件夹）被改名：跟随到新路径
        if (within(state.filePath, p)) ctx.relocate(dst + state.filePath.slice(p.length));
        for (const x of Array.from(state.expanded)) if (within(x, p)) { state.expanded.delete(x); state.expanded.add(dst + x.slice(p.length)); }
        await reloadTree();
        return dst;
      } catch (err) { ctx.toast(errText(err), true); return null; }
    }

    async function deletePath(p, opts = {}) {
      const isDir = !!$(`#file-tree .tree-item.dir[data-path="${CSS.escape(p)}"]`);
      if (!opts.skipConfirm) {
        const r = await api.invoke('dialog:message', {
          type: 'warning', buttons: ['移到回收站', '取消'], defaultId: 0, cancelId: 1,
          message: `要删除“${basename(p)}”吗？`,
          detail: isDir ? '文件夹及其中的全部内容将移到回收站，可以从回收站恢复。' : '文件将移到回收站，可以从回收站恢复。',
        });
        if (r !== 0) return false;
      }
      try {
        await api.invoke('fs:trash', p);
        if (within(state.filePath, p)) ctx.detach(); // 正在编辑的文档被删除：内容保留为未保存的新文档
        await reloadTree();
        return true;
      } catch (err) { ctx.toast('删除失败：' + errText(err), true); return false; }
    }

    function treeMenu(item) {
      const p = item ? item.dataset.path : state.folder;
      if (!p) return [{ id: 'cmd:file.openFolder', label: '打开文件夹…' }];
      const isDir = !item || item.classList.contains('dir');
      const items = [];
      if (!isDir) items.push({ id: 'tree:open', label: '打开' }, SEP);
      if (isDir) items.push({ id: 'tree:newFile', label: '新建文件…' }, { id: 'tree:newFolder', label: '新建文件夹…' }, SEP);
      if (item) items.push({ id: 'tree:rename', label: '重命名…' }, { id: 'tree:delete', label: '删除' }, SEP);
      else items.push({ id: 'tree:refresh', label: '刷新' }, SEP);
      items.push({ id: 'tree:copyPath', label: '复制路径' }, { id: 'tree:reveal', label: '在资源管理器中显示' });
      return items;
    }

    async function runTree(id, item) {
      const p = item ? item.dataset.path : state.folder;
      const isDir = !item || item.classList.contains('dir');
      if (id === 'tree:open') return ctx.openPath(p);
      if (id === 'tree:newFile') return newFileIn(isDir ? p : dirname(p));
      if (id === 'tree:newFolder') return newFolderIn(isDir ? p : dirname(p));
      if (id === 'tree:rename') return renamePath(p);
      if (id === 'tree:delete') return deletePath(p);
      if (id === 'tree:refresh') return reloadTree();
      if (id === 'tree:copyPath') { await api.invoke('app:copyText', p); return ctx.toast('已复制路径'); }
      if (id === 'tree:reveal') return api.invoke('shell:reveal', p);
      return undefined;
    }

    // 窗口重新获得焦点时刷新文件树（别的程序可能新建 / 删除了文件），最多每 3 秒一次
    let lastTreeRefresh = 0;
    window.addEventListener('focus', () => {
      if (!state.folder || !state.settings.sidebar || state.settings.sidebarTab !== 'files' || Date.now() - lastTreeRefresh < 3000) return;
      lastTreeRefresh = Date.now();
      reloadTree();
    });

    /* ---------------- 文件夹内搜索 ---------------- */

    const search = { seq: 0, last: null };
    const box = $('#search-input');
    const resultsEl = $('#search-results');
    const statusEl = $('#search-status');
    const flag = (id) => $(id).classList.contains('on');

    function renderSearch(r, query) {
      search.last = r;
      if (!r) { resultsEl.innerHTML = ''; statusEl.textContent = ''; return; }
      if (!r.files.length) { resultsEl.innerHTML = ''; statusEl.textContent = `没有找到“${query}”`; return; }
      statusEl.textContent = `${r.files.length} 个文件，${r.total} 处匹配${r.truncated ? '（结果过多，只显示前一部分）' : ''}`;
      resultsEl.innerHTML = r.files.map((f, i) => {
        const dir = f.rel.includes('\\') || f.rel.includes('/') ? dirname(f.rel) : '';
        const rows = f.matches.map((m, j) => {
          const a = Math.max(0, Math.min(m.at, m.text.length));
          const b = Math.min(m.text.length, a + m.len);
          return `<div class="search-hit" data-f="${i}" data-m="${j}" title="第 ${m.line + 1} 行">${esc(m.text.slice(0, a))}<mark>${esc(m.text.slice(a, b))}</mark>${esc(m.text.slice(b))}</div>`;
        }).join('');
        return `<div class="search-file${f.path === state.filePath ? ' current' : ''}" data-f="${i}" title="${esc(f.path)}"><span class="search-name">${esc(f.name)}</span>` +
          `${dir ? `<span class="search-dir">${esc(dir)}</span>` : ''}<span class="search-count">${f.matches.length || '名称'}</span></div>${rows}`;
      }).join('');
    }

    async function runSearch() {
      const query = box.value;
      const seq = ++search.seq;
      if (!state.folder) { renderSearch(null); statusEl.innerHTML = '请先打开一个文件夹。<button class="text-btn" id="search-open-folder">打开文件夹…</button>'; $('#search-open-folder').onclick = () => ctx.runCommand('file.openFolder'); return null; }
      if (!query.trim()) { renderSearch(null); statusEl.textContent = SEARCH_HINT; return null; }
      statusEl.textContent = '正在搜索…';
      try {
        const r = await api.invoke('fs:search', state.folder, query, { caseSensitive: flag('#search-case'), regex: flag('#search-regex') });
        if (seq === search.seq) renderSearch(r, query);
        return r;
      } catch (err) {
        if (seq === search.seq) { resultsEl.innerHTML = ''; statusEl.textContent = errText(err); }
        return null;
      }
    }

    /** 打开搜索结果并定位到匹配处 */
    async function openHit(fi, mi) {
      const f = search.last && search.last.files[fi];
      if (!f) return;
      if (f.path !== state.filePath) { await ctx.openPath(f.path); if (state.filePath !== f.path) return; }
      const m = f.matches[mi];
      if (!m) return;
      // 文档可能在搜索之后被修改过：按行列定位，并确认该处仍是匹配的文字
      const text = ctx.getText();
      const lines = text.split('\n');
      if (m.line >= lines.length) return;
      let off = 0;
      for (let i = 0; i < m.line; i++) off += lines[i].length + 1;
      ctx.revealAt(off + Math.min(m.col, lines[m.line].length), Math.min(m.len, Math.max(0, lines[m.line].length - m.col)));
      resultsEl.querySelectorAll('.search-file').forEach((el) => el.classList.toggle('current', Number(el.dataset.f) === fi));
    }

    const SEARCH_HINT = '输入关键词，在当前文件夹的所有文档中查找。支持区分大小写（Aa）与正则表达式（.*）。';
    statusEl.textContent = SEARCH_HINT;
    let searchTimer = 0;
    box.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 300); });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); runSearch(); }
      if (e.key === 'Escape') { e.preventDefault(); ctx.focusEditor(); }
    });
    for (const id of ['#search-case', '#search-regex']) $(id).onclick = () => { $(id).classList.toggle('on'); runSearch(); };
    resultsEl.addEventListener('click', (e) => {
      const hit = e.target.closest('.search-hit');
      if (hit) { openHit(Number(hit.dataset.f), Number(hit.dataset.m)); return; }
      const file = e.target.closest('.search-file');
      if (file) openHit(Number(file.dataset.f), 0);
    });

    function openSearch(query) {
      ctx.setSetting({ sidebar: true, sidebarTab: 'search' });
      if (query === undefined) {
        const sel = ctx.getSelection();
        if (sel && !sel.includes('\n') && sel.length <= 80) query = sel;
      }
      if (query !== undefined) box.value = query;
      setTimeout(() => { box.focus(); box.select(); }, 0);
      return box.value.trim() ? runSearch() : Promise.resolve(null);
    }

    /* ---------------- 右键菜单 ---------------- */

    const cmd = (id, label, accelerator, extra) => Object.assign({ id: 'cmd:' + id, label, accelerator }, extra || {});

    function editorMenu(p, target) {
      const editor = ed();
      const items = [];
      if (p.misspelledWord) {
        if (p.suggestions.length) p.suggestions.forEach((w) => items.push({ id: 'spell:' + w, label: w }));
        else items.push({ id: 'none', label: '没有拼写建议', enabled: false });
        items.push({ id: 'spelladd:' + p.misspelledWord, label: `将“${p.misspelledWord}”添加到词典` }, SEP);
      }
      const link = target && target.closest ? target.closest('a[href]') : null;
      const img = target && target.tagName === 'IMG' ? target : null;
      if (link) items.push({ id: 'link:open', label: '打开链接' }, { id: 'link:copy', label: '复制链接地址' }, SEP);
      if (img) items.push({ id: 'img:zoom', label: '放大查看' }, { id: 'img:copy', label: '复制图片地址' }, { id: 'img:reveal', label: '在资源管理器中显示', enabled: !/^https?:/i.test(img.getAttribute('data-orig-src') || img.getAttribute('src') || '') }, SEP);
      const allSel = !state.sourceMode && editor.isAllSelected();
      items.push(
        { id: 'edit:cut', label: '剪切', accelerator: 'Ctrl+X', enabled: p.canCut || allSel },
        { id: 'edit:copy', label: '复制', accelerator: 'Ctrl+C', enabled: p.canCopy || allSel },
        { id: 'edit:paste', label: '粘贴', accelerator: 'Ctrl+V', enabled: p.isEditable || allSel },
        cmd('edit.pastePlain', '粘贴为纯文本', 'Ctrl+Shift+V', { enabled: p.isEditable }),
        cmd('edit.selectAll', '全选', 'Ctrl+A'),
        { label: '复制为', submenu: [cmd('edit.copyRich', '富文本（Word、邮件、公众号）', 'Ctrl+Shift+C'), cmd('edit.copyHtml', 'HTML 代码'), cmd('edit.copyMarkdown', 'Markdown 源码')] },
      );
      if (state.sourceMode) return items;
      const table = editor.tableContext();
      if (table) {
        const data = table.row > 1;
        items.push(SEP, { label: '表格', submenu: [
          { id: 'tbl:rowAbove', label: '在上方插入行', enabled: data },
          { id: 'tbl:rowBelow', label: '在下方插入行' },
          { id: 'tbl:colLeft', label: '在左侧插入列' },
          { id: 'tbl:colRight', label: '在右侧插入列' },
          SEP,
          { id: 'tbl:delRow', label: '删除当前行', enabled: data },
          { id: 'tbl:delCol', label: '删除当前列', enabled: table.rows[0].length > 1 },
          SEP,
          { id: 'tbl:alignLeft', label: '本列左对齐' },
          { id: 'tbl:alignCenter', label: '本列居中' },
          { id: 'tbl:alignRight', label: '本列右对齐' },
          SEP,
          { id: 'tbl:delete', label: '删除表格' },
        ] });
      }
      items.push(SEP,
        { label: '格式', submenu: [cmd('fmt.bold', '加粗', 'Ctrl+B'), cmd('fmt.italic', '斜体', 'Ctrl+I'), cmd('fmt.strike', '删除线'), cmd('fmt.mark', '高亮'), cmd('fmt.code', '行内代码'), cmd('fmt.link', '超链接', 'Ctrl+K'), SEP, cmd('fmt.clear', '清除样式')] },
        { label: '段落', submenu: [cmd('para.h1', '一级标题', 'Ctrl+1'), cmd('para.h2', '二级标题', 'Ctrl+2'), cmd('para.h3', '三级标题', 'Ctrl+3'), cmd('para.p', '正文', 'Ctrl+0'), SEP, cmd('para.quote', '引用'), cmd('para.ul', '无序列表'), cmd('para.ol', '有序列表'), cmd('para.task', '任务列表')] },
        { label: '插入', submenu: [cmd('fmt.image', '图片…'), cmd('para.table', '表格'), cmd('para.code', '代码块'), cmd('para.math', '公式块'), cmd('para.hr', '水平分割线'), cmd('para.toc', '内容目录 [TOC]')] },
      );
      return items;
    }

    function inputMenu(p) {
      return [
        { id: 'edit:cut', label: '剪切', enabled: p.canCut },
        { id: 'edit:copy', label: '复制', enabled: p.canCopy },
        { id: 'edit:paste', label: '粘贴', enabled: p.canPaste },
        SEP,
        { id: 'edit:selectAll', label: '全选' },
      ];
    }

    /** 按右键位置组装菜单：返回 { items, run(id) }，没有可用菜单时返回 null */
    function buildMenu(p) {
      const target = document.elementFromPoint(p.x, p.y);
      if (!target) return null;
      const editor = ed();
      const modal = target.closest('.modal-mask, .palette-mask, #findbar, #panel-search .search-box');
      if (modal) return p.isEditable || p.canCopy ? { items: inputMenu(p), run: (id) => runEdit(id) } : null;
      const tree = target.closest('#panel-files');
      if (tree) {
        const item = target.closest('.tree-item');
        return { items: treeMenu(item), run: (id) => (id.startsWith('cmd:') ? ctx.runCommand(id.slice(4)) : runTree(id, item)) };
      }
      if (!target.closest('#content, #source')) return p.canCopy ? { items: [{ id: 'edit:copy', label: '复制' }], run: (id) => runEdit(id) } : null;
      // 在渲染好的块上点右键（且没有正在选择文字）：先把光标放到该处，表格等操作才知道作用于哪里
      if (!state.sourceMode && !editor.editorEl.contains(target) && !editor.isAllSelected() && window.getSelection().isCollapsed) {
        const blockEl = target.closest('.md-block');
        if (blockEl && editor.root.contains(blockEl) && !target.closest('a[href]') && target.tagName !== 'IMG') editor.activateBlockEl(blockEl, { clientX: p.x, clientY: p.y });
      }
      const link = target.closest('a[href]');
      const img = target.tagName === 'IMG' ? target : null;
      return {
        items: editorMenu(p, target),
        run: async (id) => {
          if (id.startsWith('cmd:')) return ctx.runCommand(id.slice(4));
          if (id.startsWith('spell:')) return api.invoke('spell:replace', id.slice(6));
          if (id.startsWith('spelladd:')) return api.invoke('spell:add', id.slice(9));
          if (id.startsWith('tbl:')) return editor.tableOp(id.slice(4));
          if (id === 'link:open') return ctx.onLink(link.getAttribute('href'));
          if (id === 'link:copy') { await api.invoke('app:copyText', link.getAttribute('href')); return ctx.toast('已复制链接地址'); }
          const src = img ? (img.getAttribute('data-orig-src') || img.getAttribute('src') || '') : '';
          if (id === 'img:zoom') return ctx.openLightbox(img.currentSrc || img.src, img.alt);
          if (id === 'img:copy') { await api.invoke('app:copyText', src); return ctx.toast('已复制图片地址'); }
          if (id === 'img:reveal') return api.invoke('shell:reveal', decodeURI((img.currentSrc || img.src).replace(/^file:\/\/\//i, '')).replace(/\//g, '\\'));
          return runEdit(id);
        },
      };
    }

    function runEdit(id) {
      if (!id.startsWith('edit:')) return undefined;
      const op = id.slice(5);
      if (op === 'selectAll') return document.execCommand('selectAll');
      return api.invoke('edit:exec', op);
    }

    api.on('context-menu', async (p) => {
      const menu = buildMenu(p);
      if (!menu || !menu.items.length) return;
      const id = await api.invoke('menu:popup', menu.items);
      if (id) await menu.run(id);
    });

    /* ---------------- 崩溃恢复 ---------------- */

    let recoveryKey = '';
    let recoverySaved = false;
    let recoveryTimer = 0;
    const newKey = () => { recoveryKey = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); recoverySaved = false; };
    newKey();

    /** 把未保存的内容写入恢复区；文档已保存（或为空）时清除 */
    async function syncRecovery() {
      clearTimeout(recoveryTimer);
      const text = ctx.getText();
      try {
        if (ctx.isDirty() && text.trim()) {
          await api.invoke('recovery:save', recoveryKey, { filePath: state.filePath, name: ctx.docName(), text });
          recoverySaved = true;
        } else if (recoverySaved) {
          recoverySaved = false;
          await api.invoke('recovery:clear', recoveryKey);
        }
      } catch (e) { console.warn('写入恢复数据失败', e); }
    }
    const touchRecovery = () => { clearTimeout(recoveryTimer); recoveryTimer = setTimeout(syncRecovery, 1500); };
    async function clearRecovery() {
      clearTimeout(recoveryTimer);
      if (!recoverySaved) return;
      recoverySaved = false;
      try { await api.invoke('recovery:clear', recoveryKey); } catch (e) { /* 忽略 */ }
    }

    const fmtTime = (t) => { const d = new Date(t); const z = (n) => String(n).padStart(2, '0'); return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${z(d.getHours())}:${z(d.getMinutes())}`; };

    /** 列出上次没有正常保存的文档，供用户恢复或丢弃；没有可恢复的内容时返回 false */
    async function showRecovery(manual) {
      let list = [];
      try { list = (await api.invoke('recovery:list')).filter((x) => x.key !== recoveryKey); } catch (e) { list = []; }
      if (!list.length) { if (manual) ctx.toast('没有需要恢复的文档'); return false; }
      ctx.showModal(`<h3>恢复未保存的内容</h3>
        <p class="recover-tip">Moyu 上次没有正常退出，以下文档中有尚未保存的修改：</p>
        <div class="recover-list">${list.map((d) => `<div class="recover-item" data-key="${esc(d.key)}">
          <div class="recover-main"><div class="recover-name">${esc(d.name)}<span>${fmtTime(d.savedAt)} · ${d.chars} 字符</span></div>
          <div class="recover-path">${esc(d.filePath || '尚未保存过的新文档')}</div>
          <div class="recover-preview">${esc(d.preview)}</div></div>
          <div class="recover-actions"><button class="text-btn primary" data-act="restore">恢复</button><button class="text-btn" data-act="discard">丢弃</button></div>
        </div>`).join('')}</div>
        <div class="actions"><span style="flex:1"></span><button class="text-btn" data-act="later">稍后处理</button></div>`,
      (el, close) => {
        el.classList.add('recover-modal');
        $('[data-act=later]', el).onclick = close;
        el.addEventListener('click', async (e) => {
          const btn = e.target.closest('.recover-item button');
          if (!btn) return;
          const item = btn.closest('.recover-item');
          const key = item.dataset.key;
          if (btn.dataset.act === 'discard') {
            await api.invoke('recovery:clear', key);
            item.remove();
            if (!$('.recover-item', el)) close();
            return;
          }
          if (ctx.isDirty()) { ctx.toast('当前文档有未保存的修改，请先保存后再恢复', true); return; }
          try {
            const d = await api.invoke('recovery:read', key);
            const exists = d.filePath && (await api.invoke('fs:exists', d.filePath));
            const mtime = exists ? await api.invoke('fs:stat', d.filePath) : null;
            // 原文件还在：恢复为该文件的未保存修改；否则作为新文档
            ctx.loadText(d.text, exists ? { filePath: d.filePath, mtime, markDirty: true } : { name: d.name, markDirty: true });
            await api.invoke('recovery:clear', key);
            close();
            ctx.toast('已恢复，请记得保存');
            touchRecovery();
          } catch (err) { ctx.toast('恢复失败：' + errText(err), true); }
        });
      });
      return true;
    }

    return {
      smartPaste, pastePlain, htmlToMarkdown, hasFormatting, copyAs, richHtml,
      newFileIn, newFolderIn, renamePath, deletePath, treeMenu, runTree,
      openSearch, runSearch, openHit, searchState: () => search.last,
      buildMenu,
      touchRecovery, syncRecovery, clearRecovery, showRecovery, recoveryKey: () => recoveryKey, resetRecoveryKey: newKey,
    };
  }

  window.ZWorkspace = { init, htmlToMarkdown, hasFormatting };
})();
