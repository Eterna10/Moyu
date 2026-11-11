/* Moyu — 块级所见即所得编辑器核心
 *
 * 数据模型：this.text 是唯一真相（Markdown 字符串，不含文件末尾换行）。
 * 渲染：markdown-it 解析后按顶层 token 的行区间切块，每块独立渲染。
 * 编辑：激活块 = 行区间 [active.start, active.start + active.len)，
 *       用 HLTextarea 替换该块；输入时 text = prefix + value + suffix。
 */
/* global ZMD, ZHL */
(function () {
  'use strict';

  const BLOCK_SYNTAX = /^\s*(#{1,6}\s|>|[-*+]\s|\d{1,9}[.)]\s|```|~~~|\$\$|\||<|\[toc\])/i;
  const LIST_RE = /^(\s*)([-*+]|(\d{1,9})([.)]))(\s+)(\[[ xX]\]\s+)?/;
  const TYPING_INPUTS = new Set(['insertText', 'insertCompositionText', 'deleteContentBackward', 'deleteContentForward', 'insertReplacementText']);
  // 空行：Markdown 会合并连续的空白行，因此在空段落中回车产生的空行写作单独一行 <br>。
  // 编辑时显示为空行（不显示 <br>），离开后仍保留；在其中输入文字即成为普通段落。
  const BLANK = '<br>';
  const isBlank = (s) => /^\s*<br\s*\/?>\s*$/i.test(s);
  const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  function typeOfToken(t) {
    switch (t.type) {
      case 'heading_open': return 'heading ' + t.tag;
      case 'paragraph_open': return 'paragraph';
      case 'bullet_list_open':
      case 'ordered_list_open': return 'list';
      case 'blockquote_open': return 'quote';
      case 'fence': {
        const lang = (t.info || '').trim().split(/\s+/)[0].toLowerCase();
        return lang === 'mermaid' ? 'mermaid' : 'code';
      }
      case 'code_block': return 'code';
      case 'hr': return 'hr';
      case 'html_block': return isBlank(t.content) ? 'blank' : 'html';
      case 'table_open': return 'table';
      case 'math_block': return 'math';
      case 'front_matter': return 'frontmatter';
      case 'toc': return 'toc';
      default: return t.type.replace(/_open$/, '');
    }
  }

  function countLines(s) {
    let n = 1;
    for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
    return n;
  }

  class BlockEditor {
    constructor(root, scroller, opts) {
      this.root = root;
      this.scroller = scroller;
      this.opts = opts || {};
      // Markdown 渲染选项（见 ZMD.createMd）与编辑行为偏好
      this.mdOptions = Object.assign({ breaks: this.opts.breaks !== false }, this.opts.md || {});
      this.md = ZMD.createMd(this.mdOptions);
      this.prefs = { enterMode: 'paragraph', autoPair: true, wrapSelection: true, livePreview: true, tabSize: 4, insertSpaces: true, listMarker: '-' };
      this.text = '';
      this.baseDir = null;
      this.active = null;
      this.blocks = [];
      this.history = [];
      this.future = [];
      this._lastKind = null;
      this._lastTime = 0;
      this.typewriter = false;

      this.hl = new ZHL.HLTextarea({ className: 'md-edit', placeholder: '输入 Markdown…  （Enter 新段落，Shift+Enter 换行）' });
      this.preview = document.createElement('div');
      this.preview.className = 'md-live-preview';
      this.editorEl = document.createElement('div');
      this.editorEl.className = 'md-editing';
      this.editorEl.append(this.hl.el, this.preview);
      this.footerEl = document.createElement('div');
      this.footerEl.className = 'md-footer';

      const ta = this.hl.ta;
      ta.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
      ta.addEventListener('input', (e) => {
        if (this.active && ZHL.autoPairInput(ta, e, this.prefs)) return; // 全角括号补全会再次触发 input
        this.onInput();
      });
      ta.addEventListener('compositionend', (e) => { if (this.active) ZHL.autoPairInput(ta, e, this.prefs); });
      ta.addEventListener('keydown', (e) => this.onKeyDown(e));
      ta.addEventListener('paste', (e) => this.onPaste(e));
      ta.addEventListener('select', () => this.emitSelection());
      ta.addEventListener('keyup', () => this.emitSelection());
      ta.addEventListener('mouseup', () => this.emitSelection());
      root.addEventListener('click', (e) => this.onRootClick(e));
      this._previewTimer = 0;

      // 全选整篇文档后的键盘与剪贴板操作（此时没有编辑块，焦点在页面上）
      this.allSelected = false;
      document.addEventListener('mousedown', () => { this.allSelected = false; }, true);
      document.addEventListener('keydown', (e) => { if (this.isAllSelected()) this.onAllSelectedKey(e); }, true);
      const onCopy = (e, cut) => {
        if (!this.isAllSelected()) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', this.text);
        e.clipboardData.setData('text/x-moyu-markdown', this.text); // 粘贴回 Moyu 时原样使用
        e.clipboardData.setData('text/html', this.root.innerHTML);
        if (cut) this.clearAll();
      };
      document.addEventListener('copy', (e) => onCopy(e, false), true);
      document.addEventListener('cut', (e) => onCopy(e, true), true);
      document.addEventListener('paste', (e) => {
        if (!this.isAllSelected()) return;
        const t = e.clipboardData.getData('text/plain');
        if (!t) return;
        e.preventDefault();
        this.clearAll();
        this.insertText(t.replace(/\r\n?/g, '\n'));
      }, true);
    }

    /* ======================= 全选 ======================= */

    /** 当前编辑块的内容是否已全部选中 */
    blockFullySelected() {
      const ta = this.hl.ta;
      return ta.selectionStart === 0 && ta.selectionEnd === ta.value.length;
    }

    /**
     * 全选。多行的块（代码块、表格、列表等）先选中块内内容，再按一次选中整篇文档；
     * 其它情况直接选中整篇文档。返回 false 表示应由浏览器在当前编辑块内全选。
     */
    selectAll() {
      if (this.active) {
        if (this.hl.value.includes('\n') && !this.blockFullySelected()) return false;
        this.commit();
      }
      if (!this.text.trim()) { this.ensureActive(); return true; }
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(this.root);
      sel.removeAllRanges();
      sel.addRange(r);
      this.allSelected = true;
      if (this.opts.onSelection) this.opts.onSelection(this.text);
      return true;
    }

    isAllSelected() {
      if (!this.allSelected) return false;
      const sel = window.getSelection();
      if (this.active || !sel.rangeCount || sel.isCollapsed || !this.root.contains(sel.anchorNode)) { this.allSelected = false; return false; }
      return true;
    }

    /** 清空整篇文档（可撤销），光标留在空文档中 */
    clearAll() {
      this.allSelected = false;
      window.getSelection().removeAllRanges();
      this.replaceAllText('');
      this.activateRange(0, 1, 0);
    }

    onAllSelectedKey(e) {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key;
      if (e.target !== document.body && !this.root.contains(e.target)) return; // 焦点在其它输入框中
      if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); this.clearAll(); return; }
      if (mod || e.altKey) return; // 复制 / 剪切 / 粘贴 / 撤销等交给各自的处理
      if (k === 'Escape' || k.startsWith('Arrow') || k === 'Home' || k === 'End') {
        e.preventDefault();
        this.allSelected = false;
        window.getSelection().removeAllRanges();
        if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'Home') { const b = this.blocks[0]; if (b) this.activateRange(b.start, b.end, 0); }
        else if (k !== 'Escape') { const b = this.blocks[this.blocks.length - 1]; if (b) this.activateRange(b.start, b.end); }
        return;
      }
      if (k === 'Enter') { e.preventDefault(); this.clearAll(); return; }
      // 直接输入（含输入法）：用输入的内容替换整篇文档，按键随后进入新的空编辑块
      if (k.length === 1 || e.keyCode === 229) this.clearAll();
    }

    /* ======================= 公共 API ======================= */

    setMarkdown(text, options) {
      options = options || {};
      this.text = text;
      this.baseDir = options.baseDir || null;
      this.active = null;
      if (!options.keepHistory) { this.history = []; this.future = []; }
      this._lastKind = null;
      this.render();
      if (!text.trim()) this.activateRange(0, 1, 0);
      this.scroller.scrollTop = 0;
    }

    getMarkdown() { return this.text; }

    setBaseDir(dir) { this.baseDir = dir; this.render(); }

    setOptions(o) {
      if ('spellcheck' in o) this.hl.ta.spellcheck = !!o.spellcheck;
      if ('typewriter' in o) this.typewriter = !!o.typewriter;
      for (const k of Object.keys(this.prefs)) if (k in o) this.prefs[k] = o[k];
      if ('enterMode' in o) {
        this.hl.ta.placeholder = this.prefs.enterMode === 'newline'
          ? '输入 Markdown…  （Enter 换行，Shift+Enter 新段落）'
          : '输入 Markdown…  （Enter 新段落，Shift+Enter 换行）';
      }
      if ('livePreview' in o && this.active) this.updatePreview();
      const md = Object.assign({}, o.md || {});
      if ('breaks' in o) md.breaks = o.breaks !== false;
      if (Object.keys(md).some((k) => md[k] !== this.mdOptions[k])) {
        Object.assign(this.mdOptions, md);
        this.rebuildMd();
      }
    }

    /** 缩进单位：Tab 字符或若干空格 */
    indentUnit() {
      return this.prefs.insertSpaces ? ' '.repeat(this.prefs.tabSize || 4) : '\t';
    }

    /** 重新创建 markdown-it 实例（插件注册 / 注销语法扩展、修改 Markdown 选项后调用） */
    rebuildMd() {
      this.md = ZMD.createMd(this.mdOptions);
      this.rerender();
      if (this.active) this.updatePreview();
    }

    /** 从源代码模式切回时载入文本（保留撤销历史） */
    loadFromSource(text) {
      if (text !== this.text) this.recordHistory('struct');
      this.text = text;
      this.active = null;
      this.render();
      this.emitChange();
    }

    /** 保持当前编辑状态重新渲染（主题、选项变化时） */
    rerender() {
      for (const el of this.root.children) el._key = null;
      this.render();
    }

    isEditing() { return !!this.active; }

    /** 计算标题（用于大纲），编辑中也是最新的 */
    computeHeadings() {
      const env = {};
      try { this.md.parse(this.text, env); } catch (e) { return []; }
      return env.headings || [];
    }

    /** 当前光标所在行（全文行号，0 起） */
    caretLine() {
      if (!this.active) return -1;
      const v = this.hl.value.slice(0, this.hl.ta.selectionStart);
      return this.active.start + countLines(v) - 1;
    }

    /* ======================= 解析与渲染 ======================= */

    parse() {
      const env = { baseDir: this.baseDir };
      const tokens = this.md.parse(this.text, env);
      const blocks = [];
      const footer = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.level !== 0) continue;
        let j = i;
        if (t.nesting === 1) {
          let depth = 0;
          for (j = i; j < tokens.length; j++) {
            depth += tokens[j].nesting;
            if (depth === 0) break;
          }
        }
        const slice = tokens.slice(i, j + 1);
        if (!t.map) { footer.push(...slice); i = j; continue; }
        blocks.push({ start: t.map[0], end: t.map[1], type: typeOfToken(t), tokens: slice });
        i = j;
      }
      // 补齐未被 token 覆盖的非空行（脚注定义、链接引用定义等）
      const lines = this.text.split('\n');
      const out = [];
      let cursor = 0;
      const pushRaw = (from, to) => {
        let s = -1;
        for (let n = from; n <= to; n++) {
          const blank = n === to || lines[n].trim() === '';
          if (!blank && s < 0) s = n;
          if (blank && s >= 0) { out.push({ start: s, end: n, type: 'raw' }); s = -1; }
        }
      };
      for (const b of blocks) {
        if (b.start < cursor) b.start = cursor;
        if (b.end <= b.start) continue;
        if (b.start > cursor) pushRaw(cursor, b.start);
        out.push(b);
        cursor = b.end;
      }
      if (cursor < lines.length) pushRaw(cursor, lines.length);
      return { blocks: out, footer, env, lines };
    }

    blockHtml(b, env) {
      if (b.type === 'raw') {
        const src = this._lines.slice(b.start, b.end).join('\n');
        return `<div class="md-raw">${ZMD.escapeHtml(src)}</div>`;
      }
      return ZMD.sanitize(this.md.renderer.render(b.tokens, this.md.options, env));
    }

    render() {
      const ta = this.hl.ta;
      const hadFocus = document.activeElement === ta;
      const selS = ta.selectionStart;
      const selE = ta.selectionEnd;
      const { blocks, footer, env, lines } = this.parse();
      this._lines = lines;
      this.blocks = blocks;
      this.env = env;
      // 大文档：屏幕外的块跳过样式计算与排版（content-visibility），小文档保持原样
      this.root.classList.toggle('large-doc', blocks.length > 400);
      const pool = new Map();
      for (const el of Array.from(this.root.children)) {
        if (!el._key) continue;
        if (!pool.has(el._key)) pool.set(el._key, []);
        pool.get(el._key).push(el);
      }
      const a = this.active;
      const els = [];
      let inserted = false;
      for (let k = 0; k < blocks.length; k++) {
        const b = blocks[k];
        if (a && b.start < a.start + a.len && b.end > a.start) continue; // 被编辑区覆盖
        if (a && !inserted && b.start >= a.start + a.len) { els.push(this.editorEl); inserted = true; }
        const html = this.blockHtml(b, env);
        let el = pool.has(html) ? pool.get(html).shift() : null;
        if (!el) {
          el = document.createElement('div');
          el.innerHTML = html;
          el._key = html;
        }
        el.className = 'md-block blk-' + b.type.replace(' ', ' blk-');
        el.dataset.k = k;
        els.push(el);
      }
      if (a && !inserted) els.push(this.editorEl);
      if (footer.length) {
        this.footerEl.innerHTML = ZMD.sanitize(this.md.renderer.render(footer, this.md.options, env));
        els.push(this.footerEl);
      }
      this.renderedLen = a ? a.len : 0;
      // 最小化 DOM 变更：复用的节点留在原位，只插入 / 移动 / 删除有变化的节点，
      // 避免整篇文档重新排版（大文档点击进入编辑时尤其明显）
      const root = this.root;
      let cur = root.firstChild;
      for (const el of els) {
        if (cur === el) { cur = cur.nextSibling; continue; }
        root.insertBefore(el, cur);
      }
      while (cur) {
        const next = cur.nextSibling;
        root.removeChild(cur);
        cur = next;
      }
      ZMD.postProcess(this.root, this.baseDir);
      if (a) {
        this.hl.refresh(true);
        if (hadFocus) this.hl.focus(selS, selE);
      }
    }

    srcOf(b) { return this.text.split('\n').slice(b.start, b.end).join('\n'); }

    offsetOfLine(n) {
      let off = 0;
      for (let i = 0; i < n; i++) {
        const p = this.text.indexOf('\n', off);
        if (p === -1) return this.text.length;
        off = p + 1;
      }
      return off;
    }

    /* ======================= 激活 / 提交 ======================= */

    activateRange(start, end, selStart, selEnd, options) {
      options = options || {};
      const lines = this.text.split('\n');
      start = Math.max(0, Math.min(start, lines.length));
      if (start === lines.length) lines.push('');
      end = Math.max(start + 1, Math.min(end, lines.length));
      this.text = lines.join('\n');
      this.prefix = start > 0 ? lines.slice(0, start).join('\n') + '\n' : '';
      this.suffix = end < lines.length ? '\n' + lines.slice(end).join('\n') : '';
      const src = lines.slice(start, end).join('\n');
      const blank = end - start === 1 && isBlank(src);
      const value = blank ? '' : src;
      this.active = { start, len: end - start, blank };
      this.hl.findRange = null;
      this.hl.ta.value = value;
      this.updateEditClass();
      this.render();
      const s = selStart === undefined || selStart === null ? value.length : Math.min(selStart, value.length);
      const e = selEnd === undefined || selEnd === null ? s : Math.min(selEnd, value.length);
      if (options.noFocus) this.hl.ta.setSelectionRange(s, e);
      else this.hl.focus(s, e);
      this.updatePreview(true);
      this.scrollToCaret(options.center);
      this.emitActive();
      this.emitSelection();
    }

    /** 提交编辑块，返回提交后的行区间 */
    commit() {
      if (!this.active) return null;
      const { start, len, blank } = this.active;
      const v = this.hl.value;
      this.active = null;
      this.hl.findRange = null;
      clearTimeout(this._previewTimer);
      if (v.trim() === '' && !blank) { // 空行（<br>）保留，其它空块删除
        const lines = this.text.split('\n');
        lines.splice(start, len);
        let s = start;
        while (s > 0 && lines[s - 1].trim() === '' && (s >= lines.length || lines[s].trim() === '')) { lines.splice(s - 1, 1); s--; }
        if (s === 0) while (lines.length && lines[0].trim() === '') lines.shift();
        this.text = lines.join('\n');
        this.render();
        this.emitActive();
        return { start: s, end: s, removed: true };
      }
      this.render();
      this.emitActive();
      return { start, end: start + len };
    }

    /** 只在编辑块为空时提交（查找前调用，保证偏移量稳定） */
    dropEmptyActive() {
      if (this.active && this.hl.value.trim() === '') this.commit();
    }

    appendEmptyBlock() {
      if (this.active) this.commit();
      const lines = this.text === '' ? [] : this.text.split('\n');
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      if (lines.length) lines.push('');
      const start = lines.length;
      lines.push('');
      this.text = lines.join('\n');
      this.activateRange(start, start + 1, 0);
    }

    focusEnd() {
      if (this.active) this.commit();
      const b = this.blocks[this.blocks.length - 1];
      if (b && b.type === 'paragraph') this.activateRange(b.start, b.end);
      else this.appendEmptyBlock();
    }

    ensureActive() {
      if (!this.active) this.focusEnd();
    }

    /** 光标下的渲染文本偏移 → 源码偏移（贪婪子序列匹配） */
    mapClick(blockEl, e, src) {
      if (!e || !document.caretRangeFromPoint) return src.length;
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (!r || !blockEl.contains(r.startContainer)) return src.length;
      const pre = document.createRange();
      pre.selectNodeContents(blockEl);
      try { pre.setEnd(r.startContainer, r.startOffset); } catch (err) { return src.length; }
      const before = pre.toString();
      let si = 0;
      // 有序列表的序号、标题前的 # 等由匹配自动跳过
      for (const ch of before) {
        if (/\s/.test(ch)) continue;
        const idx = src.indexOf(ch, si);
        if (idx === -1 || idx - si > 40) continue;
        si = idx + 1;
      }
      return si;
    }

    activateBlockEl(el, e) {
      const k = Number(el.dataset.k);
      const b = this.blocks[k];
      if (!b) return;
      const caret = this.mapClick(el, e, this.srcOf(b));
      let target = b;
      if (this.active) {
        const a = this.active;
        const firstAfter = this.blocks.findIndex((x) => x.start >= a.start + this.renderedLen);
        const before = b.start < a.start;
        const rel = before ? -1 : k - firstAfter;
        const r = this.commit();
        if (before) target = this.blocks.find((x) => x.start === b.start);
        else {
          const base = this.blocks.findIndex((x) => x.start >= r.end);
          target = base >= 0 ? this.blocks[base + rel] : null;
        }
        if (!target) return;
      }
      this.activateRange(target.start, target.end, caret);
    }

    onRootClick(e) {
      const t = e.target;
      if (this.editorEl.contains(t)) return;
      if (t.matches && t.matches('input.task-checkbox')) {
        e.preventDefault();
        this.toggleTask(Number(t.dataset.line));
        return;
      }
      const copy = t.closest && t.closest('.code-copy');
      if (copy) {
        const pre = copy.closest('.code-block').querySelector('pre');
        if (this.opts.onCopy) this.opts.onCopy(pre ? pre.textContent : '');
        return;
      }
      const a = t.closest && t.closest('a[href]');
      if (a) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) { if (this.opts.onLink) this.opts.onLink(a.getAttribute('href')); return; }
      }
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && this.root.contains(sel.anchorNode)) return; // 用户在选择文本
      const blockEl = t.closest && t.closest('.md-block');
      if (blockEl && this.root.contains(blockEl)) { this.activateBlockEl(blockEl, e); return; }
      if (t === this.root) this.activateNearest(e.clientY);
    }

    /** 点击空白处：激活纵向最近的块，若在末尾之后则在末尾新建 */
    activateNearest(y) {
      const els = Array.from(this.root.querySelectorAll(':scope > .md-block'));
      const last = this.root.lastElementChild;
      if (!els.length || (last && y > last.getBoundingClientRect().bottom)) { this.focusEnd(); return; }
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (y <= r.bottom) {
          const b = this.blocks[Number(el.dataset.k)];
          if (b) this.activateBlockEl(el, null);
          return;
        }
      }
      this.focusEnd();
    }

    toggleTask(line) {
      if (line < 0) return;
      const a = this.active;
      if (a && line >= a.start + this.renderedLen) line += a.len - this.renderedLen;
      const lines = this.text.split('\n');
      const m = /^(\s*(?:>\s?)*\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/.exec(lines[line] || '');
      if (!m) return;
      this.recordHistory('struct');
      lines[line] = m[1] + (m[2] === ' ' ? '[x]' : '[ ]') + lines[line].slice(m[0].length);
      this.text = lines.join('\n');
      if (a) {
        this.prefix = a.start > 0 ? lines.slice(0, a.start).join('\n') + '\n' : '';
        this.suffix = a.start + a.len < lines.length ? '\n' + lines.slice(a.start + a.len).join('\n') : '';
      }
      this.render();
      this.emitChange();
    }

    /* ======================= 输入处理 ======================= */

    onBeforeInput(e) {
      if (e.inputType === 'historyUndo') { e.preventDefault(); this.undo(); return; }
      if (e.inputType === 'historyRedo') { e.preventDefault(); this.redo(); return; }
      this.recordHistory(TYPING_INPUTS.has(e.inputType) ? 'typing' : 'edit');
    }

    onInput() {
      if (!this.active) return;
      const v = this.hl.value;
      const src = this.active.blank && v.trim() === '' ? BLANK : v; // 空行保持写作 <br>
      this.text = this.prefix + src + this.suffix;
      this.active.len = countLines(src);
      if (this.hl.findRange) { this.hl.findRange = null; this.hl.refresh(true); }
      this.updateEditClass();
      this.schedulePreview();
      this.scrollToCaret();
      this.emitChange();
      this.emitSelection();
    }

    /** 以编程方式修改编辑块内容 */
    applyEdit(value, selStart, selEnd, kind) {
      if (!this.active) return;
      this.recordHistory(kind || 'struct');
      this.hl.ta.value = value;
      this.hl.refresh(true);
      this.hl.focus(selStart, selEnd === undefined ? selStart : selEnd);
      this.onInput();
    }

    /** 用若干块替换当前编辑块，并激活其中一块 */
    replaceActiveWith(parts, activeIdx, selStart, selEnd) {
      const a = this.active;
      if (!a) return;
      this.recordHistory('struct');
      const kept = [];
      let idx = 0;
      parts.forEach((p, i) => {
        if (i === activeIdx) { idx = kept.length; kept.push(p); } else if (p.trim() !== '') kept.push(p);
      });
      const lines = this.text.split('\n');
      const before = lines.slice(0, a.start);
      const after = lines.slice(a.start + a.len);
      const mid = [];
      let activeStart = 0;
      let activeLen = 1;
      if (before.length && before[before.length - 1].trim() !== '') mid.push('');
      kept.forEach((p, i) => {
        if (i > 0) mid.push('');
        const pl = p.split('\n');
        if (i === idx) { activeStart = before.length + mid.length; activeLen = pl.length; }
        mid.push(...pl);
      });
      if (after.length && after[0].trim() !== '') mid.push('');
      this.text = before.concat(mid, after).join('\n');
      this.active = null;
      this.activateRange(activeStart, activeStart + activeLen, selStart, selEnd);
      this.emitChange();
    }

    onKeyDown(e) {
      if (e.isComposing || e.keyCode === 229) return; // 输入法组合中
      const ta = this.hl.ta;
      const mod = e.ctrlKey || e.metaKey;
      const plain = !mod && !e.altKey && !e.shiftKey;
      if (ZHL.autoPairKeydown(ta, e, this.prefs)) { e.preventDefault(); return; }
      switch (e.key) {
        case 'Enter': {
          if (mod || e.altKey) return;
          // 「Enter 换行」模式下两个键的作用互换：段落中 Enter 软换行、Shift+Enter 新段落
          const swap = this.prefs.enterMode === 'newline';
          if (e.shiftKey && !swap) return; // Shift+Enter：软换行（浏览器默认行为）
          e.preventDefault();
          this.handleEnter(swap && !e.shiftKey);
          break;
        }
        case 'Backspace':
          if (!mod && ta.selectionStart === 0 && ta.selectionEnd === 0 && this.handleBackspaceAtStart()) e.preventDefault();
          break;
        case 'ArrowUp':
          if (plain && this.hl.caretOnEdge('first')) { e.preventDefault(); this.moveToSibling(-1); }
          else setTimeout(() => this.scrollToCaret(), 0);
          break;
        case 'ArrowDown':
          if (plain && this.hl.caretOnEdge('last')) { e.preventDefault(); this.moveToSibling(1); }
          else setTimeout(() => this.scrollToCaret(), 0);
          break;
        case 'ArrowLeft':
          if (plain && ta.selectionStart === 0 && ta.selectionEnd === 0) { e.preventDefault(); this.moveToSibling(-1); }
          break;
        case 'ArrowRight':
          if (plain && ta.selectionStart === ta.value.length) { e.preventDefault(); this.moveToSibling(1); }
          break;
        case 'Tab':
          e.preventDefault();
          this.handleTab(e.shiftKey);
          break;
        case 'Escape':
          e.preventDefault();
          this.commit();
          break;
        default:
      }
    }

    /** soft：在普通段落中插入换行而不是拆分段落 */
    handleEnter(soft) {
      const ta = this.hl.ta;
      let v = ta.value;
      const s = ta.selectionStart;
      if (ta.selectionEnd !== s) v = v.slice(0, s) + v.slice(ta.selectionEnd);
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      let lineEnd = v.indexOf('\n', s);
      if (lineEnd < 0) lineEnd = v.length;
      const line = v.slice(lineStart, lineEnd);
      const vlines = v.split('\n');
      const first = vlines[0];
      const atEnd = s === v.length;
      const indentOf = (l) => /^\s*/.exec(l)[0];
      let m;

      // 代码块：首行回车自动补全闭合围栏；末尾回车跳出
      if ((m = /^(\s*)(`{3,}|~{3,})/.exec(first))) {
        const fence = m[2];
        const closeRe = new RegExp('^\\s*' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}\\s*$');
        const closed = vlines.slice(1).some((l) => closeRe.test(l));
        if (!closed && s <= first.length) {
          this.applyEdit(v.slice(0, lineEnd) + '\n\n' + m[1] + fence + v.slice(lineEnd), lineEnd + 1);
        } else if (closed && atEnd && closeRe.test(vlines[vlines.length - 1])) {
          this.replaceActiveWith([v, ''], 1, 0);
        } else {
          const ins = '\n' + indentOf(line);
          this.applyEdit(v.slice(0, s) + ins + v.slice(s), s + ins.length, undefined, 'typing');
        }
        return;
      }
      // 公式块
      if (/^\s*\$\$/.test(first)) {
        const single = first.trim().length > 2 && first.trim().endsWith('$$');
        const closed = single || vlines.slice(1).some((l) => l.trim().endsWith('$$'));
        if (!closed && s <= first.length) this.applyEdit(v.slice(0, lineEnd) + '\n\n$$' + v.slice(lineEnd), lineEnd + 1);
        else if (closed && atEnd) this.replaceActiveWith([v, ''], 1, 0);
        else this.applyEdit(v.slice(0, s) + '\n' + v.slice(s), s + 1, undefined, 'typing');
        return;
      }
      // Front Matter / HTML 块：普通换行
      if ((this.active.start === 0 && first.trim() === '---') || /^\s*</.test(first)) {
        if (atEnd && /^\s*</.test(first) && line.trim() === '') { this.replaceActiveWith([v.replace(/\n\s*$/, ''), ''], 1, 0); return; }
        this.applyEdit(v.slice(0, s) + '\n' + v.slice(s), s + 1, undefined, 'typing');
        return;
      }
      // 表格：回车新增一行；空行回车跳出表格
      if (/^\s*\|/.test(first) && /^\s*\|.*\|\s*$/.test(line)) {
        const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/);
        const lineIdx = countLines(v.slice(0, lineStart)) - 1;
        const isSep = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
        if (lineIdx >= 2 && !isSep && cells.every((c) => c.trim() === '')) {
          const rest = vlines.filter((_, i) => i !== lineIdx).join('\n');
          this.replaceActiveWith([rest, ''], 1, 0);
          return;
        }
        const row = '|' + cells.map(() => '  ').join('|') + '|';
        let insertAfter = lineIdx;
        if (lineIdx === 0 && vlines[1] && /-/.test(vlines[1])) insertAfter = 1;
        const nl = vlines.slice();
        nl.splice(insertAfter + 1, 0, row);
        const caret = nl.slice(0, insertAfter + 1).join('\n').length + 3;
        this.applyEdit(nl.join('\n'), caret);
        return;
      }
      // 列表：续写；空项回车退出 / 反缩进
      if ((m = LIST_RE.exec(line)) && s >= lineStart + m[0].length - (m[6] ? m[6].length : 0)) {
        const content = line.slice(m[0].length);
        if (content.trim() === '') {
          if (m[1].length > 0) {
            const cut = Math.min(m[1].length, 4);
            const newLine = line.slice(cut);
            this.applyEdit(v.slice(0, lineStart) + newLine + v.slice(lineEnd), lineStart + newLine.length);
          } else {
            this.exitAtLine(vlines, countLines(v.slice(0, lineStart)) - 1);
          }
          return;
        }
        let marker = m[2];
        if (m[3]) marker = (parseInt(m[3], 10) + 1) + m[4];
        const ins = '\n' + m[1] + marker + m[5] + (m[6] ? '[ ] ' : '');
        this.applyEdit(v.slice(0, s) + ins + v.slice(s), s + ins.length);
        return;
      }
      // 引用
      if ((m = /^(\s*(?:>\s?)+)/.exec(line))) {
        if (line.slice(m[1].length).trim() === '') { this.exitAtLine(vlines, countLines(v.slice(0, lineStart)) - 1); return; }
        const ins = '\n' + m[1].replace(/\s*$/, '') + ' ';
        this.applyEdit(v.slice(0, s) + ins + v.slice(s), s + ins.length);
        return;
      }
      // 列表项内部的续行
      if (LIST_RE.test(first)) {
        const ins = '\n' + indentOf(line);
        this.applyEdit(v.slice(0, s) + ins + v.slice(s), s + ins.length);
        return;
      }
      // 空段落中回车：当前行成为空行，光标移到下一行
      if (v.trim() === '') {
        this.replaceActiveWith([BLANK, ''], 1, 0);
        return;
      }
      // 「Enter 换行」模式：段落内换行
      if (soft) {
        this.applyEdit(v.slice(0, s) + '\n' + v.slice(s), s + 1, undefined, 'typing');
        return;
      }
      // 普通段落 / 标题：拆分为两个块
      const before = v.slice(0, s).replace(/[ \t]+$/, '');
      const after = v.slice(s).replace(/^[ \t]+/, '');
      if (before.trim() === '' && after.trim() !== '') { this.replaceActiveWith(['', v], 0, 0); return; }
      this.replaceActiveWith([before, after], 1, 0);
    }

    /** 删除第 idx 行并在该处插入新段落（列表 / 引用退出） */
    exitAtLine(vlines, idx) {
      const head = vlines.slice(0, idx).join('\n');
      const tail = vlines.slice(idx + 1).join('\n');
      this.replaceActiveWith([head, '', tail], 1, 0);
    }

    handleBackspaceAtStart() {
      const v = this.hl.value;
      const a = this.active;
      if (v === '') {
        this.recordHistory('struct');
        a.blank = false; // 退格删除空行
        const r = this.commit();
        const prev = [...this.blocks].reverse().find((b) => b.end <= r.start);
        if (prev) this.activateRange(prev.start, prev.end);
        else if (this.blocks.length) this.activateRange(this.blocks[0].start, this.blocks[0].end, 0);
        else this.activateRange(0, 1, 0);
        this.emitChange();
        return true;
      }
      const hm = /^(#{1,6})\s+/.exec(v);
      if (hm) { // 标题开头退格：降为普通段落
        this.applyEdit(v.slice(hm[0].length), 0);
        return true;
      }
      const prev = [...this.blocks].reverse().find((b) => b.end <= a.start);
      if (!prev) return false;
      if (prev.type === 'paragraph' && !BLOCK_SYNTAX.test(v)) {
        this.recordHistory('struct');
        const prevSrc = this.srcOf(prev);
        const merged = prevSrc + v;
        const lines = this.text.split('\n');
        lines.splice(prev.start, a.start + a.len - prev.start, ...merged.split('\n'));
        this.text = lines.join('\n');
        this.active = null;
        this.activateRange(prev.start, prev.start + countLines(merged), prevSrc.length);
        this.emitChange();
        return true;
      }
      this.moveToSibling(-1);
      return true;
    }

    moveToSibling(dir) {
      const a = this.active;
      if (!a) return;
      // 空块且该方向没有其它块时保持不动，避免空块被删除后光标“跳走”
      const hasTarget = dir < 0
        ? this.blocks.some((b) => b.end <= a.start)
        : this.blocks.some((b) => b.start >= a.start + this.renderedLen);
      if (!hasTarget && this.hl.value.trim() === '') return;
      const r = this.commit();
      const target = dir < 0
        ? [...this.blocks].reverse().find((b) => b.end <= r.start)
        : this.blocks.find((b) => b.start >= r.end);
      if (target) {
        this.activateRange(target.start, target.end, dir < 0 ? null : 0);
        return;
      }
      if (dir > 0) {
        const last = this.blocks[this.blocks.length - 1];
        if (!last || last.type !== 'paragraph') { this.appendEmptyBlock(); return; }
      }
      this.activateRange(r.start, r.end, dir < 0 ? 0 : null);
    }

    handleTab(shift) {
      const ta = this.hl.ta;
      const v = ta.value;
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      const first = v.split('\n')[0];
      // 表格：Tab 跳到下一单元格
      if (/^\s*\|/.test(first)) {
        if (shift) {
          const p = v.lastIndexOf('|', s - 1);
          let q = p > 0 ? v.lastIndexOf('|', p - 1) : -1;
          if (q >= 0 && v[q + 1] === '\n') q = v.lastIndexOf('|', q - 1);
          if (q >= 0) this.hl.focus(Math.min(q + 2, p));
        } else {
          let p = v.indexOf('|', s);
          if (p >= 0 && v[p + 1] === '\n') p = v.indexOf('|', p + 2);
          if (p >= 0 && p + 1 < v.length) this.hl.focus(Math.min(v.length, p + 2));
        }
        return;
      }
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      let blockEnd = v.indexOf('\n', e);
      if (blockEnd < 0) blockEnd = v.length;
      const isCode = /^\s*(```|~~~)/.test(first);
      const isList = LIST_RE.test(first);
      if (!isCode && !isList) return;
      // 代码块使用「Tab 宽度 / 用空格代替 Tab」设置；列表固定缩进 4 个空格（兼容有序列表的嵌套规则）
      const unit = isCode ? this.indentUnit() : '    ';
      if (isCode && !shift && s === e) {
        this.applyEdit(v.slice(0, s) + unit + v.slice(e), s + unit.length, undefined, 'typing');
        return;
      }
      const seg = v.slice(lineStart, blockEnd).split('\n');
      let ds = 0;
      let dt = 0;
      const out = seg.map((l, i) => {
        if (shift) {
          const cut = l.startsWith('\t') ? 1 : Math.min(unit === '\t' ? 4 : unit.length, /^ */.exec(l)[0].length);
          if (i === 0) ds = -cut;
          dt -= cut;
          return l.slice(cut);
        }
        if (i === 0) ds = unit.length;
        dt += unit.length;
        return unit + l;
      });
      const nv = v.slice(0, lineStart) + out.join('\n') + v.slice(blockEnd);
      this.applyEdit(nv, Math.max(lineStart, s + ds), Math.max(lineStart, e + dt));
    }

    onPaste(e) {
      const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
      const img = items.find((it) => it.kind === 'file' && /^image\//.test(it.type));
      if (img && this.opts.onPasteImage) {
        e.preventDefault();
        const file = img.getAsFile();
        Promise.resolve(this.opts.onPasteImage(file)).then((mdText) => { if (mdText) this.insertText(mdText); });
        return;
      }
      // 智能粘贴：网页 / Word 内容转为 Markdown，在选中文字上粘贴网址生成链接（由宿主决定是否处理）
      if (this.opts.onSmartPaste) this.opts.onSmartPaste(e);
    }

    insertText(str) {
      this.ensureActive();
      const ta = this.hl.ta;
      const s = ta.selectionStart;
      const v = ta.value;
      this.applyEdit(v.slice(0, s) + str + v.slice(ta.selectionEnd), s + str.length, undefined, 'edit');
    }

    /* ======================= 格式命令 ======================= */

    toggleWrap(left, right, placeholder) {
      right = right === undefined ? left : right;
      this.ensureActive();
      const ta = this.hl.ta;
      const v = ta.value;
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      const sel = v.slice(s, e);
      let surrounded;
      if (left === right && /^(.)\1*$/.test(left)) {
        // * / ** / _ / __ / ~~ / ==：按两侧同一字符的连续个数判断，避免把加粗的 ** 误认作斜体的 *
        const c = left[0];
        let L = 0;
        let R = 0;
        while (s - L - 1 >= 0 && v[s - L - 1] === c) L++;
        while (e + R < v.length && v[e + R] === c) R++;
        surrounded = left.length === 1 ? (L % 2 === 1 && R % 2 === 1) : (L >= left.length && R >= left.length);
      } else {
        surrounded = v.slice(s - left.length, s) === left && v.slice(e, e + right.length) === right;
      }
      if (surrounded) {
        this.applyEdit(v.slice(0, s - left.length) + sel + v.slice(e + right.length), s - left.length, e - left.length);
      } else if (sel.length >= left.length + right.length && sel.startsWith(left) && sel.endsWith(right)) {
        const inner = sel.slice(left.length, sel.length - right.length);
        this.applyEdit(v.slice(0, s) + inner + v.slice(e), s, s + inner.length);
      } else {
        const inner = sel || placeholder || '';
        this.applyEdit(v.slice(0, s) + left + inner + right + v.slice(e), s + left.length, s + left.length + inner.length);
      }
    }

    insertLink(image, path) {
      this.ensureActive();
      const ta = this.hl.ta;
      const v = ta.value;
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      const sel = v.slice(s, e);
      const label = sel || (image ? '图片描述' : '链接文本');
      const url = path || '';
      const text = (image ? '!' : '') + '[' + label + '](' + url + ')';
      const nv = v.slice(0, s) + text + v.slice(e);
      const prefixLen = (image ? 2 : 1);
      if (sel && !url) this.applyEdit(nv, s + prefixLen + label.length + 2);
      else this.applyEdit(nv, s + prefixLen, s + prefixLen + label.length);
    }

    setHeading(level) {
      this.ensureActive();
      const ta = this.hl.ta;
      const v = ta.value;
      const lines = v.split('\n');
      const m = /^(#{1,6})\s+/.exec(lines[0]);
      const cur = m ? m[1].length : 0;
      if (level === 'up') level = cur === 0 ? 6 : Math.max(1, cur - 1);
      else if (level === 'down') level = cur === 0 ? 0 : (cur >= 6 ? 0 : cur + 1);
      else if (level === cur) level = 0;
      const body = lines[0].replace(/^#{1,6}\s+/, '').replace(/^(\s*(?:>\s?)*\s*(?:[-*+]|\d{1,9}[.)])\s+)/, '');
      const head = level > 0 ? '#'.repeat(level) + ' ' : '';
      lines[0] = head + body;
      const nv = lines.join('\n');
      const delta = nv.length - v.length;
      this.applyEdit(nv, Math.max(head.length, ta.selectionStart + delta), Math.max(head.length, ta.selectionEnd + delta));
    }

    toggleLinePrefix(kind) {
      this.ensureActive();
      const v = this.hl.value;
      const lines = v.split('\n');
      const STRIP = /^(\s*)((?:>\s?)+|[-*+]\s+(\[[ xX]\]\s+)?|\d{1,9}[.)]\s+(\[[ xX]\]\s+)?)/;
      const tests = {
        quote: (l) => /^\s*>/.test(l),
        ul: (l) => /^\s*[-*+]\s+(?!\[[ xX]\])/.test(l),
        ol: (l) => /^\s*\d{1,9}[.)]\s+/.test(l),
        task: (l) => /^\s*[-*+]\s+\[[ xX]\]/.test(l),
      };
      const nonEmpty = lines.filter((l) => l.trim());
      const all = nonEmpty.length > 0 && nonEmpty.every(tests[kind]);
      let n = 0;
      const out = lines.map((l) => {
        if (!l.trim() && kind !== 'quote') return l;
        const body = l.replace(STRIP, '$1');
        if (all) return body;
        n++;
        const marker = this.prefs.listMarker || '-';
        if (kind === 'quote') return '> ' + l.replace(/^\s*>\s?/, '');
        if (kind === 'ul') return marker + ' ' + body.trimStart();
        if (kind === 'ol') return n + '. ' + body.trimStart();
        return marker + ' [ ] ' + body.trimStart();
      });
      const nv = out.join('\n');
      this.applyEdit(nv, nv.length);
    }

    /** 在当前块之后插入若干块（当前块为空时直接替换） */
    insertBlocks(parts, activeIdx, selStart, selEnd) {
      this.ensureActive();
      const v = this.hl.value;
      if (v.trim() === '') this.replaceActiveWith(parts, activeIdx, selStart, selEnd);
      else this.replaceActiveWith([v].concat(parts), activeIdx + 1, selStart, selEnd);
    }

    insertTable(rows, cols) {
      rows = rows || 2;
      cols = cols || 3;
      const head = '|' + Array.from({ length: cols }, (_, i) => ` 列${i + 1} `).join('|') + '|';
      const sep = '|' + Array.from({ length: cols }, () => ' --- ').join('|') + '|';
      const body = Array.from({ length: rows }, () => '|' + Array.from({ length: cols }, () => '  ').join('|') + '|');
      this.insertBlocks([[head, sep].concat(body).join('\n')], 0, 2, 4);
    }

    insertCodeBlock(lang) { this.insertBlocks(['```' + (lang || '') + '\n\n```'], 0, 3 + (lang || '').length); }
    insertMathBlock() { this.insertBlocks(['$$\n\n$$'], 0, 3); }
    insertHr() { this.insertBlocks(['---', ''], 1, 0); }
    insertToc() { this.insertBlocks(['[TOC]', ''], 1, 0); }

    /* ======================= 查找替换 ======================= */

    findAll(query, opt) {
      opt = opt || {};
      if (!query) return [];
      let re;
      try {
        re = new RegExp(opt.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opt.caseSensitive ? 'g' : 'gi');
      } catch (e) { return []; }
      const out = [];
      let m;
      while ((m = re.exec(this.text)) && out.length < 5000) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        out.push({ index: m.index, length: m[0].length });
      }
      return out;
    }

    revealMatch(index, length) {
      const a = this.active;
      if (a) {
        const off = this.prefix.length;
        if (index >= off && index + length <= off + this.hl.value.length) {
          this.hl.ta.setSelectionRange(index - off, index - off + length);
          this.hl.setFindRange([index - off, index - off + length]);
          this.scrollToCaret(true);
          return;
        }
        this.commit();
      }
      let line = 0;
      for (let i = this.text.indexOf('\n'); i !== -1 && i < index; i = this.text.indexOf('\n', i + 1)) line++;
      const b = this.blocks.find((x) => line >= x.start && line < x.end);
      if (!b) return;
      const off = this.offsetOfLine(b.start);
      this.activateRange(b.start, b.end, index - off, index - off + length, { noFocus: true, center: true });
      this.hl.setFindRange([index - off, index - off + length]);
    }

    replaceRange(index, length, str) {
      this.recordHistory('struct');
      const a = this.active;
      if (a) {
        const off = this.prefix.length;
        const v = this.hl.value;
        if (index >= off && index + length <= off + v.length) {
          const rel = index - off;
          this.hl.ta.value = v.slice(0, rel) + str + v.slice(rel + length);
          this.hl.refresh(true);
          this.onInput();
          return;
        }
        this.commit();
      }
      this.text = this.text.slice(0, index) + str + this.text.slice(index + length);
      this.render();
      this.emitChange();
    }

    replaceAllText(newText) {
      if (newText === this.text) return;
      this.recordHistory('struct');
      this.active = null;
      this.text = newText;
      this.render();
      this.emitChange();
    }

    /* ======================= 表格操作 ======================= */

    /** 光标所在的表格行列（源码编辑）：row 为源码行号，col 为单元格序号 */
    tableCaret() {
      const before = this.hl.value.slice(0, this.hl.ta.selectionStart);
      const seg = before.slice(before.lastIndexOf('\n') + 1);
      return { row: countLines(before) - 1, col: Math.max(0, (seg.match(/(?<!\\)\|/g) || []).length - 1) };
    }

    /** 当前编辑块是表格时返回 { rows, row, col }；rows[0] 为表头，rows[1] 为对齐行，其后为数据行 */
    tableContext() {
      if (!this.active) return null;
      const lines = this.hl.value.split('\n').filter((l) => l.trim());
      if (lines.length < 2 || !/^\s*\|/.test(lines[0]) || !TABLE_SEP.test(lines[1])) return null;
      const split = (l) => l.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
      const rows = lines.map(split);
      const n = Math.max(...rows.map((r) => r.length));
      rows.forEach((r, i) => { while (r.length < n) r.push(i === 1 ? '---' : ''); });
      const pos = this.tableCaret();
      return { rows, row: Math.max(0, Math.min(pos.row, rows.length - 1)), col: Math.max(0, Math.min(pos.col, n - 1)) };
    }

    /**
     * 表格操作：rowAbove / rowBelow / delRow / colLeft / colRight / delCol /
     * alignLeft / alignCenter / alignRight / alignNone / delete。不适用时返回 false。
     */
    tableOp(op) {
      const t = this.tableContext();
      if (!t) return false;
      const { rows } = t;
      let { row, col } = t;
      const n = rows[0].length;
      const blank = () => Array.from({ length: rows[0].length }, () => '');
      const align = { alignLeft: ':---', alignCenter: ':---:', alignRight: '---:', alignNone: '---' };
      if (op === 'delete') { this.applyEdit('', 0); return true; }
      if (op === 'rowAbove' || op === 'rowBelow') {
        // 表头上方不能插入行：在表头或对齐行上操作时都插到第一行数据之前
        const at = row <= 1 ? 2 : (op === 'rowAbove' ? row : row + 1);
        rows.splice(at, 0, blank());
        row = at;
      } else if (op === 'delRow') {
        if (row <= 1) return false; // 表头不能删除
        rows.splice(row, 1);
        row = rows.length > 2 ? Math.min(row, rows.length - 1) : 0;
      } else if (op === 'colLeft' || op === 'colRight') {
        const at = op === 'colLeft' ? col : col + 1;
        rows.forEach((r, i) => r.splice(at, 0, i === 1 ? '---' : ''));
        col = at;
      } else if (op === 'delCol') {
        if (n <= 1) return false;
        rows.forEach((r) => r.splice(col, 1));
        col = Math.min(col, n - 2);
      } else if (align[op]) {
        rows[1][col] = align[op];
      } else return false;
      if (row === 1) row = 0;
      const lines = rows.map((r) => '| ' + r.map((c) => c || ' ').join(' | ') + ' |');
      // 光标放到目标单元格的开头
      let caret = 0;
      for (let i = 0; i < row; i++) caret += lines[i].length + 1;
      caret += 2;
      for (let j = 0; j < col; j++) caret += (rows[row][j] || ' ').length + 3;
      this._tableTarget = { row, col };
      this.applyEdit(lines.join('\n'), caret);
      return true;
    }

    /* ======================= 粘贴 Markdown ======================= */

    /** 粘贴由网页 / Word 内容转换来的 Markdown：单行内容插入光标处，多块内容作为新的块插到当前块之后 */
    pasteMarkdown(md) {
      this.ensureActive();
      if (!md.includes('\n')) { this.insertText(md); return; }
      const v = this.hl.value;
      if (v.trim() === '') this.replaceActiveWith([md], 0);
      else this.replaceActiveWith([v, md], 1);
    }

    /* ======================= 撤销 / 重做 ======================= */

    snapshot() {
      const a = this.active;
      const ta = this.hl.ta;
      return { text: this.text, active: a ? { start: a.start, len: a.len, s: ta.selectionStart, e: ta.selectionEnd } : null };
    }

    recordHistory(kind) {
      const now = Date.now();
      if (kind === 'typing' && this._lastKind === 'typing' && now - this._lastTime < 1000 && now - this._groupStart < 4000 && this.history.length) {
        this._lastTime = now;
        return;
      }
      const snap = this.snapshot();
      const top = this.history[this.history.length - 1];
      if (!top || top.text !== snap.text) this.history.push(snap);
      if (this.history.length > 500) this.history.shift();
      this.future = [];
      this._lastKind = kind;
      this._lastTime = now;
      this._groupStart = now;
    }

    restore(snap) {
      this.text = snap.text;
      this.active = null;
      if (snap.active) this.activateRange(snap.active.start, snap.active.start + snap.active.len, snap.active.s, snap.active.e);
      else this.render();
      this.emitChange();
    }

    undo() {
      if (!this.history.length) return;
      this.future.push(this.snapshot());
      this._lastKind = null;
      this.restore(this.history.pop());
    }

    redo() {
      if (!this.future.length) return;
      this.history.push(this.snapshot());
      this._lastKind = null;
      this.restore(this.future.pop());
    }

    /* ======================= 视觉辅助 ======================= */

    updateEditClass() {
      const first = this.hl.value.split('\n', 1)[0];
      let kind = 'edit-p';
      let m;
      if ((m = /^(#{1,6})(\s|$)/.exec(first))) kind = 'edit-h' + m[1].length;
      else if (/^\s*(```|~~~)/.test(first)) kind = 'edit-code';
      else if (/^\s*\$\$/.test(first)) kind = 'edit-math';
      else if (/^\s*\|/.test(first)) kind = 'edit-table';
      else if (/^\s*>/.test(first)) kind = 'edit-quote';
      else if (LIST_RE.test(first)) kind = 'edit-list';
      else if (/^\s*</.test(first) || (this.active && this.active.start === 0 && first.trim() === '---')) kind = 'edit-html';
      this.editorEl.className = 'md-editing ' + kind;
    }

    needsPreview(v) {
      if (!this.prefs.livePreview) return false;
      return /^\s*(```|~~~)\s*mermaid/i.test(v) || /\$/.test(v) || /^\s*\|.*\|/m.test(v) || /<[a-z][\s\S]*>/i.test(v) || /!\[[^\]]*\]\([^)]+\)/.test(v) || /^\s*\[toc\]/im.test(v);
    }

    schedulePreview() {
      clearTimeout(this._previewTimer);
      this._previewTimer = setTimeout(() => this.updatePreview(), 180);
    }

    updatePreview() {
      const v = this.active ? this.hl.value : '';
      if (!v.trim() || !this.needsPreview(v)) {
        this.preview.innerHTML = '';
        this.preview.hidden = true;
        return;
      }
      const env = { baseDir: this.baseDir };
      let html = this.md.render(v, env);
      if (/^\s*\[toc\]/im.test(v)) html = html.replace(/<nav class="md-toc[\s\S]*?<\/nav>/, this.md.renderer.rules.toc([], 0, {}, { headings: this.computeHeadings() }));
      this.preview.innerHTML = ZMD.sanitize(html);
      this.preview.hidden = false;
      ZMD.postProcess(this.preview, this.baseDir);
      this.revealPreview();
    }

    /** 预览区超出视口时向上滚动，但保证光标仍可见 */
    revealPreview() {
      if (!this.editorEl.isConnected || this.typewriter) return;
      const box = this.scroller.getBoundingClientRect();
      const r = this.editorEl.getBoundingClientRect();
      if (r.bottom <= box.bottom - 16) return;
      const room = this.hl.caretRect().top - box.top - 60;
      if (room > 0) this.scroller.scrollTop += Math.min(r.bottom - box.bottom + 24, room);
    }

    scrollToCaret(center) {
      if (!this.active || !this.editorEl.isConnected) return;
      const c = this.hl.caretRect();
      const box = this.scroller.getBoundingClientRect();
      if (this.typewriter || center) {
        this.scroller.scrollTop += c.top - (box.top + box.height * 0.45);
        return;
      }
      const margin = 56;
      if (c.top < box.top + margin) this.scroller.scrollTop -= box.top + margin - c.top;
      else if (c.bottom > box.bottom - margin) this.scroller.scrollTop += c.bottom - (box.bottom - margin);
    }

    emitChange() { if (this.opts.onChange) this.opts.onChange(); }
    emitActive() { if (this.opts.onActiveChange) this.opts.onActiveChange(!!this.active); }
    emitSelection() {
      if (!this.opts.onSelection || !this.active) return;
      const ta = this.hl.ta;
      this.opts.onSelection(ta.value.slice(ta.selectionStart, ta.selectionEnd));
    }
  }

  window.BlockEditor = BlockEditor;
})();
