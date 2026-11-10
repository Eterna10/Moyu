/* Moyu — markdown-it 配置与扩展插件
 * 全局依赖：markdownit, markdownitFootnote, katex, hljs, DOMPurify, mermaid
 */
/* global markdownit, markdownitFootnote, katex, hljs, DOMPurify, mermaid */
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function slugify(text) {
    const s = String(text)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}\-_]/gu, '');
    return s || 'section';
  }

  /* ---------------- 插件扩展注册表 ---------------- */
  // uses：markdown-it 插件；fences：自定义代码块语言渲染器；post：渲染后的 DOM 处理函数
  const registry = { uses: [], fences: new Map(), post: [] };

  /** 公式块编号属性（由 headingPlugin 在解析时写入 token.meta.eq） */
  const eqAttr = (t) => (t.meta && t.meta.eq ? ` data-eq="${t.meta.eq}"` : '');

  /* ---------------- KaTeX ---------------- */
  const katexCache = new Map();
  function renderTex(tex, display) {
    const key = (display ? 'D:' : 'I:') + tex;
    if (katexCache.has(key)) return katexCache.get(key);
    let html;
    try {
      html = katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html', strict: 'ignore' });
    } catch (e) {
      html = `<span class="math-error" title="${escapeHtml(e.message)}">${escapeHtml(tex)}</span>`;
    }
    if (katexCache.size > 2000) katexCache.clear();
    katexCache.set(key, html);
    return html;
  }

  function mathPlugin(md) {
    // 行内公式 $...$
    md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
      const src = state.src;
      const pos = state.pos;
      if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;
      if (src.charCodeAt(pos + 1) === 0x24) return false; // $$ 交给块级
      let end = pos + 1;
      for (;;) {
        end = src.indexOf('$', end);
        if (end === -1 || end >= state.posMax) return false;
        if (src.charCodeAt(end - 1) === 0x5c /* \ */) { end++; continue; }
        break;
      }
      const content = src.slice(pos + 1, end);
      if (!content || /^\s|\s$/.test(content)) return false;
      if (/\d/.test(src[end + 1] || '')) return false; // 避免 $5 与 $6 被识别
      if (!silent) {
        const t = state.push('math_inline', 'math', 0);
        t.content = content;
        t.markup = '$';
      }
      state.pos = end + 1;
      return true;
    });

    // 块级公式 $$ ... $$
    md.block.ruler.after('blockquote', 'math_block', (state, startLine, endLine, silent) => {
      let pos = state.bMarks[startLine] + state.tShift[startLine];
      let max = state.eMarks[startLine];
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      if (pos + 2 > max || state.src.slice(pos, pos + 2) !== '$$') return false;
      const first = state.src.slice(pos + 2, max);
      let content = '';
      let next = startLine;
      let found = false;
      if (first.trim().length >= 2 && first.trim().endsWith('$$')) {
        content = first.trim().slice(0, -2);
        found = true;
      } else {
        const lines = first.trim() ? [first] : [];
        for (next = startLine + 1; next < endLine; next++) {
          pos = state.bMarks[next] + state.tShift[next];
          max = state.eMarks[next];
          const line = state.src.slice(pos, max);
          if (line.trim().endsWith('$$')) {
            const before = line.trim().slice(0, -2);
            if (before) lines.push(before);
            found = true;
            break;
          }
          lines.push(state.src.slice(state.bMarks[next], max));
        }
        content = lines.join('\n');
      }
      if (!found) return false; // 未闭合时不当作公式，避免吞掉后文
      if (silent) return true;
      state.line = next + 1;
      const t = state.push('math_block', 'math', 0);
      t.block = true;
      t.content = content;
      t.markup = '$$';
      t.map = [startLine, state.line];
      return true;
    }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

    md.renderer.rules.math_inline = (tokens, idx) =>
      `<span class="math-inline" data-md="$${escapeHtml(tokens[idx].content)}$">${renderTex(tokens[idx].content, false)}</span>`;
    md.renderer.rules.math_block = (tokens, idx) =>
      `<div class="math-block"${eqAttr(tokens[idx])}>${renderTex(tokens[idx].content, true)}</div>\n`;
  }

  /* ---------------- ==高亮== ---------------- */
  function markPlugin(md) {
    md.inline.ruler.before('emphasis', 'mark', (state, silent) => {
      const src = state.src;
      const start = state.pos;
      if (src.charCodeAt(start) !== 0x3d || src.charCodeAt(start + 1) !== 0x3d) return false;
      const end = src.indexOf('==', start + 2);
      if (end < 0 || end === start + 2 || end + 2 > state.posMax) return false;
      if (!silent) {
        const oldMax = state.posMax;
        state.pos = start + 2;
        state.posMax = end;
        state.push('mark_open', 'mark', 1);
        state.md.inline.tokenize(state);
        state.push('mark_close', 'mark', -1);
        state.posMax = oldMax;
      }
      state.pos = end + 2;
      return true;
    });
  }

  /* ---------------- YAML Front Matter ---------------- */
  function frontMatterPlugin(md) {
    md.block.ruler.before('table', 'front_matter', (state, startLine, endLine, silent) => {
      if (startLine !== 0 || state.blkIndent !== 0) return false;
      const lineText = (n) => state.src.slice(state.bMarks[n], state.eMarks[n]);
      if (lineText(0).trim() !== '---') return false;
      let next = 1;
      for (; next < endLine; next++) {
        const t = lineText(next).trim();
        if (t === '---' || t === '...') break;
      }
      if (next >= endLine) return false;
      if (silent) return true;
      const t = state.push('front_matter', '', 0);
      t.block = true;
      t.map = [0, next + 1];
      const lines = [];
      for (let i = 1; i < next; i++) lines.push(lineText(i));
      t.content = lines.join('\n');
      state.line = next + 1;
      return true;
    });
    md.renderer.rules.front_matter = (tokens, idx) =>
      `<pre class="front-matter"><span class="fm-label">YAML</span>${escapeHtml(tokens[idx].content)}</pre>\n`;
  }

  /* ---------------- [TOC] ---------------- */
  function tocPlugin(md) {
    md.block.ruler.before('paragraph', 'toc', (state, startLine, endLine, silent) => {
      const pos = state.bMarks[startLine] + state.tShift[startLine];
      const line = state.src.slice(pos, state.eMarks[startLine]);
      if (!/^\[toc\]\s*$/i.test(line)) return false;
      if (silent) return true;
      const t = state.push('toc', '', 0);
      t.block = true;
      t.map = [startLine, startLine + 1];
      state.line = startLine + 1;
      return true;
    });
    md.renderer.rules.toc = (tokens, idx, opts, env) => {
      const heads = (env && env.headings) || [];
      if (!heads.length) return '<nav class="md-toc md-toc-empty">目录（暂无标题）</nav>\n';
      const minLevel = Math.min(...heads.map((h) => h.level));
      const items = heads
        .map((h) => `<li class="toc-l${h.level - minLevel + 1}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`)
        .join('');
      return `<nav class="md-toc"><ul>${items}</ul></nav>\n`;
    };
  }

  /* ---------------- 任务列表 ---------------- */
  function taskListPlugin(md) {
    md.core.ruler.after('inline', 'task_lists', (state) => {
      const tokens = state.tokens;
      for (let i = 2; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
        const first = t.children && t.children[0];
        if (!first || first.type !== 'text' || !/^\[[ xX]\](\s|$)/.test(first.content)) continue;
        const checked = first.content[1] !== ' ';
        first.content = first.content.slice(3).replace(/^\s/, '');
        const li = tokens[i - 2];
        const cb = new state.Token('html_inline', '', 0);
        const line = li.map ? li.map[0] : -1;
        cb.content = `<input type="checkbox" class="task-checkbox" data-line="${line}"${checked ? ' checked' : ''}>`;
        t.children.unshift(cb);
        li.attrJoin('class', 'task-list-item' + (checked ? ' done' : ''));
        for (let j = i - 3; j >= 0; j--) {
          if ((tokens[j].type === 'bullet_list_open' || tokens[j].type === 'ordered_list_open') && tokens[j].level === li.level - 1) {
            const cls = tokens[j].attrGet('class') || '';
            if (!cls.includes('contains-task-list')) tokens[j].attrJoin('class', 'contains-task-list');
            break;
          }
        }
      }
    });
  }

  /* ---------------- 标题锚点 + 大纲收集 ---------------- */
  function inlineText(token) {
    if (!token || !token.children) return token ? token.content : '';
    return token.children
      .map((c) => (c.type === 'text' || c.type === 'code_inline' || c.type === 'math_inline' ? c.content : (c.children ? inlineText(c) : '')))
      .join('');
  }
  const MATH_FENCES = new Set(['math', 'katex', 'latex', 'tex']);

  function headingPlugin(md) {
    md.core.ruler.push('heading_ids', (state) => {
      const used = Object.create(null);
      const heads = [];
      const tokens = state.tokens;
      // 标题编号与公式编号在解析整篇文档时计算并写入属性（data-num / data-eq），
      // 是否显示由 <body> 上的类名控制。编辑器按块渲染，无法依赖跨块的 CSS 计数器。
      const counters = [0, 0, 0, 0, 0, 0, 0];
      let eq = 0;
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'math_block' || (t.type === 'fence' && MATH_FENCES.has((t.info || '').trim().split(/\s+/)[0].toLowerCase()))) {
          t.meta = Object.assign({}, t.meta, { eq: ++eq });
          continue;
        }
        if (t.type !== 'heading_open') continue;
        const level = Number(t.tag.slice(1));
        const text = inlineText(tokens[i + 1]).trim();
        let id = slugify(text);
        if (used[id] !== undefined) { used[id]++; id = `${id}-${used[id]}`; } else used[id] = 0;
        t.attrSet('id', id);
        if (level >= 2) {
          counters[level]++;
          for (let k = level + 1; k < counters.length; k++) counters[k] = 0;
          if (level <= 4) t.attrSet('data-num', counters.slice(2, level + 1).join('.'));
        }
        heads.push({ level, text: text || '(无标题)', id, line: t.map ? t.map[0] : 0 });
      }
      state.env.headings = heads;
    });
  }

  /* ---------------- 图片路径 ---------------- */
  function isExternal(src) {
    return /^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src);
  }
  function toFileUrl(absPath) {
    let p = absPath.replace(/\\/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
    return 'file://' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }
  function resolveSrc(src, baseDir) {
    if (!src || src.startsWith('#')) return src;
    if (/^[a-z]:[\\/]/i.test(src) || src.startsWith('\\\\')) return toFileUrl(src); // Windows 绝对路径
    if (isExternal(src)) return src;
    if (!baseDir) return src;
    try {
      let decoded = src;
      try { decoded = decodeURI(src); } catch (e) { /* 保持原样 */ }
      return new URL(decoded.replace(/\\/g, '/'), toFileUrl(baseDir) + '/').href;
    } catch (e) {
      return src;
    }
  }

  /* ---------------- 上标 ^x^ / 下标 ~x~ ---------------- */
  function supSubPlugin(md) {
    const rule = (name, code, tag) => (state, silent) => {
      const src = state.src;
      const start = state.pos;
      const max = state.posMax;
      if (silent || src.charCodeAt(start) !== code || start + 2 >= max) return false;
      if (src.charCodeAt(start + 1) === code) return false; // ~~ 留给删除线
      let pos = start + 1;
      while (pos < max && src.charCodeAt(pos) !== code) pos += src.charCodeAt(pos) === 0x5c ? 2 : 1;
      if (pos >= max || pos === start + 1) return false;
      const content = src.slice(start + 1, pos);
      if (/(^|[^\\])\s/.test(content)) return false; // 不允许未转义的空白
      state.push(name + '_open', tag, 1).markup = String.fromCharCode(code);
      state.push('text', '', 0).content = content.replace(/\\(.)/g, '$1');
      state.push(name + '_close', tag, -1).markup = String.fromCharCode(code);
      state.pos = pos + 1;
      return true;
    };
    md.inline.ruler.after('emphasis', 'sup', rule('sup', 0x5e, 'sup'));
    md.inline.ruler.after('emphasis', 'sub', rule('sub', 0x7e, 'sub'));
  }

  /** 高亮后的 HTML 按行切分（跨行的 <span> 在行尾闭合、下一行重新打开），用于显示行号 */
  function splitLines(html) {
    const lines = [];
    const open = [];
    let cur = '';
    const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+|<)/g;
    let m;
    while ((m = re.exec(html))) {
      if (m[1]) { cur += m[1]; open.push(m[1]); } else if (m[2]) { cur += m[2]; open.pop(); } else if (m[3]) {
        lines.push(cur + '</span>'.repeat(open.length));
        cur = open.join('');
      } else cur += m[4];
    }
    lines.push(cur + '</span>'.repeat(open.length));
    if (lines.length > 1 && lines[lines.length - 1].replace(/<[^>]+>/g, '') === '') lines.pop();
    return lines;
  }

  /* ---------------- 代码块 / Mermaid ---------------- */
  function makeFenceRenderer(opts) {
    return function fenceRenderer(tokens, idx) {
      const t = tokens[idx];
      const info = (t.info || '').trim();
      const lang = info.split(/\s+/)[0] || '';
      const lower = lang.toLowerCase();
      const custom = registry.fences.get(lower);
      if (custom) {
        try {
          const html = custom(t.content, info);
          if (html !== null && html !== undefined) return `<div class="plugin-fence" data-lang="${escapeHtml(lower)}">${html}</div>\n`;
        } catch (e) {
          return `<pre class="mermaid-error">插件渲染「${escapeHtml(lang)}」代码块出错：${escapeHtml(e.message)}</pre>\n`;
        }
      }
      if (lower === 'mermaid' && opts.mermaid) {
        // 源码需编码：DOMPurify 会移除含有 "-->" 的属性值
        return `<div class="mermaid-block" data-src="${encodeURIComponent(t.content)}"><div class="mermaid-pending">图表渲染中…</div></div>\n`;
      }
      if (opts.math && (lower === 'math' || lower === 'katex' || lower === 'latex' || lower === 'tex')) {
        return `<div class="math-block"${eqAttr(t)}>${renderTex(t.content, true)}</div>\n`;
      }
      let body;
      if (lang && hljs.getLanguage(lower)) {
        try { body = hljs.highlight(t.content, { language: lower, ignoreIllegals: true }).value; } catch (e) { body = escapeHtml(t.content); }
      } else {
        body = escapeHtml(t.content);
      }
      // 每行末尾保留换行符，复制代码时内容不变
      if (opts.lineNumbers) body = splitLines(body).map((l) => `<span class="code-line">${l}\n</span>`).join('');
      return `<div class="code-block${opts.lineNumbers ? ' with-lines' : ''}"><div class="code-toolbar"><span class="code-lang">${escapeHtml(lang)}</span><button class="code-copy" type="button" title="复制代码">复制</button></div>` +
        `<pre><code class="hljs${lang ? ' language-' + escapeHtml(lower) : ''}">${body}</code></pre></div>\n`;
    };
  }

  /**
   * 创建 markdown-it 实例。options：breaks、linkify、typographer、math、mark、supSub、mermaid、lineNumbers
   */
  function createMd(options) {
    const opts = Object.assign({ breaks: true, linkify: true, typographer: false, math: true, mark: true, supSub: false, mermaid: true, lineNumbers: false }, options || {});
    const md = markdownit({ html: true, linkify: opts.linkify, typographer: opts.typographer, breaks: opts.breaks, quotes: '“”‘’' });
    md.use(markdownitFootnote);
    md.use(frontMatterPlugin);
    if (opts.math) md.use(mathPlugin);
    if (opts.mark) md.use(markPlugin);
    if (opts.supSub) md.use(supSubPlugin);
    md.use(tocPlugin);
    md.use(taskListPlugin);
    md.use(headingPlugin);
    md.renderer.rules.fence = makeFenceRenderer(opts);
    md.renderer.rules.code_block = (tokens, idx) =>
      `<div class="code-block"><pre><code class="hljs">${escapeHtml(tokens[idx].content)}</code></pre></div>\n`;
    const defaultImage = md.renderer.rules.image;
    md.renderer.rules.image = (tokens, idx, o, env, self) => {
      const t = tokens[idx];
      const src = t.attrGet('src') || '';
      t.attrSet('data-orig-src', src);
      t.attrSet('src', resolveSrc(src, env && env.baseDir));
      t.attrSet('loading', 'lazy');
      return defaultImage(tokens, idx, o, env, self);
    };
    md.validateLink = (url) => !/^\s*(javascript|vbscript):/i.test(url);
    for (const u of registry.uses) {
      try { md.use(u.fn, ...u.args); } catch (e) { console.warn('[插件] markdown-it 扩展加载失败：', e); }
    }
    return md;
  }

  /* ---------------- HTML 净化 ---------------- */
  const sanitizeCache = new Map();
  const PURIFY_CFG = {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    ADD_ATTR: ['target', 'checked', 'data-line', 'data-src', 'data-orig-src', 'loading'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
  };
  function sanitize(html) {
    if (sanitizeCache.has(html)) return sanitizeCache.get(html);
    const clean = DOMPurify.sanitize(html, PURIFY_CFG);
    if (sanitizeCache.size > 3000) sanitizeCache.clear();
    sanitizeCache.set(html, clean);
    return clean;
  }

  /* ---------------- 渲染后处理 ---------------- */
  let mermaidSeq = 0;
  let mermaidTheme = 'default';
  const mermaidCache = new Map();
  function setMermaidTheme(dark) {
    const theme = dark ? 'dark' : 'default';
    if (theme === mermaidTheme && mermaidSeq > 0) return;
    mermaidTheme = theme;
    mermaidCache.clear();
    mermaid.initialize({ startOnLoad: false, theme, securityLevel: 'strict', fontFamily: 'inherit' });
  }
  mermaid.initialize({ startOnLoad: false, theme: mermaidTheme, securityLevel: 'strict' });

  const pendingRenders = new Set();
  async function renderMermaid(el) {
    let src = el.getAttribute('data-src') || '';
    try { src = decodeURIComponent(src); } catch (e) { /* 保持原样 */ }
    const key = mermaidTheme + '\u0000' + src;
    if (el._mmdKey === key) return;
    el._mmdKey = key;
    if (mermaidCache.has(key)) { el.innerHTML = mermaidCache.get(key); return; }
    const id = 'zmark-mmd-' + (++mermaidSeq);
    try {
      const { svg } = await mermaid.render(id, src);
      mermaidCache.set(key, svg);
      if (el._mmdKey === key) el.innerHTML = svg;
    } catch (e) {
      const msg = `<pre class="mermaid-error">Mermaid 语法错误：\n${escapeHtml((e && e.message) || String(e))}</pre>`;
      if (el._mmdKey === key) el.innerHTML = msg;
      const leftover = document.getElementById('d' + id);
      if (leftover) leftover.remove();
    }
  }

  function postProcess(root, baseDir) {
    root.querySelectorAll('.mermaid-block').forEach((el) => {
      const p = renderMermaid(el);
      pendingRenders.add(p);
      p.finally(() => pendingRenders.delete(p));
    });
    root.querySelectorAll('img:not([data-orig-src])').forEach((img) => {
      const src = img.getAttribute('src') || '';
      img.setAttribute('data-orig-src', src);
      const r = resolveSrc(src, baseDir);
      if (r !== src) img.setAttribute('src', r);
    });
    root.querySelectorAll('a[href]').forEach((a) => {
      if (!a.title) a.title = 'Ctrl + 单击打开：' + a.getAttribute('href');
    });
    for (const fn of registry.post) {
      try { fn(root); } catch (e) { console.warn('[插件] 渲染后处理出错：', e); }
    }
  }

  async function whenRendered() {
    while (pendingRenders.size) await Promise.all([...pendingRenders]);
  }

  window.ZMD = { registry, createMd, sanitize, postProcess, whenRendered, setMermaidTheme, escapeHtml, slugify, resolveSrc, toFileUrl, isExternal };
})();
