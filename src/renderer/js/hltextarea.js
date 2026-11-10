/* Moyu — 带 Markdown 语法高亮背景层的自适应文本框
 * 原理：透明文字的 <textarea> 叠在高亮层之上，两者字体/换行完全一致，
 * 高亮层只改变颜色与背景（不改变字宽），因此光标与文字始终对齐。
 */
(function () {
  'use strict';

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const mk = (s) => (s ? `<span class="hl-mark">${esc(s)}</span>` : '');

  const INLINE_SRC = '(`+)(.+?)\\1' +                       // 1,2 行内代码
    '|(\\*\\*|__)(?=\\S)(.+?)\\3' +                         // 3,4 加粗
    '|(~~)(.+?)\\5' +                                       // 5,6 删除线
    '|(==)(.+?)\\7' +                                       // 7,8 高亮
    '|(!?\\[)([^\\]\\n]*)\\](\\([^)\\n]*\\)|\\[[^\\]\\n]*\\])?' + // 9,10,11 链接/图片/引用
    '|(\\$)([^$\\n]+?)\\$' +                                // 12,13 行内公式
    '|(<\\/?[A-Za-z][^>\\n]*>)' +                          // 14 HTML 标签
    '|(\\*|_)(?=\\S)([^*_\\n]+?)\\15' +                     // 15,16 斜体
    '|(https?:\\/\\/[^\\s<>()]+)';                          // 17 裸链接

  function hlInline(text) {
    const re = new RegExp(INLINE_SRC, 'g');
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      out += esc(text.slice(last, m.index));
      if (m[1]) out += mk(m[1]) + `<span class="hl-code">${esc(m[2])}</span>` + mk(m[1]);
      else if (m[3]) out += mk(m[3]) + `<span class="hl-strong">${hlInline(m[4])}</span>` + mk(m[3]);
      else if (m[5]) out += mk(m[5]) + `<span class="hl-del">${hlInline(m[6])}</span>` + mk(m[5]);
      else if (m[7]) out += mk(m[7]) + `<span class="hl-hl">${hlInline(m[8])}</span>` + mk(m[7]);
      else if (m[9]) {
        out += mk(m[9]) + `<span class="hl-link">${hlInline(m[10])}</span>` + mk(']');
        if (m[11]) out += `<span class="hl-url">${esc(m[11])}</span>`;
      } else if (m[12]) out += mk('$') + `<span class="hl-math">${esc(m[13])}</span>` + mk('$');
      else if (m[14]) out += `<span class="hl-html">${esc(m[14])}</span>`;
      else if (m[15]) out += mk(m[15]) + `<span class="hl-em">${hlInline(m[16])}</span>` + mk(m[15]);
      else if (m[17]) out += `<span class="hl-url">${esc(m[17])}</span>`;
      last = re.lastIndex;
      if (m[0].length === 0) re.lastIndex++;
    }
    return out + esc(text.slice(last));
  }

  function hlTableRow(line) {
    if (/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line)) return mk(line);
    return line.split(/(?<!\\)\|/).map((cell) => hlInline(cell)).join(mk('|'));
  }

  function highlightMarkdown(text) {
    const lines = text.split('\n');
    const out = [];
    let fence = null;
    let math = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if (fence) {
        if (new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$').test(line)) { out.push(mk(line)); fence = null; }
        else out.push(`<span class="hl-code">${esc(line)}</span>`);
        continue;
      }
      if (math) {
        if (line.trim().endsWith('$$')) { out.push(`<span class="hl-math">${esc(line.replace(/\$\$\s*$/, ''))}</span>` + mk(line.slice(line.lastIndexOf('$$')))); math = false; }
        else out.push(`<span class="hl-math">${esc(line)}</span>`);
        continue;
      }
      if ((m = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line))) {
        fence = m[2];
        out.push(esc(m[1]) + mk(m[2]) + `<span class="hl-lang">${esc(m[3])}</span>`);
        continue;
      }
      if ((m = /^(\s*\$\$)(.*)$/.exec(line))) {
        const rest = m[2];
        if (rest.trim().endsWith('$$') && rest.trim().length >= 2) {
          out.push(mk(m[1]) + `<span class="hl-math">${esc(rest.replace(/\$\$\s*$/, ''))}</span>` + mk('$$'));
        } else { math = true; out.push(mk(m[1]) + `<span class="hl-math">${esc(rest)}</span>`); }
        continue;
      }
      if (i === 0 && line.trim() === '---' && lines.some((l, j) => j > 0 && /^(---|\.\.\.)\s*$/.test(l))) {
        out.push(mk(line));
        let j = 1;
        for (; j < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[j]); j++) out.push(`<span class="hl-fm">${esc(lines[j])}</span>`);
        if (j < lines.length) out.push(mk(lines[j]));
        i = j;
        continue;
      }
      if ((m = /^(#{1,6})(\s+|$)(.*)$/.exec(line))) {
        out.push(mk(m[1]) + m[2] + `<span class="hl-heading">${hlInline(m[3])}</span>`);
        continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(mk(line)); continue; }
      if (/^\s*\[toc\]\s*$/i.test(line)) { out.push(`<span class="hl-html">${esc(line)}</span>`); continue; }
      let prefix = '';
      let rest = line;
      if ((m = /^(\s*(?:>\s?)+)/.exec(rest))) { prefix += mk(m[1]); rest = rest.slice(m[1].length); }
      if ((m = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\](?=\s|$))?/.exec(rest))) {
        prefix += esc(m[1]) + `<span class="hl-list">${esc(m[2])}</span>` + m[3] + (m[4] ? `<span class="hl-list">${esc(m[4])}</span>` : '');
        rest = rest.slice(m[0].length);
      } else if ((m = /^(\[\^?[^\]]+\]:)/.exec(rest))) {
        prefix += `<span class="hl-list">${esc(m[1])}</span>`;
        rest = rest.slice(m[1].length);
      }
      out.push(prefix + (/^\s*\|/.test(rest) ? hlTableRow(rest) : hlInline(rest)));
    }
    return out.join('\n');
  }

  class HLTextarea {
    constructor(opts) {
      opts = opts || {};
      this.el = document.createElement('div');
      this.el.className = 'hl-wrap' + (opts.className ? ' ' + opts.className : '');
      this.backdrop = document.createElement('div');
      this.backdrop.className = 'hl-backdrop';
      this.backdrop.setAttribute('aria-hidden', 'true');
      this.mirror = document.createElement('div');
      this.mirror.className = 'hl-mirror';
      this.mirror.setAttribute('aria-hidden', 'true');
      this.ta = document.createElement('textarea');
      this.ta.className = 'hl-input';
      this.ta.spellcheck = !!opts.spellcheck;
      this.ta.setAttribute('autocomplete', 'off');
      this.ta.setAttribute('autocapitalize', 'off');
      if (opts.placeholder) this.ta.placeholder = opts.placeholder;
      this.el.append(this.backdrop, this.mirror, this.ta);
      this.findRange = null;
      this._raf = 0;
      this.ta.addEventListener('input', () => this.refresh());
    }

    get value() { return this.ta.value; }
    set value(v) { this.ta.value = v; this.refresh(true); }

    setFindRange(range) {
      this.findRange = range;
      this.refresh(true);
    }

    refresh(sync) {
      const run = () => {
        this._raf = 0;
        const v = this.ta.value;
        let html;
        if (this.findRange && this.findRange[1] <= v.length) {
          const [a, b] = this.findRange;
          // 查找命中：高亮层在命中处插入背景标记（宽度不变，因此不影响对齐）
          html = highlightMarkdown(v.slice(0, a)) + `<mark class="hl-find">${esc(v.slice(a, b))}</mark>` + highlightMarkdown(v.slice(b));
        } else {
          html = highlightMarkdown(v);
        }
        this.backdrop.innerHTML = html + '​';
        this.autosize();
      };
      if (sync) { if (this._raf) cancelAnimationFrame(this._raf); run(); return; }
      this.autosize();
      if (!this._raf) this._raf = requestAnimationFrame(run);
    }

    autosize() {
      const ta = this.ta;
      ta.style.height = '0px';
      ta.style.height = ta.scrollHeight + 'px';
    }

    focus(start, end) {
      this.ta.focus({ preventScroll: true });
      if (start !== undefined) this.ta.setSelectionRange(start, end === undefined ? start : end);
    }

    /** 返回光标所在位置相对视口的矩形 {top, bottom, left} */
    caretRect(pos) {
      if (pos === undefined) pos = this.ta.selectionEnd;
      const v = this.ta.value;
      this.mirror.textContent = v.slice(0, pos);
      const probe = document.createElement('span');
      probe.textContent = '​';
      this.mirror.appendChild(probe);
      const r = probe.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 24;
      const out = { top: r.top, bottom: r.top + lh, left: r.left, lineHeight: lh };
      this.mirror.textContent = '';
      return out;
    }

    /** 光标是否位于第一 / 最后一个视觉行 */
    caretOnEdge(which) {
      const ta = this.ta;
      const pos = which === 'first' ? ta.selectionStart : ta.selectionEnd;
      if (which === 'first' && pos === 0) return true;
      if (which === 'last' && pos === ta.value.length) return true;
      const c = this.caretRect(pos);
      const box = ta.getBoundingClientRect();
      const cs = getComputedStyle(ta);
      if (which === 'first') return c.top - box.top - parseFloat(cs.paddingTop) < c.lineHeight * 0.6;
      return box.bottom - parseFloat(cs.paddingBottom) - c.bottom < c.lineHeight * 0.6;
    }
  }

  /* ======================= 自动配对 / 选中包裹 ======================= */
  // 所有修改都通过 execCommand('insertText') 完成，因此会触发 beforeinput / input 并进入撤销历史
  const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
  const WRAPS = Object.assign({ '*': '*', _: '_', '~': '~', '=': '=', $: '$' }, PAIRS);
  const CLOSERS = new Set([')', ']', '}', '"', "'", '`']);
  const FULL_PAIRS = { '（': '）', '【': '】', '「': '」', '《': '》', '“': '”', '‘': '’' };
  const FULL_CLOSERS = new Set(Object.values(FULL_PAIRS));
  const WORD = /[\p{L}\p{N}_]/u;

  function replaceRange(ta, a, b, text, selA, selB) {
    ta.setSelectionRange(a, b);
    document.execCommand(text ? 'insertText' : 'delete', false, text);
    ta.setSelectionRange(selA, selB === undefined ? selA : selB);
  }

  /** 键盘输入时的自动配对、跳过右括号、成对删除与选中包裹；返回 true 表示已处理 */
  function autoPairKeydown(ta, e, prefs) {
    if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return false;
    const v = ta.value;
    const s = ta.selectionStart;
    const end = ta.selectionEnd;
    const ch = e.key;
    if (ch === 'Backspace') {
      if (!prefs.autoPair || s !== end || s === 0) return false;
      const open = v[s - 1];
      if ((PAIRS[open] || FULL_PAIRS[open]) && (PAIRS[open] || FULL_PAIRS[open]) === v[s]) {
        replaceRange(ta, s - 1, s + 1, '', s - 1);
        return true;
      }
      return false;
    }
    if (ch.length !== 1) return false;
    if (s !== end) {
      const close = prefs.wrapSelection ? WRAPS[ch] : null;
      if (!close) return false;
      replaceRange(ta, s, end, ch + v.slice(s, end) + close, s + 1, end + 1);
      return true;
    }
    if (!prefs.autoPair) return false;
    const prev = v[s - 1] || '';
    const next = v[s] || '';
    if (CLOSERS.has(ch) && next === ch) { ta.setSelectionRange(s + 1, s + 1); return true; }
    const close = PAIRS[ch];
    if (!close) return false;
    if (next && WORD.test(next)) return false; // 紧挨文字之前不配对
    if ((ch === '"' || ch === "'" || ch === '`') && WORD.test(prev)) return false; // 英文撇号等
    if (ch === '`' && v.slice(s - 2, s) === '``') return false; // 输入 ``` 代码围栏
    replaceRange(ta, s, s, ch + close, s + 1);
    return true;
  }

  /** 输入法输入的全角括号 / 引号：补全右半边，或跳过已存在的右半边；返回 true 表示已处理 */
  function autoPairInput(ta, ev, prefs) {
    if (!prefs.autoPair || ev.isComposing) return false;
    const type = ev.type === 'compositionend' ? 'insertText' : ev.inputType;
    if (type !== 'insertText' || !ev.data || ev.data.length !== 1) return false;
    const ch = ev.data;
    const s = ta.selectionStart;
    const v = ta.value;
    if (s !== ta.selectionEnd || v[s - 1] !== ch) return false;
    if (FULL_PAIRS[ch]) {
      if (v[s] && WORD.test(v[s])) return false;
      document.execCommand('insertText', false, FULL_PAIRS[ch]);
      ta.setSelectionRange(s, s);
      return true;
    }
    if (FULL_CLOSERS.has(ch) && v[s] === ch) {
      ta.setSelectionRange(s, s + 1);
      document.execCommand('delete');
      return true;
    }
    return false;
  }

  window.ZHL = { HLTextarea, highlightMarkdown, autoPairKeydown, autoPairInput };
})();
