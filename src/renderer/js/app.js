/* Moyu — 应用外壳：文件、侧边栏、查找替换、设置、导出、命令分发 */
/* global BlockEditor, ZHL, ZMD, katex */
(function () {
  'use strict';

  const api = window.zmark;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) => ZMD.escapeHtml(s);
  const basename = (p) => (p ? p.split(/[\\/]/).pop() : '');
  const dirname = (p) => (p ? p.replace(/[\\/][^\\/]*$/, '') : null);
  const MD_RE = /\.(md|markdown|mdown|mkd|txt)$/i;
  const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
  const DARK = new Set(['night', 'midnight', 'moyu-night']);

  const state = {
    filePath: null,
    displayName: null,
    baseDir: null,
    savedText: '',
    eol: '\n',
    trailingNewline: true,
    mtime: null,
    settings: {},
    folder: null,
    expanded: new Set(),
    sourceMode: false,
    selfTest: false,
    info: {},
  };
  let editor;
  let source;
  let pluginHost;
  let extras;
  let ws; // 工作区功能（右键菜单、文件树管理、搜索、智能粘贴、崩溃恢复）

  /* ======================= 插件宿主所需的基础设施 ======================= */

  /** 事件总线：change / open / willSave / save / theme */
  const bus = {
    map: new Map(),
    on(evt, fn) {
      if (!this.map.has(evt)) this.map.set(evt, []);
      this.map.get(evt).push(fn);
      return () => { const l = this.map.get(evt) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
    },
    listeners(evt) { return [...(this.map.get(evt) || [])]; },
    emit(evt, ...args) {
      for (const fn of this.listeners(evt)) {
        try { fn(...args); } catch (e) { console.warn(`[插件] ${evt} 事件处理出错`, e); }
      }
    },
  };

  const docStyles = new Set(); // 插件注册的文档样式（导出时一并写入）

  function addStyle(css, forDocument, owner) {
    const el = document.createElement('style');
    el.dataset.plugin = owner || '';
    el.textContent = css;
    document.head.appendChild(el);
    if (forDocument) docStyles.add(css);
    return () => { el.remove(); docStyles.delete(css); };
  }

  /** 状态栏插件项 */
  function addStatusItem(owner, opts) {
    const el = document.createElement('span');
    el.className = 'status-item plugin-item' + (opts.onClick ? ' clickable' : '');
    el.dataset.plugin = owner;
    el.textContent = opts.text || '';
    if (opts.title) el.title = opts.title;
    if (opts.onClick) el.addEventListener('click', (e) => opts.onClick(e));
    $('#sb-plugins').appendChild(el);
    return {
      el,
      setText: (t) => { el.textContent = String(t); },
      setTitle: (t) => { el.title = String(t); },
      setVisible: (v) => { el.hidden = !v; },
      remove: () => el.remove(),
    };
  }

  /** 侧边栏插件面板（与「文件」「大纲」并列的页签） */
  const panelHooks = new Map();
  function addSidebarPanel(key, opts) {
    const tab = document.createElement('button');
    tab.className = 'side-tab';
    tab.dataset.tab = key;
    tab.textContent = opts.title || '插件';
    tab.title = opts.title || '';
    tab.onclick = () => setSetting({ sidebarTab: key });
    $('.side-tabs').appendChild(tab);
    const el = document.createElement('div');
    el.className = 'side-panel plugin-panel';
    el.id = 'panel-' + key;
    $('#sidebar').appendChild(el);
    if (opts.onShow) panelHooks.set(key, opts.onShow);
    const isVisible = () => state.settings.sidebar && el.classList.contains('active');
    // 推迟到插件代码拿到返回值之后再触发 onShow，避免插件在回调中访问尚未赋值的变量
    if (state.settings.sidebarTab === key) queueMicrotask(() => { if (el.isConnected) setSidebarTab(key); });
    return {
      el,
      isVisible,
      show: () => setSetting({ sidebar: true, sidebarTab: key }),
      remove: () => {
        const wasActive = el.classList.contains('active');
        tab.remove();
        el.remove();
        panelHooks.delete(key);
        if (wasActive) setSidebarTab('outline');
      },
    };
  }

  function getSelection() {
    if (state.sourceMode) return source.ta.value.slice(source.ta.selectionStart, source.ta.selectionEnd);
    return editor.getSelectedText();
  }

  /** 整体替换文档内容（可撤销） */
  function setText(text) {
    if (state.sourceMode) { if (text !== source.value) sourceReplace(0, source.value.length, text); }
    else editor.replaceAllText(text);
  }

  function insertBlock(text, caret) {
    if (state.sourceMode) {
      const ta = source.ta;
      const before = ta.value.slice(0, ta.selectionStart);
      const pre = !before || before.endsWith('\n\n') ? '' : (before.endsWith('\n') ? '\n' : '\n\n');
      ta.focus();
      document.execCommand('insertText', false, pre + text + '\n');
      return;
    }
    editor.insertBlocks([text], 0, caret === undefined ? text.length : caret);
  }

  function renderMarkdown(text) {
    return ZMD.sanitize(editor.md.render(text, { baseDir: state.baseDir }));
  }

  /* ======================= 工具 ======================= */

  function toast(msg, error) {
    const el = document.createElement('div');
    el.className = 'toast' + (error ? ' error' : '');
    el.textContent = msg;
    $('#toast-root').appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, error ? 3600 : 1800);
  }

  function debounce(fn, ms) {
    let t = 0;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function offsetOfLine(text, n) {
    let off = 0;
    for (let i = 0; i < n; i++) {
      const p = text.indexOf('\n', off);
      if (p === -1) return text.length;
      off = p + 1;
    }
    return off;
  }
  const lineOfOffset = (text, off) => text.slice(0, off).split('\n').length - 1;

  function showModal(html, onMount) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal" role="dialog">${html}</div>`;
    const close = () => { mask.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
    document.addEventListener('keydown', onKey, true);
    $('#modal-root').appendChild(mask);
    if (onMount) onMount(mask.firstElementChild, close);
    return close;
  }

  function promptText(title, value, placeholder) {
    return new Promise((resolve) => {
      let done = false;
      const close = showModal(
        `<h3>${esc(title)}</h3><input type="text" class="prompt-input" style="width:100%" value="${esc(value || '')}" placeholder="${esc(placeholder || '')}">
         <div class="actions"><button class="text-btn" data-act="cancel">取消</button><button class="text-btn primary" data-act="ok">确定</button></div>`,
        (el, closeFn) => {
          const input = $('.prompt-input', el);
          const finish = (v) => { if (done) return; done = true; closeFn(); resolve(v); };
          input.focus();
          input.select();
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim() || null); });
          $('[data-act=ok]', el).onclick = () => finish(input.value.trim() || null);
          $('[data-act=cancel]', el).onclick = () => finish(null);
        });
      const obs = new MutationObserver(() => { if (!document.contains($('.prompt-input'))) { obs.disconnect(); if (!done) { done = true; resolve(null); } } });
      obs.observe($('#modal-root'), { childList: true });
      void close;
    });
  }

  /* ======================= 文档状态 ======================= */

  const getText = () => (state.sourceMode ? source.value : editor.getMarkdown());
  const isDirty = () => getText() !== state.savedText;
  const docName = () => (state.filePath ? basename(state.filePath) : (state.displayName || '未命名'));

  function serialize(text) {
    const finalNewline = state.trailingNewline || state.settings.insertFinalNewline;
    return (text + (finalNewline && text ? '\n' : '')).replace(/\n/g, state.eol);
  }

  /** 删除行尾空白：保留用于硬换行的两个空格，代码块内不处理 */
  function trimTrailingWhitespace(text) {
    let fence = null;
    return text.split('\n').map((line) => {
      const m = /^\s*(`{3,}|~{3,})/.exec(line);
      if (m) { if (!fence) fence = m[1][0]; else if (m[1][0] === fence) fence = null; return line.replace(/\s+$/, ''); }
      if (fence) return line;
      const t = /[ \t]+$/.exec(line);
      if (!t) return line;
      const body = line.slice(0, t.index);
      return body && /^ {2,}$/.test(t[0]) ? body + '  ' : body;
    }).join('\n');
  }

  /** 由文件内容得到一份文档的各项状态（换行符、末尾换行、路径等） */
  function docFields(content, meta) {
    meta = meta || {};
    let t = content.replace(/\r\n?/g, '\n');
    const trailingNewline = meta.filePath ? t.endsWith('\n') : true;
    if (t.endsWith('\n')) t = t.slice(0, -1);
    return {
      // 已有文件保持原换行符；新文件使用「新建文件的换行符」设置
      eol: meta.filePath ? (/\r\n/.test(content) ? '\r\n' : '\n') : (state.settings.defaultEol === 'CRLF' ? '\r\n' : '\n'),
      trailingNewline,
      filePath: meta.filePath || null,
      displayName: meta.name || null,
      mtime: meta.mtime || null,
      baseDir: meta.baseDir || dirname(meta.filePath) || null,
      savedText: meta.markDirty ? null : t,
      text: t,
    };
  }

  /** 把内容载入当前标签页（替换其中的文档） */
  function loadText(content, meta) {
    saveScroll(); // 离开当前文档前记下读到的位置
    const d = docFields(content, meta);
    for (const k of DOC_KEYS) state[k] = d[k];
    const t = d.text;
    editor.setMarkdown(t, { baseDir: state.baseDir });
    if (state.sourceMode) { source.value = t; source.focus(0); $('#source').scrollTop = 0; }
    lastTitle = '';
    updateTitle();
    refreshDerived();
    markTreeCurrent();
    restoreScroll();
    saveSession();
    bus.emit('open', { filePath: state.filePath, name: docName() });
    if (ws) ws.touchRecovery();
  }

  /* ======================= 标签页 ======================= */

  // 每个标签页是一份文档。当前标签页的状态就在 state / editor 里；其余标签页的状态存放在各自的对象中，
  // 切换时换出当前的、换入目标的（文本、撤销记录、光标、滚动位置各自独立）。
  const DOC_KEYS = ['filePath', 'displayName', 'baseDir', 'savedText', 'eol', 'trailingNewline', 'mtime'];
  const tabs = [];
  let activeTab = null;
  let tabSeq = 0;
  const closedTabs = []; // 最近关闭的文件，用于「重新打开关闭的标签页」
  const samePath = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const tabsOn = () => state.settings.tabs !== false;

  function newTab() {
    return {
      id: ++tabSeq,
      rkey: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10), // 崩溃恢复用的标识
      filePath: null, displayName: null, baseDir: null, savedText: '', eol: '\n', trailingNewline: true, mtime: null,
      text: '', history: [], future: [], scrollTop: 0, caret: null,
    };
  }
  const tabPath = (t) => (t === activeTab ? state.filePath : t.filePath);
  const tabDirty = (t) => (t === activeTab ? isDirty() : t.text !== t.savedText);
  const tabName = (t) => { const p = tabPath(t); return p ? basename(p) : ((t === activeTab ? state.displayName : t.displayName) || '未命名'); };
  const tabById = (id) => tabs.find((t) => t.id === Number(id));

  /** 把当前文档的状态存回它的标签页 */
  function stashActive() {
    const t = activeTab;
    if (!t) return;
    t.caret = !state.sourceMode && editor.isEditing() && editor.hl.value.trim() ? editor.snapshot().active : null;
    t.scrollTop = state.sourceMode ? $('#source').scrollTop : $('#content').scrollTop;
    if (!state.sourceMode) editor.dropEmptyActive();
    for (const k of DOC_KEYS) t[k] = state[k];
    t.text = getText();
    t.history = editor.history.length > 150 ? editor.history.slice(-150) : editor.history; // 后台标签页只保留最近的撤销记录
    t.future = editor.future;
  }

  /** 把标签页的状态换入 state / editor，使它成为当前文档 */
  function restoreTab(t) {
    activeTab = t;
    for (const k of DOC_KEYS) state[k] = t[k];
    editor.setMarkdown(t.text, { baseDir: state.baseDir });
    editor.history = t.history || [];
    editor.future = t.future || [];
    if (state.sourceMode) { source.value = t.text; source.focus(0); }
    else if (t.caret && t.text.trim()) {
      try { editor.activateRange(t.caret.start, t.caret.start + t.caret.len, t.caret.s, t.caret.e); } catch (e) { /* 光标位置已失效 */ }
    }
    (state.sourceMode ? $('#source') : $('#content')).scrollTop = t.scrollTop || 0;
    lastTitle = '';
    updateTitle();
    refreshDerived();
    markTreeCurrent();
    saveSession();
    bus.emit('open', { filePath: state.filePath, name: docName() });
    if (!$('#findbar').hidden) runFind(false, true);
    checkExternalChange(); // 在后台期间文件可能被其它程序改动
  }

  let switching = Promise.resolve();
  /** 切换到指定的标签页（依次执行，避免连续点击时交错） */
  function switchTab(t) {
    switching = switching.then(async () => {
      if (!t || t === activeTab || !tabs.includes(t)) return;
      // 开着自动保存时，离开前先把修改写入磁盘
      if (state.settings.autoSave && state.filePath && isDirty()) await save(false, true);
      saveScroll();
      stashActive();
      restoreTab(t);
    }).catch((e) => console.error('切换标签页失败', e));
    return switching;
  }

  /** 准备一个用来载入新文档的标签页：当前是空白的新文档时直接复用，否则在它后面新建一个 */
  function prepareTab() {
    const pristine = !state.filePath && !state.displayName && !isDirty() && !getText().trim();
    if (pristine) return;
    saveScroll();
    stashActive();
    const t = newTab();
    tabs.splice(tabs.indexOf(activeTab) + 1, 0, t);
    activeTab = t;
  }

  /** 在标签页中打开一份内容（未启用标签页时替换当前文档） */
  async function openDoc(content, meta) {
    if (tabsOn()) {
      const fp = meta && meta.filePath;
      // 该文件已经在某个标签页中打开：载入到那个标签页，而不是再开一份
      const other = fp && tabs.find((t) => t !== activeTab && samePath(t.filePath, fp));
      if (other) await switchTab(other);
      else if (!samePath(fp, state.filePath)) prepareTab();
    }
    loadText(content, meta);
  }

  /** 关闭标签页；有未保存的修改时先询问。返回 false 表示用户取消 */
  async function closeTab(t) {
    t = t || activeTab;
    if (!tabs.includes(t)) return false;
    if (tabDirty(t)) {
      if (t !== activeTab) await switchTab(t);
      if (!(await confirmDiscard())) return false;
    }
    const fp = tabPath(t);
    if (fp) { closedTabs.push(fp); if (closedTabs.length > 20) closedTabs.shift(); }
    if (ws) ws.dropRecovery(t.rkey);
    const i = tabs.indexOf(t);
    if (tabs.length === 1) {
      // 最后一个标签页：换成一份空白文档，窗口保持打开
      saveScroll();
      activeTab = newTab();
      tabs[0] = activeTab;
      loadText('', {});
      return true;
    }
    if (t === activeTab) {
      saveScroll();
      tabs.splice(i, 1);
      restoreTab(tabs[Math.min(i, tabs.length - 1)]);
    } else {
      tabs.splice(i, 1);
      renderTabs();
      saveSession();
    }
    return true;
  }

  /** 依次关闭一组标签页，用户取消其中一个时停止 */
  async function closeTabs(list) {
    for (const t of list) if (tabs.includes(t) && !(await closeTab(t))) return false;
    return true;
  }

  function stepTab(dir) {
    if (tabs.length < 2) return undefined;
    return switchTab(tabs[(tabs.indexOf(activeTab) + dir + tabs.length) % tabs.length]);
  }

  async function reopenClosedTab() {
    while (closedTabs.length) {
      const p = closedTabs.pop();
      if (tabs.some((t) => samePath(tabPath(t), p))) continue;
      if (await api.invoke('fs:exists', p)) { await openPath(p); return true; }
    }
    toast('没有可以重新打开的标签页');
    return false;
  }

  /** 把标签页移到另一个标签页之前（before 为 null 时移到末尾） */
  function moveTab(t, before) {
    if (!t || t === before) return;
    tabs.splice(tabs.indexOf(t), 1);
    const i = before ? tabs.indexOf(before) : -1;
    tabs.splice(i < 0 ? tabs.length : i, 0, t);
    renderTabs();
    saveSession();
  }

  /** 关闭窗口前：逐个确认有未保存修改的标签页 */
  async function confirmAllTabs() {
    for (const t of [activeTab].concat(tabs.filter((x) => x !== activeTab))) {
      if (!tabs.includes(t) || !tabDirty(t)) continue;
      if (t !== activeTab) await switchTab(t);
      if (!(await confirmDiscard())) return false;
    }
    return true;
  }

  let tabsSig = null;
  function renderTabs() {
    const bar = $('#tabbar');
    if (!bar || !activeTab) return;
    const show = tabs.length > 1; // 设置只决定新文件怎样打开；已经开着的标签页始终可见
    const names = tabs.map(tabName);
    const sig = show ? tabs.map((t, i) => [t.id, names[i], tabPath(t) || '', tabDirty(t) ? 1 : 0, t === activeTab ? 1 : 0].join('|')).join('\n') : '';
    if (sig === tabsSig) return;
    tabsSig = sig;
    bar.hidden = !show;
    $('#content-wrap').classList.toggle('has-tabs', show);
    if (!show) { bar.innerHTML = ''; return; }
    bar.innerHTML = tabs.map((t, i) => {
      const fp = tabPath(t);
      // 同名的文件用所在文件夹区分
      const dir = fp && names.filter((n) => n === names[i]).length > 1 ? basename(dirname(fp)) : '';
      return `<div class="tab${t === activeTab ? ' active' : ''}${tabDirty(t) ? ' dirty' : ''}" data-id="${t.id}" draggable="true" title="${esc(fp || names[i])}">` +
        `<span class="tab-name">${esc(names[i])}${dir ? `<span class="tab-dir">${esc(dir)}</span>` : ''}</span><button class="tab-close" title="关闭（Ctrl+W）" tabindex="-1"></button></div>`;
    }).join('') + '<button class="tab-new" title="新建标签页（Ctrl+N）" tabindex="-1">＋</button>';
    const a = $('.tab.active', bar);
    if (a) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function bindTabs() {
    const bar = $('#tabbar');
    bar.addEventListener('click', (e) => {
      if (e.target.closest('.tab-new')) { newDoc(); return; }
      const el = e.target.closest('.tab');
      if (!el) return;
      const t = tabById(el.dataset.id);
      if (e.target.closest('.tab-close')) closeTab(t);
      else switchTab(t);
    });
    // 鼠标中键关闭
    bar.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    bar.addEventListener('auxclick', (e) => { const el = e.target.closest('.tab'); if (e.button === 1 && el) closeTab(tabById(el.dataset.id)); });
    bar.addEventListener('dblclick', (e) => { if (e.target === bar) newDoc(); });
    bar.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) bar.scrollLeft += e.deltaY; }, { passive: true });
    // 拖动调整顺序
    let dragId = null;
    const clearMarks = () => $$('.tab.drop-before, .tab.drop-after', bar).forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    bar.addEventListener('dragstart', (e) => {
      const el = e.target.closest('.tab');
      if (!el) return;
      dragId = el.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/x-moyu-tab', dragId);
    });
    bar.addEventListener('dragover', (e) => {
      if (!dragId) return;
      e.preventDefault();
      e.stopPropagation();
      clearMarks();
      const el = e.target.closest('.tab');
      if (!el || el.dataset.id === dragId) return;
      const r = el.getBoundingClientRect();
      el.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
    });
    bar.addEventListener('drop', (e) => {
      if (!dragId) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.target.closest('.tab');
      const moved = tabById(dragId);
      if (el && el.dataset.id !== dragId) {
        const r = el.getBoundingClientRect();
        const target = tabById(el.dataset.id);
        moveTab(moved, e.clientX < r.left + r.width / 2 ? target : (tabs[tabs.indexOf(target) + 1] || null));
      } else if (!el) moveTab(moved, null);
      clearMarks();
      dragId = null;
    });
    bar.addEventListener('dragend', () => { clearMarks(); dragId = null; });
  }

  /** 标签页的右键菜单 */
  function tabMenu(id) {
    const t = tabById(id);
    if (!t) return null;
    const fp = tabPath(t);
    const i = tabs.indexOf(t);
    return {
      items: [
        { id: 'close', label: '关闭', accelerator: 'Ctrl+W' },
        { id: 'others', label: '关闭其他标签页', enabled: tabs.length > 1 },
        { id: 'right', label: '关闭右侧的标签页', enabled: i < tabs.length - 1 },
        { type: 'separator' },
        { id: 'copy', label: '复制路径', enabled: !!fp },
        { id: 'reveal', label: '在资源管理器中显示', enabled: !!fp },
      ],
      run: async (act) => {
        if (act === 'close') return closeTab(t);
        if (act === 'others') return closeTabs(tabs.filter((x) => x !== t));
        if (act === 'right') return closeTabs(tabs.slice(i + 1));
        if (act === 'copy') { await api.invoke('app:copyText', fp); return toast('已复制路径'); }
        if (act === 'reveal') return api.invoke('shell:reveal', fp);
        return undefined;
      },
    };
  }

  /** 记住打开着哪些文件，供「启动时：重新打开上次的文件」恢复 */
  function saveSession() {
    if (!activeTab) return;
    const files = tabs.map(tabPath).filter(Boolean);
    const active = tabPath(activeTab) || null;
    const cur = state.settings.sessionTabs || [];
    if (files.join('\n') === cur.join('\n') && (state.settings.sessionActive || null) === active) return;
    setSetting({ sessionTabs: files, sessionActive: active });
  }

  /** 启动时恢复上次打开的标签页：只有当前的那个立即渲染，其余的在后台备好 */
  async function restoreSession() {
    const list = tabsOn() && (state.settings.sessionTabs || []).length ? state.settings.sessionTabs : (state.settings.lastFile ? [state.settings.lastFile] : []);
    const want = state.settings.sessionActive || state.settings.lastFile;
    const restored = [];
    for (const p of list.slice(0, 30)) {
      try {
        if (restored.some((t) => samePath(t.filePath, p))) continue;
        if (!(await api.invoke('fs:exists', p))) continue; // 文件已不存在
        const r = await api.invoke('fs:read', p);
        if (r.lossy) continue;
        restored.push(Object.assign(newTab(), docFields(r.content, { filePath: p, mtime: r.mtime })));
      } catch (e) { /* 文件已不存在 */ }
    }
    if (!restored.length) return false;
    tabs.splice(0, tabs.length, ...restored);
    restoreTab(restored.find((t) => samePath(t.filePath, want)) || restored[0]);
    return true;
  }

  /** 文件（或其所在的文件夹）被改名：所有打开着它的标签页跟随到新路径 */
  function relocatePath(from, to) {
    const inside = (p) => !!p && (p === from || p.startsWith(from + '\\') || p.startsWith(from + '/'));
    for (const t of tabs) {
      if (t === activeTab || !inside(t.filePath)) continue;
      t.filePath = to + t.filePath.slice(from.length);
      t.baseDir = dirname(t.filePath);
    }
    if (inside(state.filePath)) relocate(to + state.filePath.slice(from.length));
    renderTabs();
    saveSession();
  }

  /** 文件（或其所在的文件夹）被删除：打开着它的标签页保留内容，变成尚未保存的新文档 */
  function detachPath(base) {
    const inside = (p) => !!p && (p === base || p.startsWith(base + '\\') || p.startsWith(base + '/'));
    for (const t of tabs) {
      if (t === activeTab || !inside(t.filePath)) continue;
      t.displayName = basename(t.filePath);
      t.filePath = null;
      t.mtime = null;
      t.savedText = null;
    }
    if (inside(state.filePath)) detach();
    renderTabs();
    saveSession();
  }

  /** 供崩溃恢复使用：所有标签页中的文档 */
  function recoveryDocs() {
    return tabs.map((t) => ({
      key: t.rkey, active: t === activeTab, dirty: tabDirty(t),
      filePath: tabPath(t), name: tabName(t), text: t === activeTab ? getText() : t.text,
    }));
  }


  /* 阅读位置：记住每个文件滚动到的位置（最近 200 个），重新打开时回到那里 */
  let positionTimer = 0;
  /** 立即记录当前文档的阅读位置（切换文档、关闭窗口之前调用；滚动停止后也会调用） */
  function saveScroll() {
    clearTimeout(positionTimer);
    if (!editor || !state.filePath || state.sourceMode || state.settings.restoreScroll === false) return;
    const top = Math.round($('#content').scrollTop);
    const map = Object.assign({}, state.settings.docPositions || {});
    if ((map[state.filePath] || 0) === top) return;
    delete map[state.filePath]; // 重新插入到末尾，最旧的排在最前
    if (top > 0) map[state.filePath] = top;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete map[k];
    setSetting({ docPositions: map });
  }
  function rememberScroll() {
    if (!state.filePath || state.sourceMode || state.settings.restoreScroll === false) return;
    clearTimeout(positionTimer);
    positionTimer = setTimeout(saveScroll, 800);
  }

  function restoreScroll() {
    clearTimeout(positionTimer);
    if (!state.filePath || state.sourceMode || state.settings.restoreScroll === false) return;
    const top = (state.settings.docPositions || {})[state.filePath];
    if (!top) return;
    const p = state.filePath;
    // 等渲染与布局完成后再滚动；期间用户切换了文档则放弃（不依赖动画帧：窗口被遮住时没有动画帧）
    setTimeout(() => { if (state.filePath === p && !editor.isEditing()) $('#content').scrollTop = top; }, 60);
  }

  async function confirmDiscard() {
    if (!isDirty()) return true;
    const r = await api.invoke('dialog:confirmSave', docName());
    if (r === 0) return save(false);
    return r === 1;
  }

  /**
   * 打开文件。启用标签页时：已经打开的文件切换到它所在的标签页，否则在新标签页中打开（当前是空白文档时复用）。
   * opts.force：即使已经打开也从磁盘重新载入；opts.skipConfirm：重新载入时不询问未保存的修改。
   */
  async function openPath(p, opts) {
    opts = opts || {};
    if (!p) return;
    if (samePath(p, state.filePath) && !opts.force) return;
    if (tabsOn() && !samePath(p, state.filePath)) {
      const other = tabs.find((t) => t !== activeTab && samePath(t.filePath, p));
      if (other) { await switchTab(other); if (!opts.force) return; }
    }
    // 重新载入当前文档，或未启用标签页：替换当前文档，先确认未保存的修改
    const inPlace = !tabsOn() || samePath(p, state.filePath);
    if (inPlace && !opts.skipConfirm && !(await confirmDiscard())) return;
    try {
      const r = await api.invoke('fs:read', p);
      if (!inPlace) prepareTab();
      if (r.lossy) {
        // 无法识别编码：作为未命名的副本打开，保存时需另选位置，原文件不会被覆盖
        loadText(r.content, { name: basename(p).replace(/(\.[^.]+)?$/, '（副本）$1'), baseDir: dirname(p) });
        toast('此文件不是可识别的文本编码，内容可能显示为乱码；已作为副本打开，保存不会覆盖原文件', true);
        return;
      }
      loadText(r.content, { filePath: p, mtime: r.mtime });
      api.invoke('app:addRecent', p);
      rememberLastFile(p);
      // 非 UTF-8 文件已按原编码正确读取；Moyu 统一以 UTF-8 保存
      if (r.encoding && r.encoding !== 'UTF-8') toast(`此文件的编码为 ${r.encoding}，已正确读取；保存时将转换为 UTF-8`);
    } catch (e) {
      toast('无法打开文件：' + e.message, true);
    }
  }

  /** 记录最后打开的文件，用于「启动时：重新打开上次的文件」 */
  function rememberLastFile(p) {
    if (p && state.settings.lastFile !== p) setSetting({ lastFile: p });
  }

  async function newDoc() {
    if (tabsOn()) { prepareTab(); loadText('', {}); return; }
    if (!(await confirmDiscard())) return;
    loadText('', {});
  }

  async function openHelp(name, title) {
    if (tabsOn()) {
      // 已经打开且没有改动过的帮助文档：直接切换过去
      const shown = tabs.find((t) => !tabPath(t) && (t === activeTab ? state.displayName : t.displayName) === (title || name) && !tabDirty(t));
      if (shown) { await switchTab(shown); return; }
    } else if (!(await confirmDiscard())) return;
    const r = await api.invoke('app:helpDoc', name);
    await openDoc(r.content, { name: title || name, baseDir: r.dir });
  }

  function suggestedName() {
    const heads = editor.computeHeadings();
    let n = heads.length ? heads[0].text : (state.displayName || '未命名');
    n = n.replace(/\.md$/i, '').replace(/[\\/:*?"<>|]/g, '').slice(0, 60).trim() || '未命名';
    const name = n + '.md';
    return state.folder ? state.folder + '\\' + name : name;
  }

  async function save(saveAs, quiet) {
    let p = state.filePath;
    if (!p || saveAs) {
      p = await api.invoke('dialog:save', { title: saveAs ? '另存为' : '保存', defaultPath: state.filePath || suggestedName() });
      if (!p) return false;
    }
    // 保存前确认磁盘上的文件没有被其它程序改动，避免（尤其是自动保存）悄悄覆盖别处的修改
    if (p === state.filePath && state.mtime && state.settings.externalChange !== 'ignore') {
      const m = await api.invoke('fs:stat', p);
      if (m && Math.abs(m - state.mtime) >= 1) {
        if (quiet) { checkExternalChange(); return false; } // 自动保存：改为询问用户，本次不写入
        const r = await api.invoke('dialog:message', {
          type: 'warning', buttons: ['覆盖', '取消'], defaultId: 1, cancelId: 1,
          message: `“${docName()}”在打开后已被其他程序修改。`,
          detail: '继续保存将覆盖磁盘上的那些修改。',
        });
        if (r !== 0) return false;
      }
    }
    let text = getText();
    // 插件可在保存前改写内容（例如自动更新 Front Matter 中的修改时间）
    for (const fn of bus.listeners('willSave')) {
      try {
        const out = fn(text, { filePath: p });
        if (typeof out === 'string') text = out;
      } catch (e) { console.warn('[插件] onWillSave 出错', e); }
    }
    if (state.settings.trimTrailingWhitespace) text = trimTrailingWhitespace(text);
    // 历史版本：写入前保留快照（首次保存时还会保存磁盘上原有的内容）
    if (state.settings.historyEnabled) await api.invoke('history:snapshot', p, text).catch((e) => console.warn('保存历史版本失败', e));
    if (text !== getText()) setText(text);
    try {
      const r = await api.invoke('fs:write', p, serialize(text));
      const changedPath = state.filePath !== p;
      state.filePath = p;
      state.mtime = r.mtime;
      state.savedText = text;
      state.displayName = null;
      if (changedPath) {
        state.baseDir = dirname(p);
        if (!state.sourceMode) editor.setBaseDir(state.baseDir);
        api.invoke('app:addRecent', p);
        rememberLastFile(p);
        if (state.folder && p.startsWith(state.folder)) loadFolder(state.folder);
        // 另存到了另一个标签页打开着的文件上：去掉那个没有改动的标签页，避免同一文件开着两份
        for (const t of tabs.filter((x) => x !== activeTab && samePath(x.filePath, p) && !tabDirty(x))) tabs.splice(tabs.indexOf(t), 1);
        saveSession();
      }
      updateTitle();
      if (!quiet) toast('已保存');
      bus.emit('save', { filePath: p });
      if (ws) ws.touchRecovery();
      return true;
    } catch (e) {
      toast('保存失败：' + e.message, true);
      return false;
    }
  }

  // 自动保存：停止输入「自动保存延迟」秒后保存
  let autoSaveTimer = 0;
  function autoSave() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      if (state.settings.autoSave && state.filePath && isDirty()) save(false, true);
    }, Math.max(0.5, Number(state.settings.autoSaveDelay) || 2) * 1000);
  }

  /** 窗口失去焦点时保存（已保存过的文件） */
  function saveOnBlur() {
    if (state.settings.saveOnBlur && state.filePath && isDirty()) save(false, true);
  }

  async function checkExternalChange() {
    if (!state.filePath || state.settings.externalChange === 'ignore') return;
    const m = await api.invoke('fs:stat', state.filePath);
    if (!m || !state.mtime || Math.abs(m - state.mtime) < 1) return;
    state.mtime = m;
    if (!isDirty() && state.settings.externalChange !== 'ask') {
      const r = await api.invoke('fs:read', state.filePath);
      loadText(r.content, { filePath: state.filePath, mtime: r.mtime });
      toast('文件已在外部更新，已重新加载');
      return;
    }
    const r = await api.invoke('dialog:message', {
      type: 'question', buttons: ['重新加载', '保留我的修改'], defaultId: 1, cancelId: 1,
      message: `“${docName()}”已被其他程序修改。`,
      detail: isDirty() ? '重新加载将丢失你在 Moyu 中尚未保存的修改。' : '是否重新加载磁盘上的最新内容？',
    });
    if (r === 0) openPath(state.filePath, { force: true, skipConfirm: true });
  }

  async function onBeforeClose() {
    let ok = true;
    try { ok = await confirmAllTabs(); } catch (e) { ok = true; } // 初始化失败时也必须能关闭窗口
    if (ok) { saveScroll(); if (ws) await ws.clearRecovery(); api.invoke('win:close'); }
  }

  /* ======================= 标题 / 状态栏 / 大纲 ======================= */

  let lastTitle = '';
  function updateTitle() {
    const dirty = isDirty();
    const title = `${dirty ? '• ' : ''}${docName()} - Moyu`;
    if (title !== lastTitle) { lastTitle = title; api.invoke('win:setTitle', title, dirty); } // 只在变化时通知主进程

    const s = $('#sb-save');
    s.classList.toggle('dirty', dirty);
    s.textContent = dirty ? '未保存' : (state.filePath ? (state.settings.autoSave ? '已自动保存' : '已保存') : '新文档');
    renderTabs();
  }

  const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯　-〿＀-￯]/g;
  function countWords(t) {
    const plain = t.replace(/[#*_`>~|=[\]()!\\-]/g, ' ');
    const cjk = (plain.match(CJK) || []).length;
    const words = (plain.replace(CJK, ' ').match(/[A-Za-z0-9À-ɏ]+(?:['’][A-Za-z]+)*/g) || []).length;
    return { cjk, words, total: cjk + words, chars: t.replace(/\s/g, '').length };
  }

  function updateCount() {
    const c = countWords(getText());
    const mins = Math.max(1, Math.round(c.cjk / 400 + c.words / 220));
    $('#sb-count').textContent = `字数 ${c.total.toLocaleString()} · 字符 ${c.chars.toLocaleString()} · 约 ${mins} 分钟`;
  }

  function onSelection(sel) {
    $('#sb-selection').textContent = sel ? `已选 ${countWords(sel).total} 字` : '';
  }

  function headingsOf(text) {
    const env = {};
    try { editor.md.parse(text, env); } catch (e) { return []; }
    return env.headings || [];
  }

  function updateOutline() {
    const heads = state.sourceMode ? headingsOf(source.value) : editor.computeHeadings();
    const box = $('#outline');
    if (!heads.length) { box.innerHTML = '<div class="empty-hint">文档中还没有标题。<br>使用 <b>#</b> 或 Ctrl+1~6 创建标题后，大纲会显示在这里。</div>'; return; }
    box.innerHTML = heads.map((h) => `<div class="outline-item l${h.level}" data-id="${esc(h.id)}" data-line="${h.line}" title="${esc(h.text)}">${esc(h.text)}</div>`).join('');
    syncOutlineActive();
  }

  function syncOutlineActive() {
    if (state.sourceMode) return;
    const sc = $('#content');
    const top = sc.getBoundingClientRect().top + 80;
    let cur = null;
    for (const h of $$('#write h1[id], #write h2[id], #write h3[id], #write h4[id], #write h5[id], #write h6[id]')) {
      if (h.getBoundingClientRect().top <= top) cur = h.id; else break;
    }
    $$('.outline-item').forEach((el) => el.classList.toggle('active', el.dataset.id === cur));
  }

  /** 滚动到标题。大文档中屏幕外块的高度是估算值，跳转后块被真正排版、高度变化，需再校正几次 */
  function revealHeading(el) {
    if (!$('#write').classList.contains('large-doc')) { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    el.scrollIntoView({ block: 'start' });
    const sc = $('#content');
    let frames = 0;
    let stable = 0;
    // 每帧校正一次，直到连续 3 帧位置不再变化（最多约 0.5 秒）
    const fix = () => {
      if (!el.isConnected || frames++ > 30) return;
      const d = el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 16;
      if (Math.abs(d) > 2) { sc.scrollTop += d; stable = 0; } else stable++;
      if (stable < 3) requestAnimationFrame(fix);
    };
    requestAnimationFrame(fix);
  }

  function scrollToHeading(id, line) {
    if (state.sourceMode) {
      const off = offsetOfLine(source.value, line);
      source.focus(off);
      scrollSourceToCaret(true);
      return;
    }
    const el = $('#write').querySelector('#' + CSS.escape(id));
    const sc = $('#content');
    if (el) revealHeading(el);
    else if (editor.isEditing()) editor.editorEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  const refreshDerived = debounce(() => {
    updateCount();
    updateOutline();
    if (!$('#findbar').hidden) runFind(true, true);
    bus.emit('change');
  }, 250);

  function onChange() {
    updateTitle();
    refreshDerived();
    autoSave();
    if (extras) extras.checkSlash();
    if (ws) ws.touchRecovery();
  }

  /* ======================= 文件树 ======================= */

  async function loadFolder(dir) {
    const tree = await api.invoke('fs:tree', dir);
    if (!tree) {
      state.folder = null;
      renderTree(null);
      if (state.settings.lastFolder === dir) setSetting({ lastFolder: null });
      return;
    }
    state.folder = dir;
    state.expanded.add(dir);
    if (state.settings.lastFolder !== dir) setSetting({ lastFolder: dir });
    renderTree(tree);
  }

  function renderTree(tree) {
    const box = $('#file-tree');
    $('#folder-name').textContent = tree ? tree.name : '未打开文件夹';
    $('#folder-name').title = tree ? tree.path : '';
    if (!tree) {
      box.innerHTML = '<div class="empty-hint">打开一个文件夹，即可在这里浏览其中的 Markdown 文件。<br><button class="text-btn" id="btn-open-folder-2">打开文件夹…</button></div>';
      $('#btn-open-folder-2').onclick = () => runCommand('file.openFolder');
      return;
    }
    const build = (node, depth) => {
      if (!node.children.length && depth === 0) return '<div class="empty-hint">该文件夹中没有 Markdown 文件。</div>';
      return node.children.map((c) => {
        if (c.dir) {
          const open = state.expanded.has(c.path);
          return `<div class="tree-item dir" data-path="${esc(c.path)}"><span class="twisty">${open ? '▾' : '▸'}</span><span class="label">📁 ${esc(c.name)}</span></div>` +
            `<div class="tree-children${open ? '' : ' collapsed'}">${build(c, depth + 1)}</div>`;
        }
        return `<div class="tree-item file" data-path="${esc(c.path)}" title="${esc(c.path)}"><span class="twisty"></span><span class="label">${esc(c.name)}</span></div>`;
      }).join('');
    };
    const panel = $('#panel-files');
    const top = panel.scrollTop;
    box.innerHTML = build(tree, 0);
    panel.scrollTop = top; // 刷新后保持滚动位置
    markTreeCurrent();
  }

  function markTreeCurrent() {
    $$('.tree-item.file').forEach((el) => el.classList.toggle('current', el.dataset.path === state.filePath));
  }

  /* ======================= 侧边栏 ======================= */

  function setSidebarTab(tab) {
    // 插件面板尚未加载（或插件已停用）时退回到大纲
    if (!$(`.side-tab[data-tab="${CSS.escape(tab)}"]`)) tab = 'outline';
    $$('.side-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.side-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + tab));
    const hook = panelHooks.get(tab);
    if (hook) { try { hook(); } catch (e) { console.warn('[插件] 面板 onShow 出错', e); } }
  }

  function bindSidebar() {
    $$('.side-tab').forEach((b) => { b.onclick = () => setSetting({ sidebarTab: b.dataset.tab }); });
    $('#outline').addEventListener('click', (e) => {
      const it = e.target.closest('.outline-item');
      if (it) scrollToHeading(it.dataset.id, Number(it.dataset.line));
    });
    $('#file-tree').addEventListener('click', (e) => {
      const it = e.target.closest('.tree-item');
      if (!it) return;
      if (it.classList.contains('dir')) {
        const p = it.dataset.path;
        const kids = it.nextElementSibling;
        const open = kids.classList.toggle('collapsed') === false;
        if (open) state.expanded.add(p); else state.expanded.delete(p);
        $('.twisty', it).textContent = open ? '▾' : '▸';
      } else openPath(it.dataset.path);
    });
    $('#btn-open-folder').onclick = () => runCommand('file.openFolder');
    $('#btn-refresh').onclick = () => { if (state.folder) loadFolder(state.folder); };
    $('#btn-new-file').onclick = async () => {
      if (!state.folder) { toast('请先打开一个文件夹'); return; }
      const id = await api.invoke('menu:popup', [{ id: 'file', label: '新建文件…' }, { id: 'folder', label: '新建文件夹…' }]);
      if (id === 'file') ws.newFileIn(state.folder);
      else if (id === 'folder') ws.newFolderIn(state.folder);
    };
    const rz = $('#resizer');
    rz.addEventListener('mousedown', (e) => {
      e.preventDefault();
      rz.classList.add('dragging');
      // 侧边栏在右侧时，宽度从窗口右边缘算起
      const widthAt = (x) => Math.round(Math.max(160, Math.min(window.innerWidth * 0.5, state.settings.sidebarPosition === 'right' ? window.innerWidth - x : x)));
      const move = (ev) => document.documentElement.style.setProperty('--sidebar-width', widthAt(ev.clientX) + 'px');
      const up = (ev) => {
        rz.classList.remove('dragging');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        setSetting({ sidebarWidth: widthAt(ev.clientX) });
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    $('#content').addEventListener('scroll', () => { requestAnimationFrame(syncOutlineActive); rememberScroll(); }, { passive: true });
    $('#content').addEventListener('click', (e) => { if (e.target === $('#content')) editor.activateNearest(e.clientY); });
  }

  /* ======================= 源代码模式 ======================= */

  /** 定位到文档中的一段文字（搜索结果等）：index 为全文偏移量 */
  function revealAt(index, length) {
    if (state.sourceMode) {
      source.ta.focus();
      source.ta.setSelectionRange(index, index + length);
      source.setFindRange([index, index + length]);
      scrollSourceToCaret(true);
    } else editor.revealMatch(index, length);
  }

  /** 正在编辑的文件被改名 / 移动：跟随到新路径 */
  function relocate(p) {
    state.filePath = p;
    state.baseDir = dirname(p);
    if (!state.sourceMode) editor.setBaseDir(state.baseDir);
    api.invoke('app:addRecent', p);
    rememberLastFile(p);
    lastTitle = '';
    updateTitle();
    markTreeCurrent();
  }

  /** 正在编辑的文件被删除：内容保留为尚未保存的新文档 */
  function detach() {
    state.displayName = docName();
    state.filePath = null;
    state.mtime = null;
    state.savedText = null;
    lastTitle = '';
    updateTitle();
    markTreeCurrent();
  }

  function scrollSourceToCaret(center) {
    const sc = $('#source');
    const c = source.caretRect();
    const box = sc.getBoundingClientRect();
    if (center || state.settings.typewriter) { sc.scrollTop += c.top - (box.top + box.height * 0.45); return; }
    if (c.top < box.top + 40) sc.scrollTop -= box.top + 40 - c.top;
    else if (c.bottom > box.bottom - 50) sc.scrollTop += c.bottom - (box.bottom - 50);
  }

  function toggleSource() {
    if (!state.sourceMode) {
      const line = editor.caretLine();
      const caretInBlock = editor.isEditing() ? editor.hl.ta.selectionStart : 0;
      const activeStart = editor.isEditing() ? editor.active.start : 0;
      editor.commit();
      const text = editor.getMarkdown();
      state.sourceMode = true;
      $('#content').hidden = true;
      $('#source').hidden = false;
      source.value = text;
      const off = line >= 0 ? offsetOfLine(text, activeStart) + caretInBlock : 0;
      source.focus(Math.min(off, text.length));
      scrollSourceToCaret(true);
    } else {
      const text = source.value;
      const pos = source.ta.selectionStart;
      state.sourceMode = false;
      $('#source').hidden = true;
      $('#content').hidden = false;
      editor.loadFromSource(text);
      const line = lineOfOffset(text, pos);
      const b = editor.blocks.find((x) => line >= x.start && line < x.end);
      if (b) editor.activateRange(b.start, b.end, pos - offsetOfLine(text, b.start), undefined, { center: true });
      else if (!text.trim()) editor.activateRange(0, 1, 0);
    }
    $('#sb-source').classList.toggle('on', state.sourceMode);
    if (!$('#findbar').hidden) runFind(true, true);
    refreshDerived();
  }

  function sourceWrap(left, right, placeholder) {
    const ta = source.ta;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const sel = ta.value.slice(s, e) || placeholder || '';
    ta.focus();
    ta.setSelectionRange(s, e);
    document.execCommand('insertText', false, left + sel + right);
    ta.setSelectionRange(s + left.length, s + left.length + sel.length);
  }

  /* ======================= 查找替换 ======================= */

  // lastDocEdit / lastInputEdit：替换操作与查找框输入的时间，用于决定查找框中 Ctrl+Z 撤销哪一个
  const find = { matches: [], cur: -1, caseSensitive: false, regex: false, lastDocEdit: 0, lastInputEdit: 0 };

  function buildRegex(global) {
    const q = $('#find-input').value;
    if (!q) return null;
    try {
      return new RegExp(find.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), (find.caseSensitive ? '' : 'i') + (global ? 'g' : ''));
    } catch (e) { return null; }
  }

  function findIn(text) {
    const re = buildRegex(true);
    const out = [];
    if (!re) return out;
    let m;
    while ((m = re.exec(text)) && out.length < 5000) {
      if (!m[0].length) { re.lastIndex++; continue; }
      out.push({ index: m.index, length: m[0].length });
    }
    return out;
  }

  function highlightRendered() {
    if (!window.CSS || !CSS.highlights) return;
    CSS.highlights.delete('zmark-find');
    if ($('#findbar').hidden || state.sourceMode) return;
    const re = buildRegex(true);
    if (!re) return;
    const ranges = [];
    const walker = document.createTreeWalker($('#write'), NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (editor.editorEl.contains(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n;
    while ((n = walker.nextNode()) && ranges.length < 3000) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(n.data))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const r = new Range();
        r.setStart(n, m.index);
        r.setEnd(n, m.index + m[0].length);
        ranges.push(r);
      }
    }
    CSS.highlights.set('zmark-find', new Highlight(...ranges));
  }

  function updateFindCount() {
    const n = find.matches.length;
    $('#find-count').textContent = $('#find-input').value ? (n ? `${find.cur + 1}/${n}` : '无结果') : '';
  }

  function runFind(keepPos, noReveal) {
    if (!state.sourceMode) editor.dropEmptyActive();
    const text = getText();
    const prev = find.matches[find.cur];
    find.matches = findIn(text);
    if (!find.matches.length) find.cur = -1;
    else if (keepPos && prev) {
      const i = find.matches.findIndex((m) => m.index >= prev.index);
      find.cur = i < 0 ? 0 : i;
    } else {
      let caret = 0;
      if (state.sourceMode) caret = source.ta.selectionStart;
      else if (editor.isEditing()) caret = editor.prefix.length;
      const i = find.matches.findIndex((m) => m.index >= caret);
      find.cur = i < 0 ? 0 : i;
    }
    if (!noReveal && find.cur >= 0) revealMatch();
    else highlightRendered();
    updateFindCount();
  }

  function revealMatch() {
    const m = find.matches[find.cur];
    if (!m) return;
    if (state.sourceMode) {
      source.ta.setSelectionRange(m.index, m.index + m.length);
      source.setFindRange([m.index, m.index + m.length]);
      scrollSourceToCaret(true);
    } else {
      editor.revealMatch(m.index, m.length);
    }
    highlightRendered();
    updateFindCount();
  }

  function findStep(dir) {
    if ($('#findbar').hidden) { openFind(false); return; }
    if (!find.matches.length) { runFind(false); return; }
    find.cur = (find.cur + dir + find.matches.length) % find.matches.length;
    revealMatch();
  }

  function openFind(withReplace) {
    const bar = $('#findbar');
    bar.hidden = false;
    $('#replace-row').hidden = !withReplace && $('#replace-row').hidden;
    if (withReplace) $('#replace-row').hidden = false;
    let sel = '';
    if (state.sourceMode) sel = source.ta.value.slice(source.ta.selectionStart, source.ta.selectionEnd);
    else sel = editor.getSelectedText();
    if (sel && !sel.includes('\n')) $('#find-input').value = sel;
    const input = withReplace && $('#find-input').value ? $('#replace-input') : $('#find-input');
    input.focus();
    input.select();
    runFind(false);
  }

  function closeFind() {
    $('#findbar').hidden = true;
    if (window.CSS && CSS.highlights) CSS.highlights.delete('zmark-find');
    source.setFindRange(null);
    if (editor.isEditing()) editor.focusEditor();
    else if (state.sourceMode) source.focus();
  }

  function replacementFor(m) {
    const rep = $('#replace-input').value;
    if (!find.regex) return rep;
    const re = buildRegex(false);
    return getText().slice(m.index, m.index + m.length).replace(re, rep);
  }

  function replaceOne() {
    const m = find.matches[find.cur];
    if (!m) { runFind(false); return; }
    const rep = replacementFor(m);
    if (state.sourceMode) sourceReplace(m.index, m.index + m.length, rep);
    else editor.replaceRange(m.index, m.length, rep);
    find.lastDocEdit = Date.now();
    const at = m.index + rep.length;
    find.matches = findIn(getText());
    const i = find.matches.findIndex((x) => x.index >= at);
    find.cur = find.matches.length ? (i < 0 ? 0 : i) : -1;
    if (find.cur >= 0) revealMatch(); else { highlightRendered(); updateFindCount(); }
  }

  function replaceAll() {
    const re = buildRegex(true);
    if (!re) return;
    const text = getText();
    const n = findIn(text).length;
    if (!n) { toast('没有可替换的内容'); return; }
    const rep = $('#replace-input').value;
    const out = text.replace(re, find.regex ? rep : () => rep);
    if (state.sourceMode) sourceReplace(0, text.length, out);
    else editor.replaceAllText(out);
    find.lastDocEdit = Date.now();
    toast(`已替换 ${n} 处`);
    runFind(false, true);
  }

  /** 源代码模式下替换一段文本：通过 execCommand 进行，保留浏览器的撤销历史；完成后焦点回到原处 */
  function sourceReplace(a, b, text) {
    const back = document.activeElement;
    source.ta.focus();
    source.ta.setSelectionRange(a, b);
    document.execCommand(text ? 'insertText' : 'delete', false, text);
    if (back && back !== source.ta && back.focus) back.focus();
  }

  function bindFind() {
    const input = $('#find-input');
    input.addEventListener('input', () => { find.lastInputEdit = Date.now(); runFind(false); });
    $('#replace-input').addEventListener('input', () => { find.lastInputEdit = Date.now(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    $('#replace-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (e.ctrlKey) replaceAll(); else replaceOne(); }
      if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    $('#find-prev').onclick = () => findStep(-1);
    $('#find-next').onclick = () => findStep(1);
    $('#find-close').onclick = closeFind;
    $('#find-toggle-replace').onclick = () => { $('#replace-row').hidden = !$('#replace-row').hidden; };
    $('#replace-one').onclick = replaceOne;
    $('#replace-all').onclick = replaceAll;
    $('#find-case').onclick = (e) => { find.caseSensitive = !find.caseSensitive; e.currentTarget.classList.toggle('on', find.caseSensitive); runFind(false); };
    $('#find-regex').onclick = (e) => { find.regex = !find.regex; e.currentTarget.classList.toggle('on', find.regex); runFind(false); };
  }

  /* ======================= 设置 ======================= */

  function setSetting(patch) {
    Object.assign(state.settings, patch);
    api.invoke('settings:set', patch);
    applySettings(patch);
  }

  const FONT_STACKS = {
    sans: '-apple-system, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
    serif: 'Georgia, "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
    kai: 'KaiTi, STKaiti, "楷体", "Kaiti SC", serif',
    mono: '"Cascadia Code", Consolas, "Sarasa Mono SC", "Microsoft YaHei Mono", monospace',
  };
  const PARA_SPACING = { compact: '0.3em', normal: '0.6em', loose: '1.1em' };
  // 设置项 → <body> 上的类名（样式在 markdown.css / app.css 中，导出时同样生效）
  const BODY_CLASSES = { firstLineIndent: 'first-line-indent', headingNumbering: 'heading-numbering', codeWrap: 'code-wrap', mathNumbering: 'math-numbering' };
  const MD_KEYS = ['breaks', 'linkify', 'typographer', 'mathSyntax', 'markSyntax', 'supSubSyntax', 'mermaid', 'codeLineNumbers'];
  const EDITOR_KEYS = ['richMode', 'strongMarker', 'emMarker', 'enterMode', 'autoPair', 'wrapSelection', 'livePreview', 'tabSize', 'insertSpaces', 'listMarker'];
  const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

  const cssFontList = (f) => String(f || '').replace(/[;{}<>]/g, '').trim();
  /** 导入的字体文件（font:<家族名>）是否仍存在 */
  const importedFont = (v) => (/^font:/.test(v || '') ? (state.fonts || []).find((f) => f.family === v.slice(5)) : null);

  /** 正文字体（空字符串表示使用主题字体） */
  function bodyFont(s) {
    if (s.fontFamily === 'custom') {
      const f = cssFontList(s.customFont);
      return f ? `${f}, ${FONT_STACKS.sans}` : '';
    }
    const imp = importedFont(s.fontFamily);
    if (imp) return `"${imp.family}", ${FONT_STACKS.sans}`;
    return FONT_STACKS[s.fontFamily] || '';
  }

  /** 代码字体（空字符串表示使用主题的等宽字体） */
  function codeFont(s) {
    if (s.codeFont === 'custom') {
      const f = cssFontList(s.customCodeFont);
      return f ? `${f}, ${FONT_STACKS.mono}` : '';
    }
    const imp = importedFont(s.codeFont);
    return imp ? `"${imp.family}", ${FONT_STACKS.mono}` : '';
  }

  /** 文档中实际使用到的导入字体（导出时需要一并写入 @font-face） */
  const usedFonts = (s) => [importedFont(s.fontFamily), importedFont(s.codeFont)].filter(Boolean);

  // 个性化（背景图片、强调色、自定义 CSS）相关的设置项
  const THEME_KEYS = ['theme', 'bgImage', 'bgFit', 'bgOpacityAuto', 'bgOverlay', 'bgBlur', 'bgPanels', 'accentColor', 'customCss'];
  let themeSeq = 0;
  async function applyTheme() {
    const seq = ++themeSeq;
    const info = await ZTheme.apply(state.settings, api, DARK.has(state.settings.theme)).catch((e) => { console.warn('应用主题失败', e); return null; });
    if (seq !== themeSeq || !info) return;
    state.themeInfo = info;
    const out = $('.prefs [data-v=bgAuto]');
    if (out) out.textContent = info.overlay === null ? '—' : `当前 ${Math.round(info.overlay * 100)}%`;
    const sw = $('.prefs .accent-from-image');
    if (sw) { sw.style.background = info.imageAccent || 'transparent'; sw.title = info.imageAccent || '未设置背景图片'; }
  }

  /** 重新读取导入的字体文件并注册 */
  async function refreshFonts() {
    state.fonts = await api.invoke('font:list').catch(() => []);
    ZTheme.registerFonts(state.fonts);
    applySettings({ fontFamily: state.settings.fontFamily, codeFont: state.settings.codeFont });
  }

  function mdOptionsOf(s) {
    return { breaks: s.breaks, linkify: s.linkify, typographer: s.typographer, math: s.mathSyntax, mark: s.markSyntax, supSub: s.supSubSyntax, mermaid: s.mermaid, lineNumbers: s.codeLineNumbers };
  }

  function applySettings(patch) {
    const s = state.settings;
    const all = !patch;
    const has = (k) => all || k in patch;
    const root = document.documentElement.style;
    if (has('fontFamily') || has('customFont')) {
      // 只作用于文档区域，不影响侧边栏、状态栏等界面文字
      let el = $('#user-font');
      if (!el) { el = document.createElement('style'); el.id = 'user-font'; document.head.appendChild(el); }
      const f = bodyFont(s);
      el.textContent = f ? `.markdown-body { --font-body: ${f}; --font-heading: ${f}; }` : '';
    }
    if (has('codeFont') || has('customCodeFont')) {
      let el = $('#user-code-font');
      if (!el) { el = document.createElement('style'); el.id = 'user-code-font'; document.head.appendChild(el); }
      const f = codeFont(s);
      el.textContent = f ? `.markdown-body, #source { --font-mono: ${f}; }` : '';
    }
    if (has('paragraphSpacing')) root.setProperty('--para-spacing', PARA_SPACING[s.paragraphSpacing] || PARA_SPACING.normal);
    for (const [k, cls] of Object.entries(BODY_CLASSES)) if (has(k)) document.body.classList.toggle(cls, !!s[k]);
    if (has('richMode')) $('#sb-rich').classList.toggle('on', !!s.richMode);
    if (has('showStatusBar')) document.body.classList.toggle('no-statusbar', !s.showStatusBar);
    if (has('showWordCount')) $('#sb-count').hidden = !s.showWordCount;
    if (has('sidebarPosition')) document.body.classList.toggle('sidebar-right', s.sidebarPosition === 'right');
    if (has('tabSize')) root.setProperty('--tab-size', s.tabSize);
    if (editor && !all && MD_KEYS.some(has)) editor.setOptions({ md: mdOptionsOf(s) });
    if (editor && EDITOR_KEYS.some(has)) editor.setOptions(pick(s, EDITOR_KEYS));
    if (has('theme')) {
      document.body.dataset.theme = s.theme;
      const dark = DARK.has(s.theme);
      const mm = $('#moyu-mode');
      if (mm) { mm.title = dark ? '切换到日间' : '切换到夜间'; mm.setAttribute('aria-pressed', String(s.theme === 'moyu-night')); }
      $('#hljs-light').disabled = dark;
      $('#hljs-dark').disabled = !dark;
      ZMD.setMermaidTheme(dark);
      bus.emit('theme', { name: s.theme, dark });
      if (editor && !all) editor.rerender();
    }
    if (has('fontSize')) root.setProperty('--font-size', s.fontSize + 'px');
    if (has('lineHeight')) root.setProperty('--line-height', s.lineHeight);
    if (has('contentWidth')) root.setProperty('--content-width', s.contentWidth >= 2000 ? '100%' : s.contentWidth + 'px');
    if (has('sidebarWidth')) root.setProperty('--sidebar-width', s.sidebarWidth + 'px');
    if (has('sidebar')) { document.body.classList.toggle('no-sidebar', !s.sidebar); $('#sb-sidebar').classList.toggle('on', s.sidebar); }
    if (has('sidebarTab')) setSidebarTab(s.sidebarTab);
    if (has('focusMode')) { document.body.classList.toggle('focus-mode', s.focusMode); $('#sb-focus').classList.toggle('on', s.focusMode); }
    if (has('typewriter')) { $('#sb-typewriter').classList.toggle('on', s.typewriter); if (editor) editor.setOptions({ typewriter: s.typewriter }); }
    if (editor && has('spellcheck')) { editor.setOptions({ spellcheck: s.spellcheck }); source.ta.spellcheck = !!s.spellcheck; }
    if (has('autoSave') && !all) { updateTitle(); autoSave(); }
    if (THEME_KEYS.some(has)) applyTheme();
  }

  const PREF_SECTIONS = [['general', '通用'], ['appearance', '外观'], ['theme', '主题与背景'], ['editor', '编辑器'], ['markdown', 'Markdown'], ['image', '图像'], ['export', '导出'], ['plugins', '插件']];

  function openPreferences(section) {
    const s = state.settings;
    const options = (k, list) => list.map(([v, l]) => `<option value="${esc(String(v))}"${String(s[k]) === String(v) ? ' selected' : ''}>${l}</option>`).join('');
    const select = (k, list, extra) => `<select data-k="${k}"${extra || ''}>${options(k, list)}</select>`;
    const num = (k, list) => select(k, list, ' data-num');
    const check = (k) => `<input type="checkbox" data-k="${k}"${s[k] ? ' checked' : ''}>`;
    const text = (k, placeholder, cls) => `<input type="text" data-k="${k}"${cls ? ` class="${cls}"` : ''} value="${esc(s[k] || '')}" placeholder="${esc(placeholder || '')}">`;
    const range = (k, min, max, step, unit) => `<span class="pref-range"><input type="range" min="${min}" max="${max}" step="${step}" data-k="${k}" data-num value="${s[k]}"><output data-v="${k}">${s[k]}</output>${unit || ''}</span>`;
    /** 一行设置：标签、说明、控件；cond 为显示条件（见 sync） */
    const row = (label, desc, control, cond) =>
      `<div class="row"${cond ? ` data-if="${cond}"` : ''}><label>${label}${desc ? `<small>${desc}</small>` : ''}</label>${control}</div>`;
    const chk = (k, label, tip) => `<label class="pref-check"><input type="checkbox" data-k="${k}"${s[k] ? ' checked' : ''}><span>${label}</span>${tip ? `<span class="pref-tip" title="${esc(tip)}">?</span>` : ''}</label>`;
    const themes = [['github', 'GitHub'], ['newsprint', 'Newsprint 报刊'], ['night', 'Night 夜间'], ['midnight', 'Midnight 午夜蓝'], ['moyu', '墨羽蓝调']];
    // 导出主题需要确定的明暗，因此分开列出
    const exportThemes = themes.slice(0, 4).concat([['moyu', '墨羽蓝调 · 日间'], ['moyu-night', '墨羽蓝调 · 夜间']]);
    const actions = [
      ['none', '无特殊操作'],
      ['copyToCurrent', '复制图片到当前文件夹 (./)'],
      ['copyToAssets', `复制图片到 ./${esc(s.imageFolder || 'assets')} 文件夹`],
      ['copyToCustom', '复制到指定路径'],
      ['upload', '上传图片'],
    ];
    const services = [['picgo-app', 'PicGo (app)'], ['picgo-core', 'PicGo-Core (command line)'], ['custom', '自定义命令']];
    const fontOpts = (state.fonts || []).map((f) => ['font:' + f.family, `导入：${esc(f.name)}`]);

    showModal(`
      <div class="prefs-nav">
        <h3>偏好设置</h3>
        ${PREF_SECTIONS.map(([id, label]) => `<button data-sec="${id}">${label}</button>`).join('')}
        <button class="prefs-reset" data-act="reset" title="把所有设置恢复为默认值（保留最近文件与插件启用状态）">恢复默认设置</button>
      </div>
      <div class="prefs-body">
        <section data-pane="general">
          <h2>通用</h2>
          <h4 class="pref-h">启动</h4>
          ${row('启动时显示开启动画', '启动 Moyu 时显示带图标的开启动画（约 1 秒，不影响加载速度）', check('showSplash'))}
          ${row('启动时', '', select('startupAction', [['new', '打开空白文档'], ['restoreLast', '重新打开上次的文件（含所有标签页）'], ['welcome', '打开欢迎文档']]))}
          ${row('在标签页中打开文档', '打开文件时保留已经打开的文档，可用 Ctrl+Tab 切换；关闭后每个窗口只编辑一个文档', check('tabs'))}
          ${row('记住阅读位置', '重新打开文件时回到上次滚动到的位置', check('restoreScroll'))}
          ${row('最近文件数量', '「文件 → 最近打开」中保留的文件数', num('recentLimit', [[5, '5'], [10, '10'], [15, '15'], [20, '20'], [30, '30']]))}
          <h4 class="pref-h">保存</h4>
          ${row('自动保存', '已保存过的文件在停止输入后自动保存', check('autoSave'))}
          ${row('自动保存延迟', '停止输入多久后保存', num('autoSaveDelay', [[1, '1 秒'], [2, '2 秒'], [5, '5 秒'], [10, '10 秒'], [30, '30 秒']]), 'autoSave')}
          ${row('切换到其他窗口时自动保存', '窗口失去焦点时保存已保存过的文件', check('saveOnBlur'))}
          ${row('文件被其他程序修改时', '', select('externalChange', [['auto', '自动重新加载（有未保存修改时询问）'], ['ask', '总是询问'], ['ignore', '不检测']]))}
          <h4 class="pref-h">文件格式</h4>
          ${row('新建文件的换行符', '打开的已有文件保持其原有换行符', select('defaultEol', [['LF', 'LF（\\n，macOS / Linux）'], ['CRLF', 'CRLF（\\r\\n，Windows）']]))}
          ${row('保存时确保文件以换行结尾', '', check('insertFinalNewline'))}
          ${row('保存时删除行尾多余空格', '保留用于强制换行的两个空格；代码块内不处理', check('trimTrailingWhitespace'))}
          <h4 class="pref-h">历史版本</h4>
          ${row('保存时保留历史版本', '每次保存在本机留一份快照（5 分钟内的多次保存合并），可在「文件 → 历史版本」中对比与恢复', check('historyEnabled'))}
          ${row('每个文件最多保留', '', num('historyMax', [[20, '20 个'], [50, '50 个'], [100, '100 个'], [200, '200 个']]), 'historyEnabled')}
          <h4 class="pref-h">更新</h4>
          ${row(`当前版本 ${esc(state.info.version || '')}`, '从 GitHub 发布页获取新版本，下载后校验文件完整性', '<button class="text-btn" data-act="check-update">检查更新</button>')}
          ${row('启动时自动检查更新', '每次启动时检查，状态显示在状态栏；发现新版本时弹窗，可选择立即更新、跳过此版本或取消', check('autoCheckUpdate'))}
          ${row('下载加速地址（可选）', '下载缓慢时可填写 GitHub 加速服务的前缀，下载地址会拼接在其后；留空则直接下载', text('updateMirror', '例如 https://example.com/'))}
        </section>

        <section data-pane="appearance">
          <h2>外观</h2>
          <h4 class="pref-h">主题与字体</h4>
          ${row('主题', '墨羽蓝调可用窗口右下角的按钮切换日间 / 夜间', `<select data-k="theme">${themes.map(([v, l]) => `<option value="${v}"${s.theme === v || (v === 'moyu' && s.theme === 'moyu-night') ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}
          ${row('正文字体', '', select('fontFamily', [['default', '跟随主题'], ['sans', '无衬线（微软雅黑）'], ['serif', '衬线（宋体）'], ['kai', '楷体'], ['mono', '等宽']].concat(fontOpts, [['custom', '系统中的其他字体…']])))}
          ${row('系统字体名称', '输入已安装的字体名称（可从下拉建议中选择），多个用逗号分隔', text('customFont', '例如 "LXGW WenKai", 霞鹜文楷', 'font-input') + '<datalist id="system-fonts"></datalist>', 'fontFamily=custom')}
          ${row('代码字体', '代码块、行内代码与源代码模式', select('codeFont', [['default', '跟随主题']].concat(fontOpts, [['custom', '系统中的其他字体…']])))}
          ${row('代码字体名称', '', text('customCodeFont', '例如 "JetBrains Mono", Consolas', 'font-input'), 'codeFont=custom')}
          <div class="row font-manage"><label>导入的字体<small>支持 TTF / OTF / TTC / WOFF / WOFF2；导入后出现在上面的字体列表中</small></label><button class="text-btn" data-act="import-font">导入字体文件…</button></div>
          <div class="font-list"></div>
          ${row('字号', '', range('fontSize', 12, 24, 1, ' px'))}
          ${row('行高', '', range('lineHeight', 1.3, 2.2, 0.05, ''))}
          <h4 class="pref-h">排版</h4>
          ${row('段落间距', '', select('paragraphSpacing', [['compact', '紧凑'], ['normal', '标准'], ['loose', '宽松']]))}
          ${row('版心宽度', '', num('contentWidth', [[720, '窄 (720px)'], [860, '标准 (860px)'], [1080, '宽 (1080px)'], [2000, '铺满窗口']]))}
          ${row('段落首行缩进两字', '适合中文写作习惯；导出时保留', check('firstLineIndent'))}
          ${row('标题自动编号', '为二～四级标题添加 1. / 1.1 / 1.1.1 编号；导出时保留', check('headingNumbering'))}
          <h4 class="pref-h">界面</h4>
          ${row('显示状态栏', '', check('showStatusBar'))}
          ${row('状态栏显示字数统计', '', check('showWordCount'), 'showStatusBar')}
          ${row('侧边栏位置', '', select('sidebarPosition', [['left', '左侧'], ['right', '右侧']]))}
        </section>

        <section data-pane="theme">
          <h2>主题与背景</h2>
          <h4 class="pref-h">背景图片</h4>
          <div class="bg-picker">
            <div class="bg-thumb"${s.bgImage ? '' : ' data-empty'}><span>未设置背景图片</span></div>
            <div class="bg-actions">
              <button class="text-btn" data-act="pick-bg">选择图片…</button>
              <button class="text-btn" data-act="clear-bg" data-if="bgImage">移除背景</button>
              <small>图片会复制到 Moyu 的数据目录，原图移动或删除不受影响</small>
            </div>
          </div>
          ${row('填充方式', '', select('bgFit', [['cover', '铺满（裁切）'], ['contain', '完整显示'], ['tile', '平铺']]), 'bgImage')}
          ${row('自动调整透明度', '根据图片亮度与复杂度计算遮罩浓度，保证文字清晰；切换主题时自动重新计算 · <span data-v="bgAuto">—</span>', check('bgOpacityAuto'), 'bgImage')}
          ${row('遮罩浓度', '越大图片越淡、文字越清晰', range('bgOverlay', 0, 1, 0.05, ''), 'bgOpacityAuto!=true')}
          ${row('背景模糊', '', range('bgBlur', 0, 20, 1, ' px'), 'bgImage')}
          ${row('侧边栏与状态栏半透明', '让背景图片透过界面边栏', check('bgPanels'), 'bgImage')}
          <h4 class="pref-h">强调色</h4>
          ${row('强调色', '用于链接、选中项、按钮等；会按主题明暗自动调整以保证对比度', select('accentColor', [['', '跟随主题'], ['auto', '取自背景图片'], ['custom', '自定义…']].map((o) => (o[0] === 'custom' && /^#/.test(s.accentColor) ? [s.accentColor, '自定义…'] : o))) + '<span class="accent-from-image" data-if="accentColor=auto"></span>')}
          ${row('自定义颜色', '', `<input type="color" data-act="accent-pick" value="${/^#[0-9a-f]{6}$/i.test(s.accentColor) ? s.accentColor : '#0969da'}">`, 'accentColor!=|auto')}
          <h4 class="pref-h">主题包</h4>
          <div class="row"><label>导入 / 导出<small>主题包（.moyutheme）包含主题、背景图片、强调色、字体与排版设置、自定义 CSS，可分享给他人；也可直接导入 CSS 文件或图片</small></label>
            <span class="pref-buttons"><button class="text-btn" data-act="import-theme">导入…</button><button class="text-btn" data-act="export-theme">导出当前主题…</button></span></div>
          <h4 class="pref-h">自定义 CSS</h4>
          <p class="pref-note">追加到界面与导出文件中的样式，例如 <code>.markdown-body h1 { color: #c0392b; }</code>。可使用主题变量 --bg、--text、--accent 等。</p>
          <textarea class="css-editor" data-k="customCss" spellcheck="false" placeholder="/* 在这里书写 CSS */">${esc(s.customCss || '')}</textarea>
        </section>

        <section data-pane="editor">
          <h2>编辑器</h2>
          <h4 class="pref-h">输入</h4>
          ${row('纯文本模式', '编辑时直接在排版结果上修改，不显示 Markdown 源码（公式块、图表、HTML 等代码类内容除外）；可用 F7 切换', check('richMode'))}
          ${row('斜杠命令', '在空段落中输入 / 弹出菜单，快速插入标题、列表、表格、代码块、图表等', check('slashCommands'))}
          ${row('回车键', '列表、引用、表格、代码块中的智能回车不受影响', select('enterMode', [['paragraph', 'Enter 新段落，Shift+Enter 换行'], ['newline', 'Enter 换行，Shift+Enter 新段落']]))}
          ${row('自动配对括号和引号', '输入 ( [ { " \' ` 以及（【「《“ 时自动补全另一半', check('autoPair'))}
          ${row('选中文字后输入符号自动包裹', '选中文字后输入 * _ ~ = $ ` ( [ " 等，在两侧加上符号', check('wrapSelection'))}
          ${row('智能粘贴', '从网页、Word、Excel 复制的内容自动转为 Markdown（标题、列表、表格、链接等）；在选中的文字上粘贴网址生成链接。Ctrl+Shift+V 始终粘贴为纯文本', check('smartPaste'))}
          ${row('编辑时实时预览', '编辑公式、图表、表格、图片时在下方显示渲染效果', check('livePreview'))}
          ${row('拼写检查（英文）', '', check('spellcheck'))}
          <h4 class="pref-h">缩进</h4>
          ${row('Tab 宽度', '用于代码块与源代码模式', num('tabSize', [[2, '2'], [4, '4'], [8, '8']]))}
          ${row('用空格代替 Tab', '关闭后按 Tab 插入制表符', check('insertSpaces'))}
        </section>

        <section data-pane="markdown">
          <h2>Markdown</h2>
          <h4 class="pref-h">语法</h4>
          ${row('单个换行显示为换行', '关闭后遵循 CommonMark：单个换行渲染为空格', check('breaks'))}
          ${row('自动识别网址为链接', '', check('linkify'))}
          ${row('智能标点', '直引号转为弯引号 “ ”，(c) 转为 ©，-- 转为 –', check('typographer'))}
          ${row('LaTeX 数学公式', '$行内公式$ 与 $$公式块$$', check('mathSyntax'))}
          ${row('高亮 ==文本==', '', check('markSyntax'))}
          ${row('上标 ^文本^ 与下标 ~文本~', '例如 x^2^、H~2~O', check('supSubSyntax'))}
          ${row('Mermaid 图表', '```mermaid 代码块渲染为流程图、时序图等', check('mermaid'))}
          <h4 class="pref-h">代码块与公式</h4>
          ${row('代码块显示行号', '', check('codeLineNumbers'))}
          ${row('代码块自动换行', '长行折行显示，不出现横向滚动条', check('codeWrap'))}
          ${row('公式块自动编号', '在公式块右侧显示 (1)、(2)…', check('mathNumbering'))}
          <h4 class="pref-h">书写风格</h4>
          <p class="pref-note">使用菜单或快捷键插入格式时采用的符号。</p>
          ${row('无序列表符号', '', select('listMarker', [['-', '-  减号'], ['*', '*  星号'], ['+', '+  加号']]))}
          ${row('加粗符号', '', select('strongMarker', [['**', '**加粗**'], ['__', '__加粗__']]))}
          ${row('斜体符号', '', select('emMarker', [['*', '*斜体*'], ['_', '_斜体_']]))}
        </section>

        <section data-pane="image">
          <h2>图像</h2>
          <div class="pref-group">
            <div class="pref-title">插入图片时… <a href="#" data-help="insert">了解更多…</a></div>
            <div class="pref-ctrl">
              <select data-k="imageInsertAction" class="wide">${options('imageInsertAction', actions)}</select>
              <div class="pref-sub" data-if="imageInsertAction=copyToCustom"><input type="text" data-k="imageCustomPath" class="wide" value="${esc(s.imageCustomPath)}" placeholder="./\${filename}.assets"><small>支持 \${filename}（当前文档名）；相对路径基于文档所在目录</small></div>
              <div class="pref-sub" data-if="imageInsertAction=copyToAssets"><label class="pref-inline">文件夹名 <input type="text" data-k="imageFolder" value="${esc(s.imageFolder)}"></label></div>
              ${chk('imageApplyLocal', '对本地位置的图片应用上述规则')}
              ${chk('imageApplyNetwork', '对网络位置的图片应用上述规则')}
              ${chk('imageYamlUpload', '允许根据 YAML 设置自动上传图片', '文档 Front Matter 中写入 typora-copy-images-to: upload 时自动上传')}
            </div>
          </div>
          <div class="pref-group">
            <div class="pref-title">图片语法偏好 <a href="#" data-help="syntax">了解更多…</a></div>
            <div class="pref-ctrl">
              ${chk('imagePreferRelative', '优先使用相对路径')}
              ${chk('imageAddDotSlash', '为相对路径添加 ./', '例如 ./assets/a.png 而不是 assets/a.png')}
              ${chk('imageEscapeUrl', '插入时自动转义图片 URL', '对路径中的空格、中文等字符做 URL 编码')}
            </div>
          </div>
          <div class="pref-group">
            <div class="pref-title">上传服务设定 <a href="#" data-help="upload">了解更多…</a></div>
            <div class="pref-ctrl">
              <div class="pref-field"><span>上传服务</span><select data-k="uploadService">${options('uploadService', services)}</select></div>
              <div class="pref-field" data-if="uploadService=picgo-app"><span>PicGo 路径</span><span class="pref-path"><input type="text" data-k="picgoPath" value="${esc(s.picgoPath)}" placeholder="例如 D:\\PicGo\\PicGo.exe"><button class="icon-btn" data-act="browse" title="选择 PicGo.exe">📁</button></span></div>
              <div class="pref-field" data-if="uploadService=picgo-app"><span>PicGo Server</span><input type="text" data-k="picgoServer" value="${esc(s.picgoServer)}"></div>
              <div class="pref-field" data-if="uploadService=picgo-core"><span>PicGo-Core 命令</span><input type="text" data-k="picgoCoreCommand" value="${esc(s.picgoCoreCommand)}" placeholder="picgo"></div>
              <div class="pref-field" data-if="uploadService=custom"><span>自定义命令</span><input type="text" data-k="customUploadCommand" value="${esc(s.customUploadCommand)}" placeholder="例如 node D:\\tools\\upload.js"></div>
              <div class="pref-buttons">
                <button class="text-btn" data-act="test">验证图片上传选项</button>
                <button class="text-btn" data-act="download" data-if="uploadService=picgo-app|picgo-core">下载 PicGo</button>
                <a href="#" data-help="upload">说明</a>
              </div>
              <div class="pref-result" hidden></div>
            </div>
          </div>
        </section>

        <section data-pane="export">
          <h2>导出</h2>
          <h4 class="pref-h">通用</h4>
          ${row('导出使用的主题', '例如在夜间主题下写作，导出为浅色文档', select('exportTheme', [['current', '跟随当前主题']].concat(exportThemes)))}
          ${row('导出完成后打开文件', '用系统默认程序打开导出的文件', check('openAfterExport'))}
          <h4 class="pref-h">HTML</h4>
          ${row('嵌入本地图片', '图片以 Base64 写入 HTML，得到单个可直接分享的文件', check('exportEmbedImages'))}
          <h4 class="pref-h">PDF</h4>
          ${row('纸张大小', '', select('pdfPageSize', [['A3', 'A3'], ['A4', 'A4'], ['A5', 'A5'], ['Letter', 'Letter'], ['Legal', 'Legal']]))}
          ${row('横向页面', '', check('pdfLandscape'))}
          ${row('页边距', '', select('pdfMargin', [['narrow', '窄（约 1 厘米）'], ['normal', '标准（约 1.5 厘米）'], ['wide', '宽（约 2.5 厘米）']]))}
          ${row('页眉页脚', '', select('pdfHeaderFooter', [['none', '无'], ['page', '页脚显示页码'], ['titlePage', '页眉显示标题，页脚显示页码']]))}
          <h4 class="pref-h">图片（PNG 长图）</h4>
          ${row('版面宽度', '手机宽度适合在微信、小红书等处分享；过长的文档会按段落自动分成多张', select('exportImageWidth', [['mobile', '手机（480）'], ['standard', '标准（800）'], ['wide', '宽（1100）']]))}
          ${row('清晰度', '2 倍在高分辨率屏幕和手机上更清晰，文件也更大', num('exportImageScale', [[2, '2 倍（推荐）'], [1, '1 倍']]))}
          <h4 class="pref-h">Word 与其他格式</h4>
          <p class="pref-note">导出 Word（.docx）、ODT、RTF、EPUB、LaTeX 由 <a href="https://pandoc.org/installing.html">Pandoc</a> 完成：公式转为 Word 自带的公式，图片嵌入文件。需要先安装 Pandoc（免费）。</p>
          ${row('Pandoc 的位置', '留空则自动查找（PATH 与默认安装位置）', text('pandocPath', '例如 C:\\Program Files\\Pandoc\\pandoc.exe') + '<span class="pandoc-status" id="pandoc-status"></span>')}
        </section>

        <section data-pane="plugins">
          <h2>插件</h2>
          <p class="pref-note">插件可以扩展 Markdown 语法、添加命令（出现在「插件」菜单）、状态栏与侧边栏面板。
            自己编写的插件放到插件目录中，每个插件一个文件夹（plugin.json + main.js）。插件拥有与编辑器相同的权限，请只安装信任的插件。</p>
          <div class="pref-buttons">
            <button class="text-btn" data-act="plugin-dir">打开插件目录</button>
            <button class="text-btn" data-act="plugin-reload">重新加载插件</button>
            <a href="#" data-act="plugin-guide">插件开发指南</a>
            <button class="text-btn ai-btn" data-act="plugin-ai" title="生成一段完整的提示词，交给 AI 工具即可编写出对应功能的插件">✨ 一键提示词</button>
          </div>
          <div class="plugin-list"></div>
        </section>
      </div>
      <button class="icon-btn prefs-close" data-act="close" title="关闭">✕</button>`,
    (el, close) => {
      el.classList.add('prefs');
      let current = section || 'general';
      const show = (sec) => {
        current = sec;
        $$('[data-sec]', el).forEach((b) => b.classList.toggle('active', b.dataset.sec === sec));
        $$('[data-pane]', el).forEach((p) => { p.hidden = p.dataset.pane !== sec; });
        $('.prefs-body', el).scrollTop = 0;
      };
      /** data-if 显示条件："key"（为真）、"key=a|b"、"key!=a" */
      const cond = (expr) => {
        const m = /^(\w+)(!?=)(.*)$/.exec(expr);
        if (!m) return !!s[expr];
        const hit = m[3].split('|').includes(String(s[m[1]]));
        return m[2] === '=' ? hit : !hit;
      };
      const sync = () => {
        $$('[data-if]', el).forEach((n) => { n.hidden = !cond(n.dataset.if); });
        const dot = $('[data-k=imageAddDotSlash]', el);
        dot.disabled = !s.imagePreferRelative;
        dot.closest('.pref-check').classList.toggle('disabled', dot.disabled);
        $('[data-k=imageInsertAction] option[value=copyToAssets]', el).textContent = `复制图片到 ./${s.imageFolder || 'assets'} 文件夹`;
      };
      $$('[data-sec]', el).forEach((b) => { b.onclick = () => show(b.dataset.sec); });
      $$('[data-k]', el).forEach((inp) => {
        const k = inp.dataset.k;
        const ev = inp.type === 'range' || inp.type === 'text' ? 'input' : 'change';
        inp.addEventListener(ev, () => {
          let v = inp.type === 'checkbox' ? inp.checked : inp.value;
          if ('num' in inp.dataset) v = Number(v);
          if (k === 'theme' && v === 'moyu') { runCommand('theme.moyu'); sync(); return; } // 墨羽蓝调：恢复上次的日间 / 夜间
          if (k === 'imageFolder') v = String(v).replace(/[\\/:*?"<>|]/g, '').trim() || 'assets';
          else if (inp.type === 'text') v = String(v).trim();
          const out = $(`[data-v="${k}"]`, el);
          if (out) out.textContent = v;
          setSetting({ [k]: v });
          sync();
        });
      });
      bindAppearanceControls(el, current, close, sync);
      $('[data-act=reset]', el).onclick = async () => {
        const r = await api.invoke('dialog:message', {
          type: 'question', buttons: ['恢复默认设置', '取消'], defaultId: 1, cancelId: 1,
          message: '把所有设置恢复为默认值？', detail: '最近文件、窗口位置与插件的启用状态会保留。',
        });
        if (r !== 0) return;
        await resetSettings();
        close();
        openPreferences(current);
        toast('已恢复默认设置');
      };
      $$('[data-help]', el).forEach((a) => { a.onclick = (e) => { e.preventDefault(); showImageHelp(a.dataset.help); }; });
      $('[data-act=browse]', el).onclick = async () => {
        const p = await api.invoke('dialog:pickExe', s.picgoPath);
        if (!p) return;
        $('[data-k=picgoPath]', el).value = p;
        setSetting({ picgoPath: p });
      };
      $('[data-act=download]', el).onclick = () => api.invoke('shell:open', s.uploadService === 'picgo-core' ? 'https://github.com/PicGo/PicGo-Core' : 'https://github.com/Molunerfinn/PicGo/releases');
      $('[data-act=test]', el).onclick = async (e) => {
        const btn = e.currentTarget;
        const box = $('.pref-result', el);
        btn.disabled = true;
        btn.textContent = '正在上传测试图片…';
        box.hidden = false;
        box.className = 'pref-result';
        box.textContent = '正在使用当前设置上传一张测试图片…';
        const r = await api.invoke('image:testUpload');
        btn.disabled = false;
        btn.textContent = '验证图片上传选项';
        box.classList.add(r.ok ? 'ok' : 'fail');
        box.innerHTML = r.ok
          ? `<b>✔ 验证成功</b>（${r.ms} ms）<br>测试图片已上传到：<a href="#" data-url>${esc(r.url)}</a><img src="${esc(r.url)}" alt="">`
          : `<b>✘ 验证失败</b><pre>${esc(r.error)}</pre>`;
        const a = $('[data-url]', box);
        if (a) a.onclick = (ev) => { ev.preventDefault(); api.invoke('shell:open', r.url); };
      };
      $('[data-act=plugin-dir]', el).onclick = () => api.invoke('plugins:openDir');
      // 导出设置中显示是否找到了 Pandoc（修改路径后重新检测）
      const pandocCheck = () => api.invoke('export:pandocInfo').then((info) => { const st = $('#pandoc-status', el); if (st) { st.textContent = info ? `✓ 已找到 Pandoc ${info.version}` : '未找到 Pandoc'; st.classList.toggle('ok', !!info); } }).catch(() => {});
      pandocCheck();
      const pandocInput = $('[data-k=pandocPath]', el);
      if (pandocInput) pandocInput.addEventListener('change', () => setTimeout(pandocCheck, 300));
      $('[data-act=plugin-reload]', el).onclick = async () => { await runCommand('plugins.reload'); refreshPluginPane(); };
      $('[data-act=plugin-guide]', el).onclick = (e) => { e.preventDefault(); close(); runCommand('help.pluginGuide'); };
      $('[data-act=plugin-ai]', el).onclick = () => { close(); runCommand('plugins.aiPrompt'); };
      renderPluginList($('.plugin-list', el));
      $('[data-act=close]', el).onclick = close;
      show(PREF_SECTIONS.some(([id]) => id === current) ? current : 'general');
      sync();
    });
  }

  // 主题包中包含的设置项
  const THEME_PACKAGE_KEYS = ['theme', 'bgImage', 'bgFit', 'bgOpacityAuto', 'bgOverlay', 'bgBlur', 'bgPanels', 'accentColor', 'customCss',
    'fontFamily', 'customFont', 'codeFont', 'customCodeFont', 'fontSize', 'lineHeight', 'paragraphSpacing', 'contentWidth', 'firstLineIndent', 'headingNumbering'];

  /** 偏好设置中「外观」「主题与背景」「通用 → 更新」的按钮与列表 */
  function bindAppearanceControls(el, current, close, sync) {
    const s = state.settings;
    const reopen = (sec) => { close(); openPreferences(sec); };
    const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

    // 背景图片缩略图
    const thumb = $('.bg-thumb', el);
    const showThumb = async () => {
      const url = s.bgImage ? await api.invoke('theme:bgUrl', s.bgImage) : null;
      thumb.style.backgroundImage = url ? `url("${url}")` : '';
      thumb.toggleAttribute('data-empty', !url);
    };
    showThumb();
    $('[data-act=pick-bg]', el).onclick = async () => {
      const r = await api.invoke('theme:pickBackground');
      if (!r) return;
      setSetting({ bgImage: r.path });
      await showThumb();
      sync();
    };
    $('[data-act=clear-bg]', el).onclick = async () => { setSetting({ bgImage: '' }); await showThumb(); sync(); };
    if (state.themeInfo) applyTheme(); // 刷新「当前透明度」与图片配色的显示

    // 强调色：选择「自定义」时使用取色器中的颜色
    const accentSel = $('[data-k=accentColor]', el);
    const picker = $('[data-act=accent-pick]', el);
    const customOpt = () => Array.from(accentSel.options).find((o) => o.textContent === '自定义…');
    accentSel.addEventListener('change', () => {
      if (accentSel.value === 'custom' || /^#/.test(accentSel.value)) {
        customOpt().value = picker.value;
        accentSel.value = picker.value;
        setSetting({ accentColor: picker.value });
        sync();
      }
    });
    picker.addEventListener('input', () => { customOpt().value = picker.value; accentSel.value = picker.value; setSetting({ accentColor: picker.value }); });

    // 主题包
    $('[data-act=export-theme]', el).onclick = async () => {
      const name = await promptText('主题名称', '我的主题');
      if (name === null) return;
      const p = await api.invoke('theme:export', { name, settings: pick(state.settings, THEME_PACKAGE_KEYS) }).catch((e) => { toast('导出失败：' + errText(e), true); return null; });
      if (p) toast('已导出主题：' + basename(p));
    };
    $('[data-act=import-theme]', el).onclick = async () => {
      let r;
      try { r = await api.invoke('theme:import'); } catch (e) { toast('导入失败：' + errText(e), true); return; }
      if (!r) return;
      if (r.type === 'image') { setSetting({ bgImage: r.path }); toast('已将图片设为背景'); } else if (r.type === 'css') {
        setSetting({ customCss: (state.settings.customCss ? state.settings.customCss + '\n\n' : '') + `/* ${r.name} */\n` + r.text });
        toast('已导入 CSS：' + r.name);
      } else {
        const patch = pick(r.settings, THEME_PACKAGE_KEYS.filter((k) => k in r.settings));
        for (const k of ['fontFamily', 'codeFont']) if (patch[k] && /^font:/.test(patch[k]) && !importedFont(patch[k])) patch[k] = 'default'; // 主题包引用了本机没有的导入字体
        setSetting(patch);
        toast('已应用主题：' + r.name);
      }
      reopen('theme');
    };

    // 导入的字体
    const listBox = $('.font-list', el);
    const renderFonts = () => {
      listBox.innerHTML = (state.fonts || []).map((f) => `<div class="font-item"><span class="font-sample" style="font-family:'${esc(f.family)}'">永和九年 Moyu 0123</span>
        <span class="font-name">${esc(f.name)}<small>${esc(f.file)} · ${(f.size / 1048576).toFixed(1)} MB</small></span><button class="icon-btn" data-remove="${esc(f.file)}" title="删除">✕</button></div>`).join('');
    };
    renderFonts();
    $('[data-act=import-font]', el).onclick = async () => {
      const r = await api.invoke('font:import').catch((e) => { toast('导入字体失败：' + errText(e), true); return null; });
      if (!r) return;
      await refreshFonts();
      toast(`已导入 ${r.added.length} 个字体`);
      reopen('appearance');
    };
    listBox.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-remove]');
      if (!b) return;
      const f = (state.fonts || []).find((x) => x.file === b.dataset.remove);
      await api.invoke('font:remove', b.dataset.remove);
      const patch = {};
      if (f && state.settings.fontFamily === 'font:' + f.family) patch.fontFamily = 'default';
      if (f && state.settings.codeFont === 'font:' + f.family) patch.codeFont = 'default';
      if (Object.keys(patch).length) setSetting(patch);
      await refreshFonts();
      reopen('appearance');
    });

    // 系统字体建议（Local Font Access；不可用时仍可手动输入）
    const fill = async () => {
      const dl = $('#system-fonts', el);
      if (!dl || dl.children.length || !window.queryLocalFonts) return;
      try {
        const fonts = await window.queryLocalFonts();
        dl.innerHTML = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((f) => `<option value="${esc(f)}">`).join('');
      } catch (e) { /* 无权限时忽略 */ }
    };
    el.querySelectorAll('.font-input').forEach((inp) => { inp.setAttribute('list', 'system-fonts'); inp.addEventListener('focus', fill); });

    $('[data-act=check-update]', el).onclick = () => { close(); runCommand('help.checkUpdate'); };
    void current;
  }

  // 「一键提示词」中的功能示例，点击后填入描述框
  const AI_EXAMPLES = [
    ['番茄钟', '在状态栏显示一个 25 分钟的专注倒计时：点击开始 / 暂停，结束时弹出提示并记录今天完成的番茄数（保存在插件数据中）；提供「开始专注」「重置」两个命令，快捷键 Ctrl+Alt+P。'],
    ['选中翻译', '选中一段文字后执行命令「翻译选中文字」（快捷键 Ctrl+Alt+T），弹出对话框显示译文，可选择「替换原文」或「插入到下一段」。翻译接口地址与密钥在首次使用时用输入框询问并保存在插件数据中。'],
    ['修改时间', '保存文档时自动更新文档开头 YAML Front Matter 中的 updated 字段为当前时间（格式 2026-01-01 12:00）；如果没有 Front Matter 则不做任何改动。'],
    ['柱状图代码块', '支持 ```chart 代码块：每行写「名称: 数值」，渲染为使用 SVG 绘制的横向柱状图，颜色使用主题强调色，深色主题下清晰可读，导出 PDF 时同样显示。'],
  ];

  /** 「一键提示词」：描述想要的功能，生成交给 AI 编写插件的完整提示词 */
  function openAIPrompt() {
    const info = { version: state.info.version, apiVersion: window.Moyu.apiVersion };
    showModal(`<h3>✨ 一键提示词：用 AI 生成插件</h3>
      <ol class="ai-steps"><li>在下方用自己的话描述想要的功能（也可以点示例后修改）。</li>
        <li>点击「复制提示词」，粘贴到 ChatGPT、Claude、DeepSeek、通义千问等 AI 工具中发送。</li>
        <li>按 AI 的说明把生成的文件放进插件目录，然后执行「插件 → 重新加载插件」。</li></ol>
      <label class="ai-label">想要实现的功能</label>
      <textarea class="ai-feature" spellcheck="false" placeholder="例如：选中文字后按 Ctrl+Alt+U，把英文转换为大写；在状态栏显示今天写了多少字……"></textarea>
      <div class="ai-examples">示例：${AI_EXAMPLES.map(([t], i) => `<button class="text-btn" data-ex="${i}">${esc(t)}</button>`).join('')}</div>
      <label class="ai-label">提示词预览 <small>（已包含 Moyu 插件的运行环境、完整接口、约束与输出要求；可直接编辑）</small></label>
      <textarea class="ai-prompt" spellcheck="false"></textarea>
      <div class="actions"><button class="text-btn" data-act="dir">打开插件目录</button><button class="text-btn" data-act="guide">插件开发指南</button>
        <span style="flex:1"></span><span class="ai-count"></span><button class="text-btn" data-act="close">关闭</button><button class="text-btn primary" data-act="copy">复制提示词</button></div>`,
    (el, close) => {
      el.classList.add('ai-modal');
      const feature = $('.ai-feature', el);
      const prompt = $('.ai-prompt', el);
      const count = $('.ai-count', el);
      const regen = () => { prompt.value = ZAIPrompt.build(feature.value, info); count.textContent = `${prompt.value.length} 字`; };
      feature.addEventListener('input', regen);
      prompt.addEventListener('input', () => { count.textContent = `${prompt.value.length} 字`; });
      $$('[data-ex]', el).forEach((b) => { b.onclick = () => { feature.value = AI_EXAMPLES[Number(b.dataset.ex)][1]; regen(); feature.focus(); }; });
      $('[data-act=dir]', el).onclick = () => api.invoke('plugins:openDir');
      $('[data-act=guide]', el).onclick = () => { close(); runCommand('help.pluginGuide'); };
      $('[data-act=close]', el).onclick = close;
      const copy = $('[data-act=copy]', el);
      copy.onclick = async () => {
        if (!feature.value.trim()) { feature.focus(); toast('请先描述想要实现的功能', true); return; }
        await api.invoke('app:copyText', prompt.value);
        copy.textContent = '已复制 ✓';
        toast('已复制提示词，粘贴到 AI 工具中即可');
        setTimeout(() => { copy.textContent = '复制提示词'; }, 1800);
      };
      regen();
      feature.focus();
    });
  }

  /** 恢复默认设置（保留使用记录），并立即应用到界面 */
  async function resetSettings() {
    state.settings = await api.invoke('settings:reset');
    applySettings(state.settings);
  }

  function renderPluginList(box) {
    const list = pluginHost.list();
    if (!list.length) { box.innerHTML = '<div class="empty-hint">没有找到插件。</div>'; return; }
    box.innerHTML = list.map((p) => {
      const status = !p.enabled ? ['off', '已停用'] : (p.error ? ['err', '加载失败'] : ['on', '已启用']);
      return `<div class="plugin-card ${status[0]}">
        <div class="plugin-info">
          <div class="plugin-name">${esc(p.name)}${p.version ? `<span class="plugin-ver">v${esc(p.version)}</span>` : ''}<span class="plugin-badge">${p.builtin ? '内置' : '用户'}</span><span class="plugin-status">${status[1]}</span></div>
          <div class="plugin-desc">${esc(p.description || '（无描述）')}</div>
          <div class="plugin-meta">${p.author ? '作者 ' + esc(p.author) + ' · ' : ''}id：${esc(p.id)}${p.commands.length ? ' · 命令：' + p.commands.map(esc).join('、') : ''}</div>
          ${p.error && p.enabled ? `<div class="plugin-error">${esc(p.error)}</div>` : ''}
        </div>
        <label class="switch" title="${p.enabled ? '停用插件' : '启用插件'}"><input type="checkbox" data-plugin="${esc(p.id)}"${p.enabled ? ' checked' : ''}><span></span></label>
      </div>`;
    }).join('');
    $$('input[data-plugin]', box).forEach((inp) => {
      inp.onchange = async () => {
        inp.disabled = true;
        await api.invoke('plugins:setEnabled', inp.dataset.plugin, inp.checked);
        await pluginHost.reload();
        renderPluginList(box);
      };
    });
  }

  function refreshPluginPane() {
    const box = $('.prefs .plugin-list');
    if (box) renderPluginList(box);
  }

  function showImageHelp(topic) {
    const body = {
      insert: `<p>决定粘贴、拖入或通过菜单插入图片时如何处理图片文件：</p><ul>
        <li><b>无特殊操作</b>：直接引用原图片路径（粘贴的图片会保存到 ./assets）。</li>
        <li><b>复制到当前文件夹 / ./assets / 指定路径</b>：把图片复制过去，再以相对或绝对路径插入。指定路径支持 <code>\${filename}</code>。</li>
        <li><b>上传图片</b>：通过下方的上传服务上传，插入返回的网络地址；上传失败时自动退回为本地图片。</li></ul>
        <p>也可以在文档的 YAML Front Matter 中按文档指定：<code>typora-copy-images-to: ./img</code> 或 <code>typora-copy-images-to: upload</code>（后者需勾选「允许根据 YAML 设置自动上传图片」）。</p>
        <p>「格式 → 图片 → 上传所有本地图片」可把文档里已有的本地图片一次性上传并替换地址。</p>`,
      syntax: `<ul><li><b>优先使用相对路径</b>：相对于当前文档写入图片路径（文档需先保存）。</li>
        <li><b>为相对路径添加 ./</b>：写成 <code>./assets/a.png</code>。</li>
        <li><b>自动转义图片 URL</b>：对空格、中文等字符做 URL 编码；未勾选时仅把空格写为 <code>%20</code>。</li></ul>`,
      upload: `<ul><li><b>PicGo (app)</b>：调用 PicGo 桌面版内置服务（默认 <code>http://127.0.0.1:36677</code>，需在 PicGo「设置 → 设置Server」中开启）。若 PicGo 未运行且填写了路径，Moyu 会自动启动它。</li>
        <li><b>PicGo-Core</b>：执行 <code>picgo upload 图片路径…</code>，需先 <code>npm i -g picgo</code> 并完成图床配置。</li>
        <li><b>自定义命令</b>：执行「命令 + 图片路径（每个路径加引号）」，程序需在输出的最后几行依次打印图片的网络地址（每行一个）。</li></ul>
        <p>点击「验证图片上传选项」会用当前设置上传一张测试图片。</p>`,
    }[topic];
    showModal(`<h3>图像设置说明</h3><div class="help-body">${body}</div><div class="actions"><button class="text-btn primary" data-act="close">知道了</button></div>`,
      (el, close) => { $('[data-act=close]', el).onclick = close; });
  }

  function showShortcuts() {
    const rows = [
      ['文件'],
      ['新建 / 新建窗口', 'Ctrl+N / Ctrl+Shift+N'], ['打开 / 打开文件夹', 'Ctrl+O / Ctrl+Shift+O'],
      ['下一个 / 上一个标签页', 'Ctrl+Tab / Ctrl+Shift+Tab'], ['关闭标签页 / 关闭窗口', 'Ctrl+W / Ctrl+Shift+W'], ['重新打开关闭的标签页', 'Ctrl+Shift+T'],
      ['保存 / 另存为', 'Ctrl+S / Ctrl+Shift+S'], ['快速打开（输入 > 搜索命令）', 'Ctrl+P'], ['命令面板', 'F1'], ['导出 PDF', 'Ctrl+Shift+P'], ['偏好设置', 'Ctrl+,'], ['关闭窗口', 'Ctrl+W'],
      ['编辑'],
      ['撤销 / 重做', 'Ctrl+Z / Ctrl+Y（或 Ctrl+Shift+Z）'], ['查找 / 替换', 'Ctrl+F / Ctrl+H'], ['查找下一个 / 上一个', 'F3 / Shift+F3'],
      ['粘贴为纯文本（不转换格式）', 'Ctrl+Shift+V'], ['复制为富文本（Word、邮件、公众号）', 'Ctrl+Shift+C'], ['全选（多行块中先选中块内内容）', 'Ctrl+A'],
      ['在文件夹中查找', 'Ctrl+Shift+F'], ['跳转到标题', 'Ctrl+G'], ['表格操作、拼写建议等', '右键菜单'],
      ['段落'],
      ['标题 1~6 / 段落', 'Ctrl+1~6 / Ctrl+0'], ['提升 / 降低标题级别', 'Ctrl+= / Ctrl+-'],
      ['表格 / 代码块 / 公式块', 'Ctrl+T / Ctrl+Shift+K / Ctrl+Shift+M'], ['引用', 'Ctrl+Shift+Q'],
      ['有序 / 无序 / 任务列表', 'Ctrl+Shift+[ / ] / X'],
      ['格式'],
      ['加粗 / 斜体 / 下划线', 'Ctrl+B / Ctrl+I / Ctrl+U'], ['删除线 / 高亮', 'Alt+Shift+5 / Ctrl+Shift+H'],
      ['行内代码 / 行内公式', 'Ctrl+Shift+` / Ctrl+Shift+E'], ['超链接 / 图片', 'Ctrl+K / Ctrl+Shift+I'], ['清除样式', 'Ctrl+\\'],
      ['视图'],
      ['源代码模式', 'Ctrl+/'], ['纯文本模式（不显示源码）', 'F7'], ['侧边栏 / 大纲 / 文件树', 'Ctrl+Shift+L / 1 / 3'], ['专注 / 打字机模式', 'F8 / F9'],
      ['放大 / 缩小 / 实际大小', 'Ctrl+Shift+= / - / 0'], ['全屏', 'F11'],
      ['编辑块内'],
      state.settings.enterMode === 'newline' ? ['段内换行 / 新段落', 'Enter / Shift+Enter'] : ['新段落 / 段内换行', 'Enter / Shift+Enter'],
      ['在块之间移动', '↑ / ↓（位于首行 / 末行时）'], ['列表缩进 / 反缩进', 'Tab / Shift+Tab'], ['表格跳到下一格', 'Tab'],
      ['在当前块下方新建段落（纯文本模式）', 'Ctrl+Enter'], ['斜杠命令（在空段落中）', '/'], ['退出编辑块', 'Esc'], ['打开链接', 'Ctrl+单击'], ['放大图片', '双击图片'],
    ];
    // 已启用插件提供的带快捷键的命令
    const pluginRows = [...pluginHost.commands.values()].filter((c) => c.accelerator)
      .map((c) => [`${esc((pluginHost.records.get(c.pluginId) || { manifest: {} }).manifest.name || c.pluginId)}：${esc(c.title)}`, c.accelerator.replace(/CmdOrCtrl/g, 'Ctrl')]);
    if (pluginRows.length) rows.push(['插件'], ...pluginRows);
    const html = rows.map((r) => (r.length === 1 ? `<tr class="kbd-group"><td colspan="2">${r[0]}</td></tr>` : `<tr><td>${r[0]}</td><td>${esc(r[1])}</td></tr>`)).join('');
    showModal(`<h3>快捷键一览</h3><table class="kbd-table">${html}</table>
      <div class="actions"><button class="text-btn primary" data-act="close">关闭</button></div>`, (el, close) => { $('[data-act=close]', el).onclick = close; });
  }

  function showAbout() {
    const i = state.info;
    showModal(`<div class="about"><img class="logo" src="../../build/icon.png" alt=""><h3>Moyu ${esc(i.version || '')}</h3>
      <div>所见即所得的 Markdown 编辑器</div>
      <div style="color:var(--muted);font-size:12px">Electron ${esc(i.electron || '')} · Chromium ${esc(i.chrome || '')} · markdown-it · KaTeX ${esc(katex.version)} · Mermaid · highlight.js</div>
      <div style="color:var(--muted);font-size:12px">插件接口版本 ${window.Moyu.apiVersion} · 已启用插件 ${pluginHost.list().filter((p) => p.active).length} 个 · MIT 开源许可</div>
      <div class="actions" style="justify-content:center"><button class="text-btn" data-act="update">检查更新</button><button class="text-btn" data-act="repo">GitHub 仓库</button><button class="text-btn primary" data-act="close">确定</button></div></div>`,
    (el, close) => {
      $('[data-act=close]', el).onclick = close;
      $('[data-act=update]', el).onclick = () => { close(); runCommand('help.checkUpdate'); };
      $('[data-act=repo]', el).onclick = () => api.invoke('shell:open', 'https://github.com/Eterna10/Moyu');
    });
  }

  /* ======================= 导出 ======================= */

  async function buildExportHtml(forPdf) {
    if (!state.sourceMode) editor.dropEmptyActive();
    const text = getText();
    const holder = document.createElement('div');
    holder.className = 'markdown-body';
    holder.style.cssText = 'position:fixed;left:-20000px;top:0;width:860px;';
    document.body.appendChild(holder);
    try {
      holder.innerHTML = ZMD.sanitize(editor.md.render(text, { baseDir: state.baseDir }));
      ZMD.postProcess(holder, state.baseDir);
      await ZMD.whenRendered();
      $$('.code-copy', holder).forEach((b) => b.remove());
      $$('a[title^="Ctrl + 单击"]', holder).forEach((a) => a.removeAttribute('title'));
      $$('.task-checkbox', holder).forEach((c) => c.setAttribute('disabled', ''));
      $$('img[loading]', holder).forEach((im) => im.removeAttribute('loading')); // 导出的页面在隐藏窗口中渲染，懒加载的图片不会加载
      const s = state.settings;
      if (!forPdf) {
        for (const img of $$('img[data-orig-src]', holder)) {
          // 「导出 HTML 时嵌入图片」：本地图片转为 data URL，得到单个自包含文件
          const src = img.getAttribute('src') || '';
          let embedded = null;
          if (s.exportEmbedImages && /^file:/i.test(src)) {
            const p = decodeURIComponent(new URL(src).pathname).replace(/^\/([a-z]:)/i, '$1');
            embedded = await api.invoke('fs:imageDataUrl', p).catch(() => null);
          }
          img.setAttribute('src', embedded || img.getAttribute('data-orig-src'));
        }
      }
      const theme = s.exportTheme && s.exportTheme !== 'current' ? s.exportTheme : s.theme;
      const dark = DARK.has(theme);
      const read = (p) => api.invoke('app:readAsset', p);
      // 「墨羽蓝调」的标题、引用、表格等装饰写在单独的样式表里；其中的字体与图片地址改为本机的绝对地址
      const moyuCss = /^moyu/.test(theme)
        ? (await read('src/renderer/css/theme-moyu.css')).replace(/url\("\.\.\/assets\//g, 'url("' + ZMD.toFileUrl(state.info.katexDir).replace(/node_modules\/katex\/dist\/?$/, 'src/renderer/assets/'))
        : '';
      const [themes, mdcss, hl, kx] = await Promise.all([
        read('src/renderer/css/themes.css'),
        read('src/renderer/css/markdown.css'),
        read(`node_modules/@highlightjs/cdn-assets/styles/${dark ? 'github-dark' : 'github'}.min.css`),
        read('node_modules/katex/dist/katex.min.css'),
      ]);
      const fontBase = forPdf ? ZMD.toFileUrl(state.info.katexDir) + '/fonts/' : `https://cdn.jsdelivr.net/npm/katex@${katex.version}/dist/fonts/`;
      const katexCss = kx.replace(/url\(fonts\//g, 'url(' + fontBase);
      // 外观设置（字体、段落间距、首行缩进、标题编号等）同样作用于导出结果
      const font = bodyFont(s);
      const vars = [`--font-size:${s.fontSize}px`, `--line-height:${s.lineHeight}`, `--para-spacing:${PARA_SPACING[s.paragraphSpacing] || PARA_SPACING.normal}`, `--tab-size:${s.tabSize || 4}`]
        .concat(font ? [`--font-body:${font}`, `--font-heading:${font}`] : [])
        .concat(codeFont(s) ? [`--font-mono:${codeFont(s)}`] : []).join(';');
      const bodyClasses = Object.entries(BODY_CLASSES).filter(([k]) => s[k]).map(([, c]) => c).join(' ');
      // 导入的字体：PDF 直接引用本地文件；HTML 内嵌（过大的字体保留本地文件引用）
      const faces = [];
      for (const f of usedFonts(s)) {
        const src = forPdf ? f.url : ((await api.invoke('font:dataUrl', f.file).catch(() => null)) || f.url);
        faces.push(`@font-face{font-family:"${f.family}";src:url("${src}") format("${f.format}");}`);
      }
      const page = faces.join('\n') + (s.customCss ? '\n' + s.customCss : '') + `
        html,body{margin:0;background:var(--bg);}
        .markdown-body{max-width:860px;margin:0 auto;padding:48px 56px;${vars};}
        .markdown-body .code-copy{display:none}
        @media print{.markdown-body{padding:0;max-width:none}pre,table,img,.mermaid-block,.math-block,blockquote{break-inside:avoid}h1,h2,h3{break-after:avoid}}`;
      const title = esc(docName().replace(/\.(md|markdown|txt)$/i, ''));
      return `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="generator" content="Moyu">\n<title>${title}</title>\n` +
        `<style>\n${katexCss}\n${hl}\n${themes}\n${mdcss}\n${moyuCss}\n${[...docStyles].join('\n')}\n${page}\n</style>\n</head>\n<body data-theme="${esc(theme)}"${bodyClasses ? ` class="${bodyClasses}"` : ''}>\n<article class="markdown-body">\n${holder.innerHTML}\n</article>\n</body>\n</html>\n`;
    } finally {
      holder.remove();
    }
  }

  const PANDOC_KINDS = { docx: ['Word 文档', 'docx'], odt: ['OpenDocument 文本', 'odt'], rtf: ['RTF 文档', 'rtf'], epub: ['EPUB 电子书', 'epub'], latex: ['LaTeX 源文件', 'tex'] };

  /** 没有找到 Pandoc 时的说明 */
  function showPandocHelp(name) {
    showModal(`<h3>导出 ${esc(name)} 需要 Pandoc</h3>
      <p>Moyu 通过 <b>Pandoc</b>（免费的开源文档转换工具）生成 Word、ODT、RTF、EPUB、LaTeX 文件：公式会转成 Word 自带的公式，图片会嵌入到文件中。</p>
      <p>这台电脑上没有找到 Pandoc。安装后无需任何设置，重新导出即可；如果安装在了不常见的位置，可以在「偏好设置 → 导出」中填写 pandoc.exe 的路径。</p>
      <p class="update-meta">暂时不想安装？「编辑 → 复制为 → 富文本」可以把文档直接粘贴到 Word 中（公式除外）。</p>
      <div class="actions"><button class="text-btn" data-act="pref">打开导出设置</button><span style="flex:1"></span><button class="text-btn" data-act="close">关闭</button><button class="text-btn primary" data-act="get">前往 Pandoc 下载页</button></div>`,
    (el, close) => {
      el.classList.add('pandoc-modal');
      $('[data-act=close]', el).onclick = close;
      $('[data-act=get]', el).onclick = () => { api.invoke('shell:open', 'https://pandoc.org/installing.html'); close(); };
      $('[data-act=pref]', el).onclick = () => { close(); openPreferences('export'); };
    });
  }

  async function exportPandoc(kind, outPath) {
    const [name, ext] = PANDOC_KINDS[kind];
    if (!state.sourceMode) editor.dropEmptyActive();
    const base = (state.filePath ? state.filePath.replace(/\.[^.\\/]+$/, '') : suggestedName().replace(/\.md$/, ''));
    try {
      toast(`正在导出 ${name}…`);
      const r = await api.invoke('export:pandoc', {
        markdown: getText(), format: kind, defaultPath: base + '.' + ext, outPath, baseDir: state.baseDir,
        title: docName().replace(/\.(md|markdown|txt)$/i, ''), breaks: state.settings.breaks, supSub: state.settings.supSubSyntax,
      });
      if (!r) return null;
      if (r.missing) { showPandocHelp(name); return r; }
      toast(r.warnings && r.warnings.length ? `已导出：${basename(r.path)}（有 ${r.warnings.length} 条警告，例如：${r.warnings[0].slice(0, 60)}）` : '已导出：' + basename(r.path));
      return r;
    } catch (e) {
      toast('导出失败：' + String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
      return null;
    }
  }

  async function exportImage(outPath) {
    try {
      const html = await buildExportHtml(true);
      const base = (state.filePath ? state.filePath.replace(/\.[^.\\/]+$/, '') : suggestedName().replace(/\.md$/, ''));
      toast('正在导出图片…');
      const files = await api.invoke('export:image', { html, defaultPath: base + '.png', outPath });
      if (!files) return null;
      toast(files.length > 1 ? `文档较长，已分成 ${files.length} 张图片导出：${basename(files[0])} 等` : '已导出：' + basename(files[0]));
      return files;
    } catch (e) {
      toast('导出失败：' + String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
      return null;
    }
  }

  async function exportDoc(kind, outPath) {
    if (kind === 'image') return exportImage(outPath);
    if (PANDOC_KINDS[kind]) return exportPandoc(kind, outPath);
    try {
      const html = await buildExportHtml(kind === 'pdf');
      const base = (state.filePath ? state.filePath.replace(/\.[^.\\/]+$/, '') : suggestedName().replace(/\.md$/, ''));
      if (kind === 'pdf') toast('正在导出 PDF…');
      const title = docName().replace(/\.(md|markdown|txt)$/i, '');
      const p = await api.invoke(kind === 'pdf' ? 'export:pdf' : 'export:html', { html, defaultPath: base + (kind === 'pdf' ? '.pdf' : '.html'), outPath, title });
      if (p) toast('已导出：' + basename(p));
      return p;
    } catch (e) {
      toast('导出失败：' + e.message, true);
      return null;
    }
  }

  /* ======================= 图片 / 拖放 / 链接 ======================= */

  /** 文档 YAML 中的 typora-copy-images-to / zmark-copy-images-to */
  function yamlImageTarget() {
    const m = /^---\n([\s\S]*?)\n(?:---|\.\.\.)\s*(?:\n|$)/.exec(getText());
    if (!m) return null;
    const t = /^(?:typora|zmark)-copy-images-to:\s*(.+?)\s*$/m.exec(m[1]);
    return t ? t[1].replace(/^['"]|['"]$/g, '') : null;
  }

  /** 按「插入图片时…」规则处理图片，返回 Markdown 文本；sources: [{path}|{url}|{data, ext}] */
  async function insertImages(sources) {
    if (!sources.length) return null;
    const slow = setTimeout(() => toast(state.settings.imageInsertAction === 'upload' ? `正在上传 ${sources.length} 张图片…` : '正在处理图片…'), 400);
    try {
      const r = await api.invoke('image:insert', { docPath: state.filePath, yamlTarget: yamlImageTarget(), sources });
      if (r.error) toast('图片上传失败，已作为本地图片插入：' + r.error.split('\n')[0], true);
      else if (r.uploaded) toast(`已上传 ${r.uploaded} 张图片`);
      else if (!state.filePath && sources.some((s) => s.data)) toast('文档尚未保存，粘贴的图片已存入临时目录');
      return r.results.map((x) => `![](${x.src})`).join('\n');
    } catch (e) {
      toast('插入图片失败：' + cleanErr(e), true);
      return null;
    } finally {
      clearTimeout(slow);
    }
  }

  const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function insertMarkdown(text) {
    if (!text) return;
    if (state.sourceMode) { source.ta.focus(); document.execCommand('insertText', false, text); }
    else editor.insertText(text);
  }

  async function onPasteImage(file) {
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    return insertImages([{ data: new Uint8Array(await file.arrayBuffer()), ext }]);
  }

  async function pickImage() {
    const paths = await api.invoke('dialog:pickImage');
    if (paths && paths.length) insertMarkdown(await insertImages(paths.map((p) => ({ path: p }))));
  }

  const IMG_URL_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|#|$)/i;
  /** 从浏览器拖入的图片：取 <img src> 或图片链接 */
  function droppedImageUrl(dt) {
    const html = dt.getData('text/html');
    const m = html && /<img[^>]+src=["']([^"']+)["']/i.exec(html);
    if (m && /^https?:/i.test(m[1])) return m[1].replace(/&amp;/g, '&');
    const uri = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
    return uri && /^https?:/i.test(uri) && IMG_URL_RE.test(uri) ? uri : null;
  }

  function bindDrop() {
    let depth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { depth++; document.body.classList.add('drag-over'); } });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('drag-over'); });
    window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
      depth = 0;
      document.body.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files || []);
      if (!files.length) {
        const url = droppedImageUrl(e.dataTransfer);
        if (!url) return;
        e.preventDefault();
        e.stopPropagation();
        insertMarkdown(await insertImages([{ url }]));
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const mds = files.filter((f) => MD_RE.test(f.name));
      if (mds.length) {
        // 启用标签页时拖入的多个文档全部打开，否则只打开第一个
        for (const f of (tabsOn() ? mds : mds.slice(0, 1))) await openPath(api.pathForFile(f));
        return;
      }
      const sources = files.filter((x) => IMG_RE.test(x.name)).map((f) => ({ path: api.pathForFile(f) })).filter((s) => s.path);
      insertMarkdown(await insertImages(sources));
    }, true);
  }

  /** 「上传所有本地图片」：上传文档中引用的本地图片并替换为网络地址 */
  async function uploadAllLocal() {
    if (!state.sourceMode) editor.dropEmptyActive();
    const text = getText();
    const RE = /(!\[[^\]]*\]\()(<[^>\n]+>|[^)\s]+)((?:\s+["'][^"'\n]*["'])?\))|(<img\b[^>]*?\bsrc=["'])([^"']+)(["'])/g;
    const srcs = new Set();
    for (const m of text.matchAll(RE)) srcs.add(m[2] || m[5]);
    const items = [];
    for (const src of srcs) {
      let p = src.replace(/^<|>$/g, '');
      if (/^file:/i.test(p)) p = p.replace(/^file:\/\/\/?/i, '');
      else if (ZMD.isExternal(p) || p.startsWith('#')) continue;
      try { p = decodeURI(p); } catch (e) { /* 原样 */ }
      if (!/^[a-z]:[\\/]/i.test(p) && !p.startsWith('\\\\') && !state.baseDir) continue;
      items.push({ src, path: p.replace(/\//g, '\\') });
    }
    if (!items.length) { toast('文档中没有本地图片'); return 0; }
    toast(`正在上传 ${items.length} 张本地图片…`);
    let r;
    try { r = await api.invoke('image:uploadLocal', { baseDir: state.baseDir, items }); } catch (e) { toast('上传失败：' + cleanErr(e).split('\n')[0], true); return -1; }
    const out = text.replace(RE, (all, a, src, c, d, src2, f) => {
      if (a) return r.map[src] ? a + r.map[src] + c : all;
      return r.map[src2] ? d + r.map[src2] + f : all;
    });
    if (state.sourceMode) { source.ta.value = out; source.refresh(true); onChange(); } else editor.replaceAllText(out);
    const n = Object.keys(r.map).length;
    toast(`已上传 ${n} 张图片` + (r.missing.length ? `，${r.missing.length} 张未找到` : ''), !!r.missing.length);
    return n;
  }

  function onLink(href) {
    if (!href) return;
    if (href.startsWith('#')) {
      let id = href.slice(1);
      try { id = decodeURIComponent(id); } catch (e) { /* 原样 */ }
      const el = document.getElementById(id) || $(`#write [name="${CSS.escape(id)}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) { api.invoke('shell:open', href); return; }
    if (ZMD.isExternal(href) && !/^file:/i.test(href)) { toast('不支持打开该链接：' + href, true); return; }
    let p = href.replace(/^file:\/\/\/?/i, '').split('#')[0];
    try { p = decodeURI(p); } catch (e) { /* 原样 */ }
    if (!/^[a-z]:[\\/]/i.test(p) && !p.startsWith('/') && state.baseDir) p = state.baseDir + '\\' + p.replace(/\//g, '\\');
    if (MD_RE.test(p)) openPath(p);
    else api.invoke('shell:reveal', p);
  }

  /* ======================= 命令 ======================= */

  const inEditor = (fn) => () => {
    if (state.sourceMode) { toast('源代码模式下请直接编辑 Markdown'); return; }
    fn();
  };
  const wrapCmd = (l, r, ph) => () => (state.sourceMode ? sourceWrap(l, r, ph) : editor.toggleWrap(l, r, ph));

  function clearFormat() {
    const strip = (s) => s.replace(/(\*\*|__|~~|==|`|<\/?u>|<\/?mark>)/g, '').replace(/(^|[^*\w])[*_]([^*_\n]+)[*_]/g, '$1$2');
    if (state.sourceMode) {
      const ta = source.ta;
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel) { ta.focus(); document.execCommand('insertText', false, strip(sel)); }
      return;
    }
    if (!editor.isEditing()) return;
    const ta = editor.hl.ta;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const v = ta.value;
    const seg = s === e ? v : v.slice(s, e);
    const out = strip(seg);
    if (s === e) editor.applyEdit(out, Math.min(s, out.length));
    else editor.applyEdit(v.slice(0, s) + out + v.slice(e), s, s + out.length);
  }

  function sourceHeading(level) {
    const ta = source.ta;
    const v = ta.value;
    const ls = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let le = v.indexOf('\n', ls);
    if (le < 0) le = v.length;
    const line = v.slice(ls, le);
    const cur = (/^(#{1,6})\s/.exec(line) || [, ''])[1].length;
    const lv = level === cur ? 0 : level;
    const nl = (lv ? '#'.repeat(lv) + ' ' : '') + line.replace(/^#{1,6}\s+/, '');
    ta.focus();
    ta.setSelectionRange(ls, le);
    document.execCommand('insertText', false, nl);
  }
  const headingCmd = (n) => () => (state.sourceMode ? sourceHeading(n) : editor.setHeading(n));

  const COMMANDS = {
    'file.new': newDoc,
    'file.open': async () => { const p = await api.invoke('dialog:open'); if (p) openPath(p); },
    'file.openFolder': async () => {
      const d = await api.invoke('dialog:openFolder');
      if (!d) return;
      await loadFolder(d);
      setSetting({ sidebar: true, sidebarTab: 'files' });
    },
    'file.save': () => save(false),
    'file.saveAs': () => save(true),
    'file.toggleAutoSave': () => { setSetting({ autoSave: !state.settings.autoSave }); toast(state.settings.autoSave ? '已开启自动保存' : '已关闭自动保存'); },
    'file.exportHtml': () => exportDoc('html'),
    'file.exportPdf': () => exportDoc('pdf'),
    'file.exportImage': () => exportDoc('image'),
    'file.exportDocx': () => exportDoc('docx'),
    'file.exportOdt': () => exportDoc('odt'),
    'file.exportRtf': () => exportDoc('rtf'),
    'file.exportEpub': () => exportDoc('epub'),
    'file.exportLatex': () => exportDoc('latex'),
    'file.reveal': () => { if (state.filePath) api.invoke('shell:reveal', state.filePath); else toast('文档尚未保存'); },
    'file.preferences': () => openPreferences(),
    'file.preferencesTheme': () => { closeModals(); openPreferences('theme'); },
    'file.quickOpen': () => extras.openPalette('file'),
    'file.history': () => extras.openHistory(),
    'edit.commandPalette': () => extras.openPalette('cmd'),
    'edit.gotoHeading': () => extras.openPalette('heading'),
    'help.checkUpdate': () => { closeModals(); return extras.checkUpdate(false); },
    'file.preferencesImage': () => openPreferences('image'),
    'file.close': () => (tabs.length > 1 ? closeTab() : onBeforeClose()),
    'file.closeWindow': onBeforeClose,
    'file.reopenClosed': reopenClosedTab,
    'view.nextTab': () => stepTab(1),
    'view.prevTab': () => stepTab(-1),
    // 焦点在查找框等界面输入框中时，撤销 / 重做作用于该输入框而不是文档
    'edit.undo': () => {
      if (uiInputFocused() && !lastActionWasReplace()) document.execCommand('undo');
      else if (state.sourceMode) { sourceHistory('undo'); } else editor.undo();
    },
    'edit.redo': () => {
      if (uiInputFocused() && !lastActionWasReplace()) document.execCommand('redo');
      else if (state.sourceMode) { sourceHistory('redo'); } else editor.redo();
    },
    // 全选：输入框中由浏览器处理；源代码模式选中全部源码；否则选中整篇文档（多行块先选中块内内容）
    'edit.selectAll': () => {
      if (uiInputFocused() || state.sourceMode) { if (state.sourceMode && !uiInputFocused()) source.ta.focus(); document.execCommand('selectAll'); return; }
      if (!editor.selectAll()) document.execCommand('selectAll');
    },
    'edit.pastePlain': () => { ws.pastePlain(); return api.invoke('edit:exec', 'pastePlain'); },
    'edit.copyRich': () => ws.copyAs('rich'),
    'edit.copyHtml': () => ws.copyAs('html'),
    'edit.copyMarkdown': () => ws.copyAs('markdown'),
    'edit.findInFolder': () => ws.openSearch(),
    'file.recover': () => ws.showRecovery(true),
    'edit.find': () => openFind(false),
    'edit.replace': () => openFind(true),
    'edit.findNext': () => findStep(1),
    'edit.findPrev': () => findStep(-1),
    'para.h1': headingCmd(1), 'para.h2': headingCmd(2), 'para.h3': headingCmd(3),
    'para.h4': headingCmd(4), 'para.h5': headingCmd(5), 'para.h6': headingCmd(6),
    'para.p': () => (state.sourceMode ? sourceHeading(0) : editor.setHeading(0)),
    'para.headingUp': inEditor(() => editor.setHeading('up')),
    'para.headingDown': inEditor(() => editor.setHeading('down')),
    'para.table': inEditor(() => editor.insertTable()),
    'para.code': inEditor(() => editor.insertCodeBlock()),
    'para.math': inEditor(() => editor.insertMathBlock()),
    'para.quote': inEditor(() => editor.toggleLinePrefix('quote')),
    'para.ol': inEditor(() => editor.toggleLinePrefix('ol')),
    'para.ul': inEditor(() => editor.toggleLinePrefix('ul')),
    'para.task': inEditor(() => editor.toggleLinePrefix('task')),
    'para.hr': inEditor(() => editor.insertHr()),
    'para.toc': inEditor(() => editor.insertToc()),
    // 加粗 / 斜体使用「Markdown → 书写风格」中设置的符号
    'fmt.bold': () => { const m = state.settings.strongMarker || '**'; return wrapCmd(m, m, '加粗文本')(); },
    'fmt.italic': () => { const m = state.settings.emMarker || '*'; return wrapCmd(m, m, '斜体文本')(); },
    'fmt.underline': wrapCmd('<u>', '</u>', '下划线文本'),
    'fmt.strike': wrapCmd('~~', '~~', '删除文本'),
    'fmt.mark': wrapCmd('==', '==', '高亮文本'),
    'fmt.code': wrapCmd('`', '`', 'code'),
    'fmt.math': wrapCmd('$', '$', 'E=mc^2'),
    'fmt.link': () => (state.sourceMode ? sourceWrap('[', ']()', '链接文本') : editor.insertLink(false)),
    'fmt.image': pickImage,
    'fmt.uploadAll': uploadAllLocal,
    'fmt.clear': clearFormat,
    'view.source': toggleSource,
    'view.rich': () => { setSetting({ richMode: !state.settings.richMode }); toast(state.settings.richMode ? '纯文本模式：编辑时不显示源码' : '已关闭纯文本模式：编辑时显示当前段落的源码'); },
    'view.sidebar': () => setSetting({ sidebar: !state.settings.sidebar }),
    'view.outline': () => setSetting({ sidebar: true, sidebarTab: 'outline' }),
    'view.files': () => setSetting({ sidebar: true, sidebarTab: 'files' }),
    'view.focus': () => setSetting({ focusMode: !state.settings.focusMode }),
    'view.typewriter': () => setSetting({ typewriter: !state.settings.typewriter }),
    'help.welcome': () => openHelp('欢迎使用 Moyu.md', '欢迎使用 Moyu'),
    'help.syntax': () => openHelp('Markdown 语法参考.md', 'Markdown 语法参考'),
    'help.shortcuts': showShortcuts,
    'help.pluginGuide': () => openHelp('docs/插件开发指南.md', '插件开发指南'),
    'help.about': showAbout,
    'plugins.manage': () => { closeModals(); openPreferences('plugins'); },
    'plugins.aiPrompt': () => { closeModals(); openAIPrompt(); },
    'plugins.reload': async () => {
      const list = await pluginHost.reload();
      const failed = list.filter((p) => p.enabled && p.error).length;
      toast(`已重新加载插件：${list.filter((p) => p.active).length} 个已启用` + (failed ? `，${failed} 个加载失败` : ''), failed > 0);
      return list;
    },
  };
  ['github', 'newsprint', 'night', 'midnight'].forEach((t) => { COMMANDS['theme.' + t] = () => setSetting({ theme: t }); });
  // 「墨羽蓝调」是一套主题，包含日间与夜间两种外观：选择它时恢复上次使用的那一种
  const MOYU = new Set(['moyu', 'moyu-night']);
  COMMANDS['theme.moyu'] = () => {
    if (MOYU.has(state.settings.theme)) return; // 已经在使用：保持当前的日间 / 夜间
    setSetting({ theme: MOYU.has(state.settings.moyuMode) ? state.settings.moyuMode : 'moyu' });
  };
  COMMANDS['theme.moyuDay'] = () => setSetting({ theme: 'moyu', moyuMode: 'moyu' });
  COMMANDS['theme.moyuNight'] = () => setSetting({ theme: 'moyu-night', moyuMode: 'moyu-night' });
  // 右下角的按钮：在日间与夜间之间切换，并记住选择
  COMMANDS['theme.moyuToggle'] = () => runCommand(state.settings.theme === 'moyu' ? 'theme.moyuNight' : 'theme.moyuDay');

  function closeModals() { $$('.modal-mask').forEach((m) => m.remove()); }

  /** 焦点在查找 / 替换框中，且最近一次操作是替换文档内容（而不是在框中输入） */
  function lastActionWasReplace() {
    const el = document.activeElement;
    return !!el && $('#findbar').contains(el) && find.lastDocEdit > find.lastInputEdit;
  }

  /** 源代码模式撤销 / 重做；完成后焦点留在原来的位置（例如查找框） */
  function sourceHistory(cmd) {
    const back = document.activeElement;
    source.ta.focus();
    document.execCommand(cmd);
    if (back && back !== source.ta && back !== document.body && back.focus) back.focus();
  }

  /** 焦点是否在编辑区以外的输入控件（查找框、替换框等）中 */
  function uiInputFocused() {
    const el = document.activeElement;
    if (!el || el === source.ta || editor.editorEl.contains(el)) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
  }

  function runCommand(cmd, ...args) {
    if (typeof cmd === 'string' && cmd.startsWith('plugin:')) {
      if ($('.modal-mask')) return undefined;
      return pluginHost.execute(cmd, ...args);
    }
    const fn = COMMANDS[cmd];
    if (!fn) { console.warn('unknown command', cmd); return undefined; }
    if ($('.modal-mask') && !/^(file|help|plugins)\./.test(cmd)) {
      // 对话框打开时文档命令不生效，但其中的输入框仍应支持撤销 / 重做 / 全选
      const native = { 'edit.undo': 'undo', 'edit.redo': 'redo', 'edit.selectAll': 'selectAll' }[cmd];
      if (native && uiInputFocused()) document.execCommand(native);
      return undefined;
    }
    // 在查找框等输入框中按 Ctrl+B / Ctrl+1 等不应修改文档
    if (/^(fmt|para)\./.test(cmd) && uiInputFocused()) return undefined;
    return fn(...args);
  }

  /* ======================= 启动 ======================= */

  async function init() {
    api.on('before-close', onBeforeClose);
    state.settings = await api.invoke('settings:get');
    state.info = await api.invoke('app:info');
    state.fonts = await api.invoke('font:list').catch(() => []);
    ZTheme.registerFonts(state.fonts);
    applySettings();
    editor = new BlockEditor($('#write'), $('#content'), {
      md: mdOptionsOf(state.settings),
      onChange,
      onActiveChange: (active) => {
        if (!active) onSelection('');
        if (!$('#findbar').hidden) requestAnimationFrame(highlightRendered);
      },
      onLink,
      onCopy: (t) => api.invoke('app:copyText', t).then(() => toast('已复制代码')),
      onPasteImage,
      onSmartPaste: (e) => (ws ? ws.smartPaste(e) : false),
      onSelection,
    });
    activeTab = newTab();
    tabs.push(activeTab);
    editor.setOptions(Object.assign({ typewriter: state.settings.typewriter, spellcheck: state.settings.spellcheck }, pick(state.settings, EDITOR_KEYS)));

    source = new ZHL.HLTextarea({ className: 'md-source', spellcheck: state.settings.spellcheck, placeholder: '在此输入 Markdown 源码…' });
    const inner = document.createElement('div');
    inner.className = 'source-inner';
    inner.appendChild(source.el);
    $('#source').appendChild(inner);
    source.ta.addEventListener('input', (e) => {
      if (ZHL.autoPairInput(source.ta, e, state.settings)) return; // 已由补全触发的 input 处理
      if (source.findRange) source.setFindRange(null);
      onChange();
      scrollSourceToCaret();
    });
    source.ta.addEventListener('compositionend', (e) => ZHL.autoPairInput(source.ta, e, state.settings));
    source.ta.addEventListener('keydown', (e) => {
      if (ZHL.autoPairKeydown(source.ta, e, state.settings)) { e.preventDefault(); return; }
      if (e.key === 'Tab' && !e.ctrlKey) {
        e.preventDefault();
        document.execCommand('insertText', false, state.settings.insertSpaces ? ' '.repeat(state.settings.tabSize || 4) : '\t');
      }
    });
    source.ta.addEventListener('paste', (e) => {
      const it = Array.from(e.clipboardData.items).find((x) => x.kind === 'file' && /^image\//.test(x.type));
      if (!it) return;
      e.preventDefault();
      onPasteImage(it.getAsFile()).then((t) => { if (t) { source.ta.focus(); document.execCommand('insertText', false, t); } });
    });
    $('#source').addEventListener('click', (e) => { if (e.target === $('#source') || e.target.classList.contains('source-inner')) source.focus(source.value.length); });

    bindSidebar();
    bindTabs();
    $('#moyu-mode').onclick = () => runCommand('theme.moyuToggle');
    bindFind();
    bindDrop();
    $('#sb-sidebar').onclick = () => runCommand('view.sidebar');
    $('#sb-source').onclick = () => runCommand('view.source');
    $('#sb-rich').onclick = () => runCommand('view.rich');
    $('#sb-focus').onclick = () => runCommand('view.focus');
    $('#sb-typewriter').onclick = () => runCommand('view.typewriter');
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#findbar').hidden && !$('.modal-mask')) closeFind();
      // Ctrl+A：编辑框会自行处理这个按键，菜单快捷键收不到，因此在这里转给全选命令
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a' && !uiInputFocused() && !$('.modal-mask')) {
        e.preventDefault();
        runCommand('edit.selectAll');
      }
      // Ctrl+Z / Ctrl+Y：空的编辑框会吞掉按键却无内容可撤销（例如刚清空文档、刚用回车新建段落之后），
      // 菜单快捷键因此收不到；统一转给编辑器自己的撤销 / 重做
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y') && !$('.modal-mask')) {
        e.preventDefault();
        runCommand(e.key.toLowerCase() === 'z' ? 'edit.undo' : 'edit.redo');
      }
      // Ctrl+Tab / Ctrl+Shift+Tab：切换标签页（编辑框会把 Tab 当作缩进，因此在这里先行处理）
      if (e.ctrlKey && !e.altKey && e.key === 'Tab' && !$('.modal-mask')) {
        e.preventDefault();
        e.stopPropagation();
        stepTab(e.shiftKey ? -1 : 1);
        return;
      }
      // Ctrl+Shift+V：编辑框自行完成「粘贴为纯文本」，这里只需告知智能粘贴本次不要转换
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v' && ws) ws.pastePlain();
      // Ctrl+Shift+Z 重做（菜单中重做为 Ctrl+Y，这里补充常见的另一种快捷键）
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        runCommand('edit.redo');
      }
    });
    window.addEventListener('focus', () => { checkExternalChange(); });
    window.addEventListener('blur', saveOnBlur);

    api.on('menu', (cmd) => runCommand(cmd));
    api.on('open-file', (p) => openPath(p));
    api.on('settings-changed', (patch) => {
      const local = {};
      // 窗口自身的界面状态（侧边栏开关、专注模式等）不跨窗口同步
      for (const k of Object.keys(patch)) if (!/^(sidebar|sidebarTab|sidebarWidth|focusMode|typewriter|lastFolder|lastFile|bounds|recentFiles|sessionTabs|sessionActive|docPositions)$/.test(k)) local[k] = patch[k];
      Object.assign(state.settings, local);
      if (Object.keys(local).length) applySettings(local);
    });

    // 插件在打开首个文档前激活，以便其语法扩展作用于首屏渲染
    pluginHost = new ZPluginHost({
      api,
      bus,
      state,
      version: state.info.version,
      get editor() { return editor; },
      toast,
      promptText,
      showModal,
      runCommand,
      getText,
      setText,
      isDirty,
      docName,
      countWords,
      getSelection,
      insertMarkdown,
      insertBlock,
      renderMarkdown,
      addStyle,
      addStatusItem,
      addSidebarPanel,
      getHeadings: () => (state.sourceMode ? headingsOf(source.value) : editor.computeHeadings()),
      getTheme: () => ({ name: state.settings.theme, dark: DARK.has(state.settings.theme) }),
      onMarkdownChanged: () => { editor.rebuildMd(); refreshDerived(); },
    });
    await pluginHost.load();

    extras = ZExtras.init({
      api, state, toast, showModal, runCommand, openPath, setText, getText, docName, renderMarkdown, setSetting,
      editor: () => editor,
      headings: () => (state.sourceMode ? headingsOf(source.value) : editor.computeHeadings()),
      gotoHeading: (h) => scrollToHeading(h.id, h.line),
      focusEditor: () => { if (state.sourceMode) source.focus(); else editor.focusEditor(); },
      pluginCommands: () => [...pluginHost.commands.values()].map((c) => Object.assign({}, c, { pluginName: (pluginHost.records.get(c.pluginId) || { manifest: {} }).manifest.name || c.pluginId })),
    });
    editor.editorEl.addEventListener('keydown', (e) => extras.slashKeydown(e), true);
    $('#sb-update').onclick = () => extras.updateBadgeClick();
    ws = ZWorkspace.init({
      api, state, toast, showModal, promptText, runCommand, openPath, loadText, loadFolder, getText, isDirty, docName, setSetting,
      getSelection, renderMarkdown, onLink, revealAt, relocatePath, detachPath, openDoc, tabsOn, recoveryDocs, tabMenu, source,
      editor: () => editor,
      focusEditor: () => { if (state.sourceMode) source.focus(); else editor.focusEditor(); },
      openLightbox: (src, alt) => extras.openLightbox(src, alt),
    });
    api.on('plugins-changed', () => pluginHost.reload().then(refreshPluginPane));

    const initial = await api.invoke('win:initial');
    state.selfTest = initial.selfTest;
    const startup = initial.startup ? state.settings.startupAction : 'new'; // 「新建窗口」总是打开空白文档
    if (initial.file) await openPath(initial.file, { force: true, skipConfirm: true });
    else if (initial.firstRun || startup === 'welcome') await openHelp('欢迎使用 Moyu.md', '欢迎使用 Moyu');
    else if (startup === 'restoreLast' && (await restoreSession())) { /* 已恢复上次打开的标签页 */ } else loadText('', {});
    if (state.settings.lastFolder) loadFolder(state.settings.lastFolder); else renderTree(null);

    // 启动后自动检查更新：结果显示在状态栏，发现新版本时弹窗询问（只在程序启动时的首个窗口检查）
    if (!state.selfTest && initial.startup && state.settings.autoCheckUpdate) setTimeout(() => extras.checkUpdate(true), 2500);
    // 上次没有正常退出时，提示恢复未保存的内容（只在程序启动时的首个窗口检查）
    if (!state.selfTest && initial.startup) ws.showRecovery(false);
    // 供自检脚本使用
    window.__zmark = { tabs: { list: () => tabs.map((t) => ({ id: t.id, name: tabName(t), path: tabPath(t), dirty: tabDirty(t), active: t === activeTab })), get: tabById, switchTo: (i) => switchTab(tabs[i]), close: (i) => closeTab(i === undefined ? activeTab : tabs[i]), closeAll: () => closeTabs(tabs.slice()), step: stepTab, move: (from, before) => moveTab(tabs[from], before === null ? null : tabs[before]), reopen: reopenClosedTab, menu: (i) => tabMenu(tabs[i].id), confirmAll: confirmAllTabs, restoreSession }, newDoc, ws, docName, openPreferences, exportDoc, extras, refreshFonts, editor, source, state, runCommand, openPath, loadText, getText, isDirty, save, buildExportHtml, find, countWords, loadFolder, toggleSource, insertImages, uploadAllLocal, setSetting, openPreferences, resetSettings, plugins: pluginHost, bus };
    document.body.dataset.ready = '1';
    hideSplash();
  }

  /** 开启动画：编辑器就绪且至少展示约 1.1 秒后淡出并移除 */
  function hideSplash(immediate) {
    const el = document.getElementById('splash');
    if (!el || !window.__splash) { if (el) el.remove(); return; }
    const wait = immediate ? 0 : Math.max(0, 1100 - (performance.now() - window.__splash.start));
    setTimeout(() => {
      el.classList.add('splash-leave');
      setTimeout(() => { el.remove(); document.documentElement.classList.remove('splash-on'); window.__splash.done = true; }, 480);
    }, wait);
  }

  init().catch((e) => {
    console.error(e);
    hideSplash(true);
    document.body.innerHTML = `<pre style="padding:20px;color:#d1242f">Moyu 启动失败：\n${esc(e.stack || e.message)}</pre>`;
  });
})();
