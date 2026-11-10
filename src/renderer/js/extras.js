/* Moyu — 扩展功能：命令面板 / 快速打开、斜杠命令、历史版本、图片放大预览、在线更新界面
 * 通过 ZExtras.init(ctx) 接入应用外壳，ctx 提供 api、state、editor() 等能力（见 app.js）。
 */
/* global ZMD */
(function () {
  'use strict';

  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => ZMD.escapeHtml(String(s));

  /** 命令面板中可搜索的内置命令（id、名称、快捷键、额外关键词） */
  const COMMANDS = [
    ['file.new', '新建文档', 'Ctrl+N'], ['file.open', '打开文件…', 'Ctrl+O'], ['file.openFolder', '打开文件夹…', 'Ctrl+Shift+O'],
    ['file.save', '保存', 'Ctrl+S'], ['file.saveAs', '另存为…', 'Ctrl+Shift+S'], ['file.toggleAutoSave', '开关自动保存', ''],
    ['file.history', '历史版本…', '', 'history version 恢复'], ['file.exportHtml', '导出 HTML…', '', 'export'], ['file.exportPdf', '导出 PDF…', 'Ctrl+Shift+P', 'export'],
    ['file.reveal', '在资源管理器中显示', ''], ['file.preferences', '偏好设置…', 'Ctrl+,', 'settings 设置'], ['file.preferencesTheme', '主题与外观…', '', 'theme background 背景 字体'],
    ['edit.undo', '撤销', 'Ctrl+Z'], ['edit.redo', '重做', 'Ctrl+Y'], ['edit.find', '查找', 'Ctrl+F', 'search'], ['edit.replace', '替换', 'Ctrl+H'],
    ['para.h1', '一级标题', 'Ctrl+1', 'heading'], ['para.h2', '二级标题', 'Ctrl+2', 'heading'], ['para.h3', '三级标题', 'Ctrl+3', 'heading'],
    ['para.h4', '四级标题', 'Ctrl+4'], ['para.h5', '五级标题', 'Ctrl+5'], ['para.h6', '六级标题', 'Ctrl+6'], ['para.p', '正文段落', 'Ctrl+0', 'paragraph'],
    ['para.table', '插入表格', 'Ctrl+T', 'table'], ['para.code', '插入代码块', 'Ctrl+Shift+K', 'code'], ['para.math', '插入公式块', 'Ctrl+Shift+M', 'math latex'],
    ['para.quote', '引用', 'Ctrl+Shift+Q', 'quote'], ['para.ol', '有序列表', 'Ctrl+Shift+[', 'list'], ['para.ul', '无序列表', 'Ctrl+Shift+]', 'list'],
    ['para.task', '任务列表', 'Ctrl+Shift+X', 'todo task'], ['para.hr', '分割线', '', 'hr line'], ['para.toc', '插入目录 [TOC]', '', 'toc'],
    ['fmt.bold', '加粗', 'Ctrl+B', 'bold'], ['fmt.italic', '斜体', 'Ctrl+I', 'italic'], ['fmt.underline', '下划线', 'Ctrl+U'], ['fmt.strike', '删除线', 'Alt+Shift+5'],
    ['fmt.mark', '高亮', 'Ctrl+Shift+H', 'highlight'], ['fmt.code', '行内代码', 'Ctrl+Shift+`'], ['fmt.math', '行内公式', 'Ctrl+Shift+E'],
    ['fmt.link', '超链接', 'Ctrl+K', 'link'], ['fmt.image', '插入图片…', 'Ctrl+Shift+I', 'image'], ['fmt.uploadAll', '上传所有本地图片', ''], ['fmt.clear', '清除样式', 'Ctrl+\\'],
    ['view.source', '源代码模式', 'Ctrl+/', 'source'], ['view.rich', '纯文本模式', 'F7'], ['view.sidebar', '显示 / 隐藏侧边栏', 'Ctrl+Shift+L'],
    ['view.outline', '大纲', 'Ctrl+Shift+1', 'outline'], ['view.files', '文件树', 'Ctrl+Shift+3'], ['view.focus', '专注模式', 'F8', 'focus'], ['view.typewriter', '打字机模式', 'F9'],
    ['theme.github', '主题：GitHub', '', 'theme'], ['theme.newsprint', '主题：Newsprint 报刊', '', 'theme'], ['theme.night', '主题：Night 夜间', '', 'theme dark'], ['theme.midnight', '主题：Midnight 午夜蓝', '', 'theme dark'],
    ['help.welcome', '欢迎文档', ''], ['help.syntax', 'Markdown 语法参考', ''], ['help.shortcuts', '快捷键一览', ''], ['help.pluginGuide', '插件开发指南', ''],
    ['help.checkUpdate', '检查更新…', '', 'update upgrade 升级'], ['help.about', '关于 Moyu', ''], ['plugins.manage', '管理插件…', '', 'plugin'], ['plugins.reload', '重新加载插件', '', 'plugin'],
    ['plugins.aiPrompt', '一键提示词：用 AI 生成插件', '', 'ai prompt 插件 tishici'],
  ];

  /** 模糊匹配：字符按顺序出现即可；连续命中、词首命中得分更高。返回 { score, idx } 或 null */
  function fuzzy(query, text) {
    const q = query.toLowerCase();
    const s = text.toLowerCase();
    if (!q) return { score: 0, idx: [] };
    const idx = [];
    let score = 0;
    let last = -2;
    for (let j = 0, i = 0; j < s.length && i < q.length; j++) {
      if (s[j] !== q[i]) continue;
      score += (j === last + 1 ? 5 : 1) + (j === 0 || /[\s/\\._\-·：]/.test(s[j - 1]) ? 3 : 0);
      idx.push(j);
      last = j;
      i++;
    }
    return idx.length === q.length ? { score: score - s.length * 0.02, idx } : null;
  }

  function highlight(text, idx) {
    const set = new Set(idx);
    return Array.from(text).map((ch, i) => (set.has(i) ? `<b>${esc(ch)}</b>` : esc(ch))).join('');
  }

  function init(ctx) {
    const { api, state } = ctx;

    /* ======================= 命令面板 / 快速打开 ======================= */

    let palette = null;

    async function fileItems() {
      const seen = new Set();
      const items = [];
      const add = (p, from) => {
        if (!p || seen.has(p.toLowerCase())) return;
        seen.add(p.toLowerCase());
        const name = p.split(/[\\/]/).pop();
        items.push({ kind: 'file', path: p, label: name, detail: p.slice(0, p.length - name.length - 1), from });
      };
      if (state.folder) {
        const tree = await api.invoke('fs:tree', state.folder).catch(() => null);
        const walk = (n) => (n.children || []).forEach((c) => (c.dir ? walk(c) : add(c.path, '文件夹')));
        if (tree) walk(tree);
      }
      (state.settings.recentFiles || []).forEach((p) => add(p, '最近'));
      return items;
    }

    function commandItems() {
      const list = COMMANDS.map(([id, label, key, kw]) => ({ kind: 'cmd', id, label, key, search: label + ' ' + id + ' ' + (kw || '') }));
      for (const c of ctx.pluginCommands()) list.push({ kind: 'cmd', id: c.key, label: `${c.pluginName}：${c.title}`, key: (c.accelerator || '').replace(/CmdOrCtrl/g, 'Ctrl'), search: c.pluginName + ' ' + c.title });
      return list;
    }

    async function openPalette(mode) {
      closePalette();
      const mask = document.createElement('div');
      mask.className = 'palette-mask';
      mask.innerHTML = `<div class="palette" role="dialog"><input class="palette-input" spellcheck="false" placeholder="输入文件名搜索；输入 &gt; 搜索命令"><div class="palette-list" role="listbox"></div><div class="palette-hint">↑↓ 选择 · Enter 打开 · Esc 关闭 · 输入 &gt; 切换到命令</div></div>`;
      document.body.appendChild(mask);
      const input = $('.palette-input', mask);
      const listEl = $('.palette-list', mask);
      palette = { mask, sel: 0, items: [], files: null };
      input.value = mode === 'cmd' ? '>' : '';
      const render = async () => {
        const raw = input.value;
        const cmdMode = raw.startsWith('>');
        const q = (cmdMode ? raw.slice(1) : raw).trim();
        let pool;
        if (cmdMode) pool = commandItems();
        else {
          if (!palette.files) palette.files = await fileItems();
          pool = palette.files;
          if (!pool.length) {
            listEl.innerHTML = `<div class="palette-empty">${state.folder ? '文件夹中没有 Markdown 文件' : '尚未打开文件夹，也没有最近文件。<br>输入 &gt; 可搜索命令'}</div>`;
            palette.items = [];
            return;
          }
        }
        const scored = [];
        for (const it of pool) {
          const m = fuzzy(q, it.label) || (cmdMode ? fuzzy(q, it.search) : fuzzy(q, it.detail + '/' + it.label));
          if (m) scored.push({ it, m, onLabel: !!fuzzy(q, it.label) });
        }
        scored.sort((a, b) => b.m.score - a.m.score);
        palette.items = scored.slice(0, 60);
        palette.sel = 0;
        listEl.innerHTML = palette.items.map(({ it, m, onLabel }, i) => `<div class="palette-item${i === 0 ? ' active' : ''}" data-i="${i}">
            <span class="pi-icon">${it.kind === 'file' ? '📄' : '›'}</span>
            <span class="pi-label">${onLabel ? highlight(it.label, m.idx) : esc(it.label)}</span>
            <span class="pi-detail">${esc(it.kind === 'file' ? it.detail : it.key || '')}</span></div>`).join('')
          || '<div class="palette-empty">没有匹配的结果</div>';
      };
      const move = (d) => {
        if (!palette.items.length) return;
        palette.sel = (palette.sel + d + palette.items.length) % palette.items.length;
        listEl.querySelectorAll('.palette-item').forEach((el, i) => el.classList.toggle('active', i === palette.sel));
        const a = listEl.querySelector('.palette-item.active');
        if (a) a.scrollIntoView({ block: 'nearest' });
      };
      const choose = (i) => {
        const pick = palette.items[i];
        if (!pick) return;
        closePalette();
        if (pick.it.kind === 'file') ctx.openPath(pick.it.path);
        else ctx.runCommand(pick.it.id);
      };
      input.addEventListener('input', render);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); } else if (e.key === 'Enter') { e.preventDefault(); choose(palette.sel); } else if (e.key === 'Escape') { e.preventDefault(); closePalette(); ctx.focusEditor(); }
      });
      listEl.addEventListener('mousedown', (e) => { const it = e.target.closest('.palette-item'); if (it) { e.preventDefault(); choose(Number(it.dataset.i)); } });
      mask.addEventListener('mousedown', (e) => { if (e.target === mask) closePalette(); });
      input.focus();
      await render();
    }

    function closePalette() {
      if (palette) { palette.mask.remove(); palette = null; }
    }

    /* ======================= 斜杠命令 ======================= */

    const SLASH = [
      { id: 'h1', label: '一级标题', kw: 'h1 heading title biaoti', tpl: '# ' },
      { id: 'h2', label: '二级标题', kw: 'h2 heading biaoti', tpl: '## ' },
      { id: 'h3', label: '三级标题', kw: 'h3 heading biaoti', tpl: '### ' },
      { id: 'ul', label: '无序列表', kw: 'ul list bullet liebiao', tpl: '- ' },
      { id: 'ol', label: '有序列表', kw: 'ol list number liebiao', tpl: '1. ' },
      { id: 'task', label: '任务列表', kw: 'todo task checkbox renwu', tpl: '- [ ] ' },
      { id: 'quote', label: '引用', kw: 'quote blockquote yinyong', tpl: '> ' },
      { id: 'code', label: '代码块', kw: 'code daima', cmd: 'para.code' },
      { id: 'math', label: '公式块', kw: 'math latex gongshi', cmd: 'para.math' },
      { id: 'table', label: '表格', kw: 'table biaoge', cmd: 'para.table' },
      { id: 'mermaid', label: '流程图（Mermaid）', kw: 'mermaid flow chart diagram liucheng tubiao', tpl: '```mermaid\ngraph LR\n  A[开始] --> B[结束]\n```', caret: 30 },
      { id: 'image', label: '图片…', kw: 'image picture tupian', cmd: 'fmt.image' },
      { id: 'hr', label: '分割线', kw: 'hr line divider fengexian', cmd: 'para.hr' },
      { id: 'toc', label: '目录', kw: 'toc contents mulu', cmd: 'para.toc' },
    ];
    let slash = null;

    function slashItems() {
      // 插件提供的「插入…」命令（例如提示块）也出现在斜杠菜单中
      const extra = ctx.pluginCommands().filter((c) => /^插入/.test(c.title)).map((c) => ({ id: c.key, label: c.title.replace(/^插入/, ''), kw: c.pluginName + ' ' + c.title, cmd: c.key }));
      return SLASH.concat(extra);
    }

    /** 每次编辑块内容变化时调用：块内容为「/关键词」时显示菜单 */
    function checkSlash() {
      const ed = ctx.editor();
      if (!state.settings.slashCommands || !ed || !ed.isEditing() || state.sourceMode) return closeSlash();
      const m = /^\/([^\s/]{0,16})$/.exec(ed.hl.value);
      if (!m) return closeSlash();
      const q = m[1];
      const items = slashItems().map((it) => ({ it, m: fuzzy(q, it.label) || fuzzy(q, it.kw) })).filter((x) => x.m).sort((a, b) => b.m.score - a.m.score);
      if (!items.length) return closeSlash();
      if (!slash) {
        slash = { el: document.createElement('div'), sel: 0 };
        slash.el.className = 'slash-menu';
        document.body.appendChild(slash.el);
        slash.el.addEventListener('mousedown', (e) => { const r = e.target.closest('.slash-item'); if (r) { e.preventDefault(); runSlash(Number(r.dataset.i)); } });
      }
      slash.items = items.map((x) => x.it);
      slash.sel = Math.min(slash.sel, slash.items.length - 1);
      slash.el.innerHTML = '<div class="slash-title">插入</div>' + slash.items.map((it, i) => `<div class="slash-item${i === slash.sel ? ' active' : ''}" data-i="${i}">${esc(it.label)}</div>`).join('');
      const r = ed.editorEl.getBoundingClientRect();
      const h = Math.min(slash.el.offsetHeight || 300, 320);
      const below = r.bottom + 4 + h < window.innerHeight - 30;
      slash.el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 240)) + 'px';
      slash.el.style.top = (below ? r.bottom + 4 : Math.max(8, r.top - h - 4)) + 'px';
      return undefined;
    }

    function closeSlash() {
      if (slash) { slash.el.remove(); slash = null; }
    }

    function runSlash(i) {
      const it = slash && slash.items[i];
      closeSlash();
      if (!it) return;
      const ed = ctx.editor();
      ed.applyEdit('', 0);
      if (it.tpl !== undefined) ed.applyEdit(it.tpl, it.caret === undefined ? it.tpl.length : it.caret);
      else ctx.runCommand(it.cmd);
    }

    function slashKeydown(e) {
      if (!slash) return;
      const k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        slash.sel = (slash.sel + (k === 'ArrowDown' ? 1 : -1) + slash.items.length) % slash.items.length;
        slash.el.querySelectorAll('.slash-item').forEach((el, j) => el.classList.toggle('active', j === slash.sel));
      } else if (k === 'Enter' || k === 'Tab') runSlash(slash.sel);
      else if (k === 'Escape') closeSlash();
      else return;
      e.preventDefault();
      e.stopPropagation();
    }

    /* ======================= 图片放大预览 ======================= */

    let lastImgClick = null;

    function openLightbox(src, alt) {
      const mask = document.createElement('div');
      mask.className = 'lightbox';
      mask.innerHTML = `<img src="${esc(src)}" alt="${esc(alt || '')}"><div class="lightbox-bar"><span>${esc(alt || '')}</span><span class="lightbox-zoom">适应窗口</span><button class="text-btn" data-act="close">关闭 (Esc)</button></div>`;
      document.body.appendChild(mask);
      const img = $('img', mask);
      let scale = 1;
      const zoomLabel = $('.lightbox-zoom', mask);
      const setScale = (v) => {
        scale = Math.min(8, Math.max(0.2, v));
        img.style.transform = `scale(${scale})`;
        zoomLabel.textContent = scale === 1 ? '适应窗口' : Math.round(scale * 100) + '%';
      };
      const close = () => { mask.remove(); document.removeEventListener('keydown', onKey, true); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
      document.addEventListener('keydown', onKey, true);
      mask.addEventListener('wheel', (e) => { e.preventDefault(); setScale(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); }, { passive: false });
      mask.addEventListener('click', (e) => {
        if (e.target === img) setScale(scale === 1 ? 2 : 1);
        else if (e.target === mask || e.target.closest('[data-act=close]')) close();
      });
      return close;
    }

    // 双击文档中的图片放大（第一次单击会进入编辑，因此按两次单击的位置与间隔判断）
    document.addEventListener('click', (e) => {
      const img = e.target.closest && e.target.closest('#write img, .md-rich img');
      const now = Date.now();
      if (img) {
        if (lastImgClick && lastImgClick.src === img.src && now - lastImgClick.t < 450) { lastImgClick = null; openLightbox(img.src, img.alt); return; }
        lastImgClick = { src: img.src, alt: img.alt, x: e.clientX, y: e.clientY, t: now };
        return;
      }
      if (lastImgClick && now - lastImgClick.t < 450 && Math.hypot(e.clientX - lastImgClick.x, e.clientY - lastImgClick.y) < 8 && $('#content-wrap').contains(e.target)) {
        const { src, alt } = lastImgClick;
        lastImgClick = null;
        openLightbox(src, alt);
      }
    }, true);

    /* ======================= 历史版本 ======================= */

    /** 按行比较（最长公共子序列）；过大的文档只比较行数变化 */
    function diffLines(a, b) {
      const A = a.split('\n');
      const B = b.split('\n');
      if (A.length * B.length > 4e6) return null;
      const n = A.length;
      const m = B.length;
      const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      const out = [];
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (A[i] === B[j]) { out.push([' ', A[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', A[i++]]); else out.push(['+', B[j++]]);
      }
      while (i < n) out.push(['-', A[i++]]);
      while (j < m) out.push(['+', B[j++]]);
      return out;
    }

    const ago = (t) => {
      const s = (Date.now() - t) / 1000;
      if (s < 60) return '刚刚';
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
      return Math.floor(s / 86400) + ' 天前';
    };
    const fmtTime = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

    async function openHistory() {
      if (!state.filePath) { ctx.toast('文档尚未保存，没有历史版本'); return; }
      if (!state.settings.historyEnabled) { ctx.toast('历史版本已在偏好设置中关闭'); return; }
      const list = await api.invoke('history:list', state.filePath);
      if (!list.length) { ctx.toast('还没有历史版本：保存文档时会自动保留'); return; }
      ctx.showModal(`<h3>历史版本 · ${esc(ctx.docName())}</h3>
        <div class="history"><div class="history-list">${list.map((v, i) => `<div class="history-item${i === 0 ? ' active' : ''}" data-id="${esc(v.id)}"><b>${fmtTime(v.time)}</b><span>${ago(v.time)} · ${(v.size / 1024).toFixed(1)} KB</span></div>`).join('')}</div>
        <div class="history-main"><div class="history-tabs"><button class="text-btn on" data-view="diff">与当前对比</button><button class="text-btn" data-view="preview">预览</button><span class="history-stat"></span></div><div class="history-body markdown-body"></div></div></div>
        <div class="actions"><button class="text-btn" data-act="clear">清除此文档的历史</button><span style="flex:1"></span><button class="text-btn" data-act="close">关闭</button><button class="text-btn primary" data-act="restore">恢复此版本</button></div>`,
      (el, close) => {
        el.classList.add('history-modal');
        let text = '';
        let view = 'diff';
        const body = $('.history-body', el);
        const show = () => {
          $$(el, '[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
          const cur = ctx.getText();
          const d = diffLines(text, cur);
          $('.history-stat', el).textContent = d ? `相对当前：-${d.filter((x) => x[0] === '-').length} 行 / +${d.filter((x) => x[0] === '+').length} 行` : '';
          if (view === 'preview') { body.className = 'history-body markdown-body'; body.innerHTML = ctx.renderMarkdown(text); return; }
          body.className = 'history-body history-diff';
          if (!d) { body.textContent = '文档过大，无法逐行对比'; return; }
          if (!d.some((x) => x[0] !== ' ')) { body.innerHTML = '<div class="history-same">与当前内容相同</div>'; return; }
          body.innerHTML = d.map(([k, l]) => `<div class="dl ${k === '+' ? 'add' : k === '-' ? 'del' : ''}"><i>${k === ' ' ? '' : k === '+' ? '当前' : '历史'}</i>${esc(l) || ' '}</div>`).join('');
        };
        const load = async (id) => {
          el.dataset.id = id;
          $$(el, '.history-item').forEach((it) => it.classList.toggle('active', it.dataset.id === id));
          // 快照保存的是磁盘上的原样内容；编辑器内部不含末尾换行，统一后再比较与恢复
          text = (await api.invoke('history:read', state.filePath, id)).replace(/\r\n?/g, '\n').replace(/\n$/, '');
          show();
        };
        $('.history-list', el).addEventListener('click', (e) => { const it = e.target.closest('.history-item'); if (it) load(it.dataset.id); });
        $$(el, '[data-view]').forEach((b) => { b.onclick = () => { view = b.dataset.view; show(); }; });
        $('[data-act=close]', el).onclick = close;
        $('[data-act=restore]', el).onclick = () => { ctx.setText(text); close(); ctx.toast('已恢复该版本（可撤销），保存后生效'); };
        $('[data-act=clear]', el).onclick = async () => { await api.invoke('history:clear', state.filePath); close(); ctx.toast('已清除此文档的历史版本'); };
        load(list[0].id);
      });
    }
    const $$ = (el, s) => Array.from(el.querySelectorAll(s));

    /* ======================= 在线更新 ======================= */

    let lastCheck = null;

    function setUpdateBadge(r) {
      const b = $('#sb-update');
      if (!b) return;
      b.hidden = !(r && r.ok && r.newer);
      if (!b.hidden) { b.textContent = `⬆ 新版本 ${r.latest}`; b.title = `Moyu ${r.latest} 已发布，点击查看`; }
    }

    async function checkUpdate(silent) {
      const r = await api.invoke('update:check').catch((e) => ({ ok: false, error: e.message }));
      lastCheck = r;
      setUpdateBadge(r);
      if (silent) { if (r.ok && r.newer) ctx.toast(`发现新版本 Moyu ${r.latest}，点击状态栏的「新版本」查看`); return r; }
      showUpdate(r);
      return r;
    }

    function showUpdate(r) {
      const fmtMB = (n) => (n / 1048576).toFixed(1) + ' MB';
      let body;
      if (!r.ok) body = `<p>检查更新失败：${esc(r.error)}</p><p class="update-meta">当前版本 ${esc(r.current || '')} · 仓库 ${esc(r.repo || '')}</p>`;
      else if (!r.newer) body = `<p>✔ 已是最新版本（${esc(r.current)}）。</p><p class="update-meta">GitHub 上的最新版本：${esc(r.latest)}</p>`;
      else {
        body = `<p class="update-meta">当前版本 ${esc(r.current)} → <b>最新版本 ${esc(r.latest)}</b>${r.publishedAt ? ' · 发布于 ' + esc(r.publishedAt.slice(0, 10)) : ''}</p>
          <div class="update-notes markdown-body">${r.notes ? ctx.renderMarkdown(r.notes) : '（无更新说明）'}</div>
          ${r.asset ? `<p class="update-meta">安装包：${esc(r.asset.name)}（${fmtMB(r.asset.size)}）${r.asset.digest ? ' · 下载后校验 SHA-256' : ''}</p>` : '<p class="update-meta">该版本没有适合当前运行方式的安装包，请到发布页下载。</p>'}
          <div class="update-progress" hidden><div class="bar"><i></i></div><span></span></div>`;
      }
      ctx.showModal(`<h3>检查更新</h3>${body}<div class="actions">
          ${r.ok && r.url ? '<button class="text-btn" data-act="page">查看发布页</button>' : ''}<span style="flex:1"></span>
          <button class="text-btn" data-act="close">${r.ok && r.newer ? '稍后' : '关闭'}</button>
          ${r.ok && r.newer && r.asset ? '<button class="text-btn primary" data-act="download">下载并安装</button>' : ''}</div>`,
      (el, close) => {
        el.classList.add('update-modal');
        const prog = $('.update-progress', el);
        $('[data-act=close]', el).onclick = async () => { await api.invoke('update:cancel'); close(); };
        const page = $('[data-act=page]', el);
        if (page) page.onclick = () => api.invoke('shell:open', r.url);
        const dl = $('[data-act=download]', el);
        if (!dl) return;
        dl.onclick = async () => {
          dl.disabled = true;
          dl.textContent = '正在下载…';
          prog.hidden = false;
          let res;
          try {
            res = await api.invoke('update:download', r.asset);
          } catch (err) {
            dl.disabled = false;
            dl.textContent = '重新下载';
            $('span', prog).textContent = '下载失败：' + String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
            return;
          }
          if (res.canceled) return;
          $('span', prog).textContent = res.verified ? '下载完成，SHA-256 校验通过' : '下载完成';
          const kind = r.kind;
          dl.disabled = false;
          dl.textContent = kind === 'setup' ? '退出并安装' : '打开所在文件夹';
          dl.onclick = async () => {
            const done = await api.invoke('update:install', res.file);
            if (done.kind === 'portable') ctx.toast('新版便携版已放到当前程序旁边，关闭本程序后运行新版本即可');
            else if (done.kind === 'setup') ctx.toast('Moyu 将退出并启动安装程序');
            close();
          };
        };
      });
    }

    api.on('update-progress', (p) => {
      const prog = $('.update-modal .update-progress');
      if (!prog) return;
      const pct = p.total ? Math.min(100, (p.received / p.total) * 100) : 0;
      $('i', prog).style.width = pct + '%';
      if (!p.done) $('span', prog).textContent = `${(p.received / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB（${pct.toFixed(0)}%）`;
    });

    return {
      openPalette, closePalette, checkSlash, slashKeydown, closeSlash, slashOpen: () => !!slash, slashItems: () => (slash ? slash.items.map((x) => x.label) : []),
      openLightbox, openHistory, checkUpdate, showUpdate, lastUpdate: () => lastCheck, fuzzy,
    };
  }

  window.ZExtras = { init, COMMANDS, fuzzy };
})();
