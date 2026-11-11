/* Moyu — 纯文本模式（富文本编辑层）
 *
 * 开启后，激活的块不再显示 Markdown 源码，而是直接在渲染结果上编辑（contenteditable）。
 * 源码仍是唯一真相：每次输入都把编辑区的 DOM 序列化回 Markdown，写入隐藏的源码文本框，
 * 之后的流程（撤销、保存、查找、插件事件）与源码编辑完全相同。
 *
 * 安全措施：进入编辑前做一次「往返校验」—— 渲染 → 序列化 → 再渲染，结果必须与原渲染一致，
 * 否则该块退回源码编辑，保证不会因为序列化器不认识的语法而损坏文档。
 * 公式块、Mermaid、HTML、Front Matter 等本身即代码的块始终以代码形式编辑。
 */
/* global BlockEditor, ZMD */
(function () {
  'use strict';

  /* ======================= HTML → Markdown ======================= */

  const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'HR', 'TABLE']);

  /** 代码围栏：至少 min 个反引号；仅当代码中有会提前闭合围栏的行时才加长 */
  function fenceFor(text, min) {
    let n = Math.max(3, min || 3);
    const lines = text.split('\n');
    while (lines.some((l) => new RegExp('^ {0,3}`{' + n + ',}\\s*$').test(l))) n++;
    return '`'.repeat(n);
  }

  /** 把编辑区 DOM 序列化为 Markdown；遇到不认识的结构返回 null */
  function htmlToMd(root, o) {
    let bad = false;
    const wrap = (t, m) => {
      if (!t.trim()) return t;
      const a = /^\s*/.exec(t)[0];
      const b = /\s*$/.exec(t)[0];
      return a + m + t.slice(a.length, t.length - b.length) + m + b;
    };
    const one = (c) => {
      if (c.nodeType === 3) return c.data.replace(/​/g, '').replace(/ /g, ' ');
      if (c.nodeType !== 1) return '';
      if (c.hasAttribute('data-md')) return c.getAttribute('data-md');
      switch (c.tagName) {
        case 'BR': return o.breaks ? '\n' : '  \n';
        case 'STRONG': case 'B': return wrap(inline(c.childNodes), o.strong);
        case 'EM': case 'I': return wrap(inline(c.childNodes), o.em);
        case 'DEL': case 'S': case 'STRIKE': return wrap(inline(c.childNodes), '~~');
        case 'MARK': return wrap(inline(c.childNodes), '==');
        case 'CODE': {
          const t = c.textContent;
          const f = '`'.repeat(Math.max(0, ...(t.match(/`+/g) || []).map((x) => x.length)) + 1);
          const pad = /^`|`$/.test(t) ? ' ' : '';
          return f + pad + t + pad + f;
        }
        case 'A': {
          const href = c.getAttribute('href') || '';
          const t = inline(c.childNodes);
          if (t === href || 'http://' + t === href || 'mailto:' + t === href) return t; // 自动链接
          const title = c.getAttribute('title');
          return `[${t}](${href}${title ? ` "${title}"` : ''})`;
        }
        case 'IMG': {
          const title = c.getAttribute('title');
          return `![${c.getAttribute('alt') || ''}](${c.getAttribute('data-orig-src') || c.getAttribute('src') || ''}${title ? ` "${title}"` : ''})`;
        }
        case 'INPUT': return '';
        case 'U': return `<u>${inline(c.childNodes)}</u>`;
        case 'KBD': return `<kbd>${inline(c.childNodes)}</kbd>`;
        case 'SUP': return o.supSub ? `^${inline(c.childNodes)}^` : `<sup>${inline(c.childNodes)}</sup>`;
        case 'SUB': return o.supSub ? `~${inline(c.childNodes)}~` : `<sub>${inline(c.childNodes)}</sub>`;
        case 'SPAN': case 'FONT': return inline(c.childNodes);
        default: bad = true; return '';
      }
    };
    /** 行内内容；渲染器在 <br> 后输出的换行符需要去掉，否则会变成段落分隔 */
    function inline(nodes) {
      let out = '';
      let afterBr = false;
      for (const c of nodes) {
        let t = one(c);
        if (afterBr && c.nodeType === 3) t = t.replace(/^\n/, '');
        afterBr = c.nodeType === 1 && c.tagName === 'BR';
        out += t;
      }
      return out;
    }
    const clean = (t) => t.replace(/([ \t]*\n)+$/, '').trim();

    function blocks(parent) {
      const out = [];
      let run = [];
      const flush = () => { const t = clean(inline(run)); if (t) out.push(t); run = []; };
      for (const c of parent.childNodes) {
        if (c.nodeType === 1 && (BLOCK_TAGS.has(c.tagName) || (c.hasAttribute('data-md') && c.tagName === 'DIV'))) {
          flush();
          const b = block(c);
          if (b) out.push(b);
        } else run.push(c);
      }
      flush();
      return out;
    }
    function fence(pre, lang) {
      const code = pre.querySelector('code') || pre;
      if (lang === undefined) lang = (/language-(\S+)/.exec(code.className) || [, ''])[1];
      const text = code.textContent.replace(/\n$/, '');
      const f = fenceFor(text, 3);
      return f + lang + '\n' + text + '\n' + f;
    }
    function list(el) {
      const ordered = el.tagName === 'OL';
      const start = Number(el.getAttribute('start')) || 1;
      const items = Array.from(el.children).filter((c) => c.tagName === 'LI');
      const loose = items.some((li) => Array.from(li.children).some((c) => c.tagName === 'P'));
      return items.map((li, i) => {
        const marker = ordered ? `${start + i}. ` : o.listMarker + ' ';
        const cb = li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]');
        const body = blocks(li).join(loose ? '\n\n' : '\n');
        const pad = ' '.repeat(marker.length);
        return (marker + (cb ? (cb.checked ? '[x] ' : '[ ] ') : '') + body.split('\n').map((l, k) => (k && l ? pad + l : l)).join('\n')).trimEnd();
      }).join(loose ? '\n\n' : '\n');
    }
    function table(el) {
      const rows = Array.from(el.querySelectorAll('tr'));
      if (!rows.length) return '';
      const cell = (c) => clean(inline(c.childNodes)).replace(/\n/g, '<br>').replace(/\|/g, '\\|');
      const line = (tr) => '| ' + Array.from(tr.children).map(cell).join(' | ') + ' |';
      const sep = '| ' + Array.from(rows[0].children).map((c) => ({ left: ':---', center: ':---:', right: '---:' })[c.style.textAlign] || '---').join(' | ') + ' |';
      return [line(rows[0]), sep].concat(rows.slice(1).map(line)).join('\n');
    }
    function block(c) {
      if (c.hasAttribute('data-md')) return c.getAttribute('data-md');
      const tag = c.tagName;
      if (tag === 'P') return clean(inline(c.childNodes));
      if (/^H[1-6]$/.test(tag)) return '#'.repeat(Number(tag[1])) + ' ' + clean(inline(c.childNodes)).replace(/\s*\n\s*/g, ' ');
      if (tag === 'HR') return '---';
      if (tag === 'PRE') return fence(c);
      if (tag === 'UL' || tag === 'OL') return list(c);
      if (tag === 'TABLE') return table(c);
      if (tag === 'BLOCKQUOTE') return blocks(c).join('\n\n').split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
      if (tag === 'DIV') {
        if (c.classList.contains('code-block')) { const pre = c.querySelector('pre'); if (pre) return fence(pre); }
        if (c.className) { bad = true; return ''; } // 公式、图表、插件输出等带类名的容器无法还原
        return blocks(c).join('\n\n');
      }
      bad = true;
      return '';
    }
    const md = blocks(root).join('\n\n');
    return bad ? null : md;
  }

  /** 可编辑代码块中的文字：浏览器用 <br>（有时是 <div>）表示换行，textContent 会漏掉它们 */
  function codeText(node) {
    let out = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) out += c.data;
      else if (c.nodeType === 1) {
        if (c.tagName === 'BR') out += '\n';
        else { const inner = codeText(c); out += c.tagName === 'DIV' && !inner.endsWith('\n') ? inner + '\n' : inner; }
      }
    }
    return out;
  }

  /* ======================= DOM 光标工具 ======================= */

  function textOffsetOf(host, node, offset) {
    const r = document.createRange();
    r.selectNodeContents(host);
    try { r.setEnd(node, offset); } catch (e) { return 0; }
    return r.toString().length;
  }

  function rangeAtTextOffset(host, n) {
    const r = document.createRange();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let node;
    let left = Math.max(0, n);
    while ((node = walker.nextNode())) {
      if (left <= node.data.length) { r.setStart(node, left); r.collapse(true); return r; }
      left -= node.data.length;
    }
    r.selectNodeContents(host);
    r.collapse(false);
    return r;
  }

  function setCaret(host, n) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(n === Infinity ? rangeAtTextOffset(host, Number.MAX_SAFE_INTEGER) : rangeAtTextOffset(host, n));
  }

  /* ======================= 编辑器扩展 ======================= */

  const P = BlockEditor.prototype;
  const base = {};
  for (const name of ['activateRange', 'activateBlockEl', 'commit', 'applyEdit', 'replaceRange', 'revealMatch', 'toggleWrap', 'insertLink', 'insertText',
    'scrollToCaret', 'emitSelection', 'setOptions', 'updateEditClass']) base[name] = P[name];
  const NORM = / (id|data-num|data-line|data-eq)="[^"]*"/g;
  const TYPING = new Set(['insertText', 'insertCompositionText', 'deleteContentBackward', 'deleteContentForward']);

  P.serOpts = function () {
    return { listMarker: this.prefs.listMarker || '-', strong: this.prefs.strongMarker || '**', em: this.prefs.emMarker || '*', breaks: this.mdOptions.breaks !== false, supSub: !!this.mdOptions.supSub };
  };

  P.renderFragment = function (src) {
    return ZMD.sanitize(this.md.render(src, { baseDir: this.baseDir }));
  };

  /** 该块能否以富文本编辑：'code' | 'text' | null（退回源码编辑） */
  P.richKind = function (v) {
    if (!v.trim()) return 'text';
    const lines = v.split('\n');
    const m = /^(`{3,}|~{3,})\s*(\S*)\s*$/.exec(lines[0]);
    if (m) {
      const lang = m[2].toLowerCase();
      const closed = lines.length > 1 && new RegExp('^' + m[1][0] + '{' + m[1].length + ',}\\s*$').test(lines[lines.length - 1]);
      if (!closed || ['mermaid', 'math', 'katex', 'latex', 'tex'].includes(lang) || ZMD.registry.fences.has(lang)) return null;
      if (lines.slice(1, -1).some((l) => new RegExp('^' + m[1][0] + '{' + m[1].length + ',}\\s*$').test(l))) return null;
      return 'code';
    }
    // 往返校验：渲染 → 序列化 → 再渲染必须一致
    const html = this.renderFragment(v).replace(NORM, '');
    const div = document.createElement('div');
    div.innerHTML = html;
    const md = htmlToMd(div, this.serOpts());
    if (md === null) return null;
    return this.renderFragment(md).replace(NORM, '') === html ? 'text' : null;
  };

  P.initRich = function () {
    if (this.richEl) return;
    const el = document.createElement('div');
    el.className = 'md-rich';
    el.spellcheck = false;
    this.richEl = el;
    this.editorEl.insertBefore(el, this.editorEl.firstChild);
    el.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'historyUndo') { e.preventDefault(); this.undo(); return; }
      if (e.inputType === 'historyRedo') { e.preventDefault(); this.redo(); return; }
      this.recordHistory(TYPING.has(e.inputType) ? 'typing' : 'edit');
    });
    el.addEventListener('input', () => this.richSync());
    el.addEventListener('change', () => { this.recordHistory('struct'); this.richSync(); }); // 任务复选框
    el.addEventListener('keydown', (e) => this.richKeyDown(e));
    el.addEventListener('keyup', () => this.emitSelection());
    el.addEventListener('mouseup', () => this.emitSelection());
    el.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && this.opts.onLink) this.opts.onLink(a.getAttribute('href'));
    });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
      const img = items.find((it) => it.kind === 'file' && /^image\//.test(it.type));
      if (img && this.opts.onPasteImage) {
        Promise.resolve(this.opts.onPasteImage(img.getAsFile())).then((t) => { if (t) this.insertText(t); });
        return;
      }
      const text = e.clipboardData.getData('text/plain');
      if (text) document.execCommand('insertText', false, text); // 只粘贴纯文本，保持编辑区结构可控
    });
  };

  /** 编辑区中实际承载文字的元素（代码块为 <pre>） */
  P.richHost = function () {
    return this.richKindName === 'code' ? this.richEl.querySelector('pre') : this.richEl;
  };

  /** 源码偏移 → 渲染文本偏移（近似：渲染源码前缀后取其文字长度） */
  P.srcToTextOffset = function (v, sel) {
    if (sel === null || sel === undefined || sel >= v.length) return Infinity;
    if (sel <= 0) return 0;
    if (this.richKindName === 'code') return Math.max(0, sel - v.indexOf('\n') - 1);
    const div = document.createElement('div');
    div.innerHTML = this.renderFragment(v.slice(0, sel));
    return div.textContent.replace(/\n+$/, '').length;
  };

  /** 按当前源码重建富文本编辑区（或退回源码编辑） */
  P.refreshRich = function (sel, opt) {
    opt = opt || {};
    this.initRich();
    const v = this.hl.value;
    const kind = this.prefs.richMode && this.active ? this.richKind(v) : null;
    this.rich = !!kind;
    this.richKindName = kind;
    this.updateEditClass();
    if (window.CSS && CSS.highlights) CSS.highlights.delete('zmark-find-cur');
    const el = this.richEl;
    this._richTail = /\n*$/.exec(v)[0];
    this._richFence = (/^`{3,}/.exec(v) || [''])[0].length;
    if (!kind) { el.innerHTML = ''; el.removeAttribute('contenteditable'); return; }
    if (kind === 'code') {
      const lines = v.split('\n');
      const lang = (/^(?:`{3,}|~{3,})\s*(\S*)/.exec(lines[0]) || [, ''])[1];
      el.contentEditable = 'false';
      el.innerHTML = '<div class="code-block rich-code"><div class="code-toolbar"><input class="rich-lang" placeholder="语言" spellcheck="false"></div><pre contenteditable="plaintext-only" spellcheck="false"></pre></div>';
      el.querySelector('.rich-lang').value = lang;
      el.querySelector('pre').textContent = lines.slice(1, -1).join('\n');
    } else {
      el.contentEditable = 'true';
      el.innerHTML = v.trim() ? this.renderFragment(v) : '<p><br></p>';
      el.querySelectorAll('[data-md]').forEach((n) => { n.contentEditable = 'false'; });
      el.querySelectorAll('img').forEach((n) => { n.draggable = false; });
    }
    if (opt.noFocus) return;
    const host = this.richHost();
    host.focus({ preventScroll: true });
    setCaret(host, opt.textOffset !== undefined ? opt.textOffset : this.srcToTextOffset(v, sel));
    this.scrollToCaret(opt.center);
    this.emitSelection();
  };

  /** 编辑区 DOM → Markdown → 隐藏的源码文本框 → 走与源码编辑相同的更新流程 */
  P.richSync = function () {
    if (!this.rich || !this.active) return;
    let md;
    if (this.richKindName === 'code') {
      const text = codeText(this.richEl.querySelector('pre')).replace(/\n$/, '');
      const lang = this.richEl.querySelector('.rich-lang').value.trim().split(/\s+/)[0] || '';
      const f = fenceFor(text, this._richFence);
      md = f + lang + '\n' + text + '\n' + f;
    } else {
      md = htmlToMd(this.richEl, this.serOpts());
      if (md === null) return;
    }
    if (window.CSS && CSS.highlights) CSS.highlights.delete('zmark-find-cur');
    md += this._richTail || ''; // 保留块末尾原有的空行（例如列表之后的空行）
    this.hl.ta.value = md;
    this.hl.ta.setSelectionRange(md.length, md.length);
    this.onInput();
  };

  P.richCaretOffset = function () {
    const sel = window.getSelection();
    const host = this.richHost();
    if (!sel.rangeCount || !host.contains(sel.anchorNode)) return -1;
    return textOffsetOf(host, sel.focusNode, sel.focusOffset);
  };

  /** 光标是否在编辑区的第一 / 最后一个视觉行 */
  P.richEdge = function (which) {
    const sel = window.getSelection();
    const host = this.richHost();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const off = this.richCaretOffset();
    if (which === 'first' && off === 0) return true;
    if (which === 'last' && off >= host.textContent.replace(/\n$/, '').length) return true;
    const rect = sel.getRangeAt(0).getClientRects()[0];
    if (!rect) return false;
    const box = host.getBoundingClientRect();
    const cs = getComputedStyle(host);
    const lh = parseFloat(cs.lineHeight) || 24;
    return which === 'first' ? rect.top - box.top - parseFloat(cs.paddingTop) < lh * 0.9 : box.bottom - parseFloat(cs.paddingBottom) - rect.bottom < lh * 0.9;
  };

  /** 在光标处把当前块拆成两个块（段落 / 标题中的回车） */
  P.richSplit = function () {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const tail = document.createRange();
    tail.selectNodeContents(this.richEl);
    tail.setStart(r.endContainer, r.endOffset);
    const holder = document.createElement('div');
    holder.appendChild(tail.extractContents());
    const before = htmlToMd(this.richEl, this.serOpts()) || '';
    const after = htmlToMd(holder, this.serOpts()) || '';
    if (!before.trim() && after.trim()) this.replaceActiveWith(['', after], 0, 0);
    else if (!before.trim()) this.replaceActiveWith(['<br>', ''], 1, 0); // 空段落中回车：当前行成为空行
    else this.replaceActiveWith([before, after], 1, 0);
  };

  P.richKeyDown = function (e) {
    if (e.isComposing || e.keyCode === 229) return;
    const mod = e.ctrlKey || e.metaKey;
    const plain = !mod && !e.altKey && !e.shiftKey;
    const code = this.richKindName === 'code';
    const sel = window.getSelection();
    const anchor = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const within = (s) => (anchor && anchor.closest ? anchor.closest(s) : null);
    if (e.target.classList && e.target.classList.contains('rich-lang')) {
      if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); setCaret(this.richHost(), 0); this.richHost().focus(); } else if (e.key === 'Escape') { e.preventDefault(); this.commit(); }
      return;
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.commit();
        break;
      case 'Enter': {
        if (e.altKey) return;
        if (mod) { e.preventDefault(); this.replaceActiveWith([this.hl.value, ''], 1, 0); return; } // Ctrl+Enter：在下方新建段落
        if (code) return;
        const cell = within('td, th');
        if (cell) { e.preventDefault(); this.richTableEnter(cell); return; }
        if (within('li')) return; // 列表：浏览器默认行为（新建列表项，空项退出列表）
        const quote = within('blockquote');
        if (quote && !e.shiftKey) {
          const p = within('p, div');
          if (p && quote.contains(p) && !p.textContent.trim()) { // 引用中的空行：退出引用
            e.preventDefault();
            p.remove();
            this.replaceActiveWith([htmlToMd(this.richEl, this.serOpts()) || '', ''], 1, 0);
          }
          return;
        }
        e.preventDefault();
        const soft = (this.prefs.enterMode === 'newline') !== e.shiftKey;
        if (soft) document.execCommand('insertLineBreak'); else this.richSplit();
        break;
      }
      case 'Backspace':
        if (!mod && !code && sel.isCollapsed && this.richCaretOffset() === 0 && !/^\s*([-*+]\s|\d{1,9}[.)]\s|>|\|)/.test(this.hl.value) && this.handleBackspaceAtStart()) e.preventDefault();
        break;
      case 'ArrowUp':
        if (plain && this.richEdge('first')) { e.preventDefault(); this.moveToSibling(-1); } else setTimeout(() => this.scrollToCaret(), 0);
        break;
      case 'ArrowDown':
        if (plain && this.richEdge('last')) { e.preventDefault(); this.moveToSibling(1); } else setTimeout(() => this.scrollToCaret(), 0);
        break;
      case 'ArrowLeft':
        if (plain && sel.isCollapsed && this.richCaretOffset() === 0) { e.preventDefault(); this.moveToSibling(-1); }
        break;
      case 'ArrowRight':
        if (plain && sel.isCollapsed && this.richCaretOffset() >= this.richHost().textContent.replace(/\n$/, '').length) { e.preventDefault(); this.moveToSibling(1); }
        break;
      case 'Tab': {
        e.preventDefault();
        const cell = within('td, th');
        if (code) { if (!e.shiftKey) document.execCommand('insertText', false, this.indentUnit()); } else if (cell) this.richTableMove(cell, e.shiftKey ? -1 : 1); else if (within('li')) document.execCommand(e.shiftKey ? 'outdent' : 'indent');
        break;
      }
      default:
    }
  };

  P.richTableMove = function (cell, dir) {
    const cells = Array.from(this.richEl.querySelectorAll('th, td'));
    this.richFocusCell(cells[cells.indexOf(cell) + dir]);
  };

  P.richFocusCell = function (target) {
    if (!target) return;
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(target);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  };

  /** 表格中回车：移到下一行同一列；在最后一行则新增一行 */
  P.richTableEnter = function (cell) {
    const tr = cell.parentElement;
    const col = Array.from(tr.children).indexOf(cell);
    const rows = Array.from(this.richEl.querySelectorAll('tr'));
    let next = rows[rows.indexOf(tr) + 1];
    if (!next) {
      this.recordHistory('struct');
      next = document.createElement('tr');
      for (let i = 0; i < tr.children.length; i++) next.appendChild(document.createElement('td'));
      (this.richEl.querySelector('tbody') || tr.parentElement.parentElement.appendChild(document.createElement('tbody'))).appendChild(next);
      this.richSync();
    }
    this.richFocusCell(next.children[col]);
  };

  /* ---------- 覆盖：激活 / 提交 / 命令 ---------- */

  P.activateBlockEl = function (el, e) {
    // 渲染结果与编辑区内容相同，因此点击处的文字偏移可以精确对应到编辑区
    this._clickOffset = undefined;
    if (this.prefs.richMode && e && document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      const host = el.querySelector('pre') && el.classList.contains('blk-code') ? el.querySelector('pre') : el;
      if (r && host.contains(r.startContainer)) this._clickOffset = textOffsetOf(host, r.startContainer, r.startOffset);
    }
    try { return base.activateBlockEl.call(this, el, e); } finally { this._clickOffset = undefined; }
  };

  P.activateRange = function (start, end, selStart, selEnd, options) {
    const off = this._clickOffset;
    this._clickOffset = undefined;
    this.rich = false;
    base.activateRange.call(this, start, end, selStart, selEnd, options);
    const opt = Object.assign({}, options || {});
    if (off !== undefined) opt.textOffset = off;
    this.refreshRich(selStart, opt);
  };

  P.commit = function () {
    this.rich = false;
    if (window.CSS && CSS.highlights) CSS.highlights.delete('zmark-find-cur');
    return base.commit.call(this);
  };

  P.applyEdit = function (value, selStart, selEnd, kind) {
    base.applyEdit.call(this, value, selStart, selEnd, kind);
    if (this.active && this.prefs.richMode) this.refreshRich(selStart);
  };

  P.replaceRange = function (index, length, str) {
    const wasActive = this.active;
    base.replaceRange.call(this, index, length, str);
    if (this.active && this.active === wasActive && this.prefs.richMode) this.refreshRich(null, { noFocus: true });
  };

  /** 查找命中：在富文本编辑区中用 CSS Highlight 标出当前匹配 */
  P.revealMatch = function (index, length) {
    base.revealMatch.call(this, index, length);
    if (!this.rich || !this.hl.findRange || !(window.CSS && CSS.highlights)) return;
    const v = this.hl.value;
    const host = this.richHost();
    const a = this.srcToTextOffset(v, this.hl.findRange[0]);
    const b = this.srcToTextOffset(v, this.hl.findRange[1]);
    const r = rangeAtTextOffset(host, a === Infinity ? Number.MAX_SAFE_INTEGER : a);
    const end = rangeAtTextOffset(host, b === Infinity ? Number.MAX_SAFE_INTEGER : b);
    try { r.setEnd(end.startContainer, end.startOffset); } catch (e) { return; }
    CSS.highlights.set('zmark-find-cur', new Highlight(r));
    const rect = r.getBoundingClientRect();
    const box = this.scroller.getBoundingClientRect();
    if (rect.height) this.scroller.scrollTop += rect.top - (box.top + box.height * 0.45);
  };

  const EXEC = { '**': 'bold', __: 'bold', '*': 'italic', _: 'italic', '~~': 'strikeThrough', '<u>': 'underline' };
  P.toggleWrap = function (left, right, placeholder) {
    if (!this.active) this.ensureActive();
    if (!this.rich) return base.toggleWrap.call(this, left, right, placeholder);
    if (this.richKindName === 'code') return undefined;
    this.richHost().focus({ preventScroll: true });
    if (EXEC[left]) document.execCommand(EXEC[left]);
    else {
      // 行内代码、高亮、公式等：插入带标记的文字，离开该段落后渲染
      const s = window.getSelection().toString() || placeholder || '';
      document.execCommand('insertText', false, left + s + (right === undefined ? left : right));
    }
    this.richSync();
    return undefined;
  };

  P.insertLink = function (image, path) {
    if (!this.active) this.ensureActive();
    if (!this.rich) return base.insertLink.call(this, image, path);
    const s = window.getSelection().toString() || (image ? '图片描述' : '链接文本');
    return this.insertText((image ? '!' : '') + `[${s}](${path || ''})`);
  };

  P.insertText = function (str) {
    if (!this.active) this.ensureActive();
    if (!this.rich) return base.insertText.call(this, str);
    this.richHost().focus({ preventScroll: true });
    document.execCommand('insertText', false, str);
    return undefined;
  };

  P.scrollToCaret = function (center) {
    if (!this.rich) return base.scrollToCaret.call(this, center);
    if (!this.active || !this.editorEl.isConnected) return undefined;
    const sel = window.getSelection();
    let c = sel.rangeCount && this.richEl.contains(sel.anchorNode) ? sel.getRangeAt(0).getClientRects()[0] : null;
    if (!c) c = this.richHost().getBoundingClientRect();
    const box = this.scroller.getBoundingClientRect();
    if (this.typewriter || center) { this.scroller.scrollTop += c.top - (box.top + box.height * 0.45); return undefined; }
    const margin = 56;
    if (c.top < box.top + margin) this.scroller.scrollTop -= box.top + margin - c.top;
    else if (c.top + 24 > box.bottom - margin) this.scroller.scrollTop += c.top + 24 - (box.bottom - margin);
    return undefined;
  };

  P.emitSelection = function () {
    if (!this.rich) return base.emitSelection.call(this);
    if (this.opts.onSelection && this.active) this.opts.onSelection(this.getSelectedText());
    return undefined;
  };

  /** 当前选中的文字（两种编辑方式通用） */
  P.getSelectedText = function () {
    if (!this.active) return '';
    if (this.rich) { const s = window.getSelection(); return s.rangeCount && this.richEl.contains(s.anchorNode) ? s.toString() : ''; }
    const ta = this.hl.ta;
    return ta.value.slice(ta.selectionStart, ta.selectionEnd);
  };

  /** 把焦点交还给编辑区，并清除查找标记 */
  P.focusEditor = function () {
    this.hl.setFindRange(null);
    if (window.CSS && CSS.highlights) CSS.highlights.delete('zmark-find-cur');
    if (!this.active) return;
    if (this.rich) this.richHost().focus({ preventScroll: true }); else this.hl.focus();
  };

  P.setOptions = function (o) {
    if ('richMode' in o) this.prefs.richMode = !!o.richMode;
    for (const k of ['strongMarker', 'emMarker']) if (k in o) this.prefs[k] = o[k];
    base.setOptions.call(this, o);
    if ('richMode' in o && this.active) this.refreshRich(this.hl.ta.selectionStart);
  };

  P.updateEditClass = function () {
    base.updateEditClass.call(this);
    this.editorEl.classList.toggle('rich', !!this.rich);
  };

})();
