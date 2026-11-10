/* Moyu — 插件宿主（渲染进程）
 *
 * 插件 = 插件目录下的一个文件夹：plugin.json（清单） + 入口脚本（默认 main.js）。
 * 入口脚本在加载时同步调用 Moyu.definePlugin({ activate(ctx) {...}, deactivate() {...} })。
 * ctx 是插件能使用的全部接口，见 docs/插件开发指南.md。
 */
/* global ZMD */
(function () {
  'use strict';

  const API_VERSION = 1;
  const ACTIVATE_TIMEOUT = 5000;
  const pending = new Map(); // 正在加载的插件 id → 定义

  window.Moyu = Object.freeze({
    apiVersion: API_VERSION,
    /** 插件入口：必须在脚本加载时同步调用 */
    definePlugin(def) {
      const s = document.currentScript;
      const id = s && s.dataset.pluginId;
      if (!id) throw new Error('Moyu.definePlugin() 必须在插件入口脚本加载时同步调用');
      if (!def || typeof def.activate !== 'function') throw new Error('插件定义缺少 activate(ctx) 函数');
      pending.set(id, def);
    },
  });
  window.ZMark = window.Moyu; // 软件曾名 ZMark：保留旧名，已有插件无需修改

  const toDisposer = (d) => {
    if (typeof d === 'function') return d;
    if (d && typeof d.dispose === 'function') return () => d.dispose();
    return () => {};
  };
  const errMsg = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  class PluginHost {
    /** app：应用外壳暴露给宿主的能力（见 app.js 中的 hostApp） */
    constructor(app) {
      this.app = app;
      this.records = new Map(); // id → { manifest, active, error, def, ctx, disposers, store }
      this.commands = new Map(); // 'plugin:<id>:<cmd>' → { pluginId, title, accelerator, handler }
      this.scripts = [];
      this._mdDirty = false;
      this._menuTimer = 0;
      this._loading = null;
    }

    /** 扫描并激活所有已启用的插件 */
    load() {
      if (!this._loading) this._loading = this._load().finally(() => { this._loading = null; });
      return this._loading;
    }

    async _load() {
      let list = [];
      try { list = await this.app.api.invoke('plugins:list'); } catch (e) { console.warn('[插件] 读取插件列表失败', e); }
      this._batch = true;
      for (const m of list) {
        const rec = { manifest: m, id: m.id, active: false, error: m.error || null, def: null, ctx: null, disposers: [], store: {} };
        this.records.set(m.id, rec);
        if (!m.enabled || rec.error) continue;
        if (m.apiVersion > API_VERSION) { rec.error = `需要插件接口版本 ${m.apiVersion}，当前 Moyu 支持 ${API_VERSION}`; continue; }
        try {
          rec.store = (await this.app.api.invoke('plugins:storageGet', m.id)) || {};
          await this.loadScript(m);
          const def = pending.get(m.id);
          pending.delete(m.id);
          if (!def) throw new Error('入口脚本没有调用 Moyu.definePlugin()');
          rec.def = def;
          rec.ctx = this.createContext(rec);
          await Promise.race([
            Promise.resolve(def.activate(rec.ctx)),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`activate() 超过 ${ACTIVATE_TIMEOUT / 1000} 秒未完成`)), ACTIVATE_TIMEOUT)),
          ]);
          rec.active = true;
        } catch (e) {
          rec.error = errMsg(e);
          console.warn(`[插件 ${m.id}] 激活失败：`, e);
          this.disposeRecord(rec);
        }
      }
      this._batch = false;
      this.flush(true);
      return this.list();
    }

    /** 以 <script> 方式加载入口；捕获脚本中的语法错误 / 顶层异常 */
    loadScript(m) {
      return new Promise((resolve, reject) => {
        const el = document.createElement('script');
        const src = m.mainUrl + '?v=' + Date.now();
        let scriptError = null;
        const onErr = (ev) => {
          if (ev.filename && ev.filename.split('?')[0] === m.mainUrl) {
            scriptError = ev.error || new Error(ev.message);
            ev.preventDefault();
          }
        };
        window.addEventListener('error', onErr);
        const done = (err) => {
          window.removeEventListener('error', onErr);
          if (err || scriptError) reject(err || scriptError); else resolve();
        };
        el.src = src;
        el.dataset.pluginId = m.id;
        el.onload = () => done();
        el.onerror = () => done(new Error('无法加载入口脚本 ' + m.main));
        document.head.appendChild(el);
        this.scripts.push(el);
      });
    }

    /** 停用所有插件并清理它们注册的一切 */
    async unload() {
      this._batch = true;
      for (const rec of this.records.values()) {
        if (rec.active && rec.def && typeof rec.def.deactivate === 'function') {
          try { await rec.def.deactivate(); } catch (e) { console.warn(`[插件 ${rec.id}] deactivate 出错`, e); }
        }
        this.disposeRecord(rec);
      }
      this.records.clear();
      this.scripts.forEach((s) => s.remove());
      this.scripts = [];
      this._batch = false;
      this.flush(true);
    }

    async reload() {
      if (this._loading) await this._loading;
      await this.unload();
      return this.load();
    }

    disposeRecord(rec) {
      const list = rec.disposers.splice(0).reverse();
      for (const fn of list) {
        try { fn(); } catch (e) { console.warn(`[插件 ${rec.id}] 清理出错`, e); }
      }
      rec.active = false;
    }

    list() {
      return [...this.records.values()].map((r) => Object.assign({}, r.manifest, {
        active: r.active,
        error: r.error,
        commands: [...this.commands.values()].filter((c) => c.pluginId === r.id).map((c) => c.title),
      }));
    }

    async execute(key, ...args) {
      const cmd = this.commands.get(key);
      if (!cmd) { this.app.toast('插件命令不可用：' + key, true); return undefined; }
      try {
        return await cmd.handler(...args);
      } catch (e) {
        console.warn(`[插件 ${cmd.pluginId}] 命令 ${key} 出错`, e);
        this.app.toast(`插件命令「${cmd.title}」出错：${errMsg(e)}`, true);
        return undefined;
      }
    }

    markMdDirty() {
      this._mdDirty = true;
      if (!this._batch) this.flush();
    }

    scheduleMenu() {
      if (this._batch) return;
      clearTimeout(this._menuTimer);
      this._menuTimer = setTimeout(() => this.sendMenu(), 30);
    }

    sendMenu() {
      const items = [...this.commands.values()].map((c) => ({
        key: c.key,
        pluginId: c.pluginId,
        pluginName: (this.records.get(c.pluginId) || { manifest: {} }).manifest.name || c.pluginId,
        title: c.title,
        accelerator: c.accelerator,
      }));
      return this.app.api.invoke('plugins:setMenu', items).catch(() => {});
    }

    /** 批量操作结束后：重建 markdown 渲染器、刷新菜单 */
    flush(force) {
      if (this._mdDirty) {
        this._mdDirty = false;
        this.app.onMarkdownChanged();
      }
      if (force) this.sendMenu(); else this.scheduleMenu();
    }

    /* ======================= 插件上下文 ctx ======================= */

    createContext(rec) {
      const host = this;
      const app = this.app;
      const id = rec.id;
      const m = rec.manifest;
      const track = (d) => {
        const fn = toDisposer(d);
        let done = false;
        const once = () => { if (done) return; done = true; const i = rec.disposers.indexOf(once); if (i >= 0) rec.disposers.splice(i, 1); fn(); };
        rec.disposers.push(once);
        return { dispose: once };
      };
      const removeFrom = (arr, item) => () => { const i = arr.indexOf(item); if (i >= 0) arr.splice(i, 1); };
      let saveTimer = 0;
      const persist = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => app.api.invoke('plugins:storageSet', id, rec.store).catch((e) => console.warn(`[插件 ${id}] 保存数据失败`, e)), 300);
      };
      track(() => { if (saveTimer) { clearTimeout(saveTimer); app.api.invoke('plugins:storageSet', id, rec.store).catch(() => {}); } });

      const ctx = {
        id,
        apiVersion: API_VERSION,
        appVersion: app.version,
        manifest: Object.freeze(Object.assign({}, m)),
        /** 插件目录内资源的 URL */
        asset: (rel) => new URL(rel, m.baseUrl).href,
        /** 加载插件目录内的其它脚本 */
        loadScript(rel) {
          return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = new URL(rel, m.baseUrl).href;
            el.onload = resolve;
            el.onerror = () => reject(new Error('无法加载 ' + rel));
            document.head.appendChild(el);
            host.scripts.push(el);
          });
        },
        log: (...a) => console.log(`[${id}]`, ...a),
        /** 注册在插件停用时执行的清理函数 */
        onDispose: (fn) => track(fn),

        commands: {
          register(cmdId, handler, opts) {
            opts = opts || {};
            if (!/^[\w.-]+$/.test(cmdId)) throw new Error('命令 id 只能包含字母、数字、_ . -');
            if (typeof handler !== 'function') throw new Error('命令处理函数必须是函数');
            const key = `plugin:${id}:${cmdId}`;
            host.commands.set(key, { key, pluginId: id, title: opts.title || cmdId, accelerator: opts.accelerator || null, handler });
            host.scheduleMenu();
            return track(() => { host.commands.delete(key); host.scheduleMenu(); });
          },
          /** 执行内置命令（如 'fmt.bold'）或插件命令（'plugin:<id>:<cmd>'） */
          execute: (cmd, ...args) => app.runCommand(cmd, ...args),
        },

        markdown: {
          /** 注册 markdown-it 插件：fn(md, ...args) */
          use(fn, ...args) {
            const entry = { fn, args };
            ZMD.registry.uses.push(entry);
            host.markMdDirty();
            return track(() => { removeFrom(ZMD.registry.uses, entry)(); host.markMdDirty(); });
          },
          /** 自定义代码块语言：render(code, info) 返回 HTML（会经过安全净化） */
          addFence(lang, render) {
            const key = String(lang).toLowerCase();
            ZMD.registry.fences.set(key, render);
            host.markMdDirty();
            return track(() => { if (ZMD.registry.fences.get(key) === render) ZMD.registry.fences.delete(key); host.markMdDirty(); });
          },
          /** 每次渲染后对 DOM 进行处理（需幂等） */
          onRender(fn) {
            ZMD.registry.post.push(fn);
            return track(removeFrom(ZMD.registry.post, fn));
          },
          /** 文档样式：同时作用于编辑器和导出的 HTML / PDF */
          addStyle: (css) => track(app.addStyle(css, true, id)),
          parse(text) {
            const env = {};
            const tokens = app.editor.md.parse(text, env);
            return { tokens, env };
          },
          render: (text) => app.renderMarkdown(text),
        },

        editor: {
          getMarkdown: () => app.getText(),
          setMarkdown: (text) => app.setText(String(text)),
          getSelection: () => app.getSelection(),
          replaceSelection: (text) => app.insertMarkdown(String(text)),
          insertText: (text) => app.insertMarkdown(String(text)),
          /** 在当前块之后插入一个块，caret 为光标在新块中的位置 */
          insertBlock: (text, caret) => app.insertBlock(String(text), caret),
          getHeadings: () => app.getHeadings(),
          isSourceMode: () => app.state.sourceMode,
        },

        workspace: {
          getFilePath: () => app.state.filePath,
          getFileName: () => app.docName(),
          getBaseDir: () => app.state.baseDir,
          isDirty: () => app.isDirty(),
          onDidChange: (fn) => track(app.bus.on('change', fn)),
          onDidOpen: (fn) => track(app.bus.on('open', fn)),
          /** 保存前回调：返回字符串则替换要保存的内容 */
          onWillSave: (fn) => track(app.bus.on('willSave', fn)),
          onDidSave: (fn) => track(app.bus.on('save', fn)),
          onThemeChange: (fn) => track(app.bus.on('theme', fn)),
        },

        ui: {
          toast: (msg, isError) => app.toast(String(msg), !!isError),
          prompt: (title, value, placeholder) => app.promptText(title, value, placeholder),
          showModal: (html, onMount) => app.showModal(html, onMount),
          /** 界面样式（不进入导出文件） */
          addStyle: (css) => track(app.addStyle(css, false, id)),
          addStatusItem(opts) {
            const item = app.addStatusItem(id, opts || {});
            const t = track(item.remove);
            return { el: item.el, setText: item.setText, setTitle: item.setTitle, setVisible: item.setVisible, dispose: t.dispose };
          },
          addSidebarPanel(opts) {
            opts = opts || {};
            if (!/^[\w-]+$/.test(opts.id || '')) throw new Error('侧边栏面板需要合法的 id');
            const panel = app.addSidebarPanel(`plugin-${id}-${opts.id}`, opts);
            const t = track(panel.remove);
            return { el: panel.el, show: panel.show, isVisible: panel.isVisible, dispose: t.dispose };
          },
          getTheme: () => app.getTheme(),
        },

        storage: {
          get: (key, def) => (Object.prototype.hasOwnProperty.call(rec.store, key) ? rec.store[key] : def),
          set: (key, value) => { rec.store[key] = value; persist(); },
          delete: (key) => { delete rec.store[key]; persist(); },
          all: () => Object.assign({}, rec.store),
        },

        utils: {
          countWords: (text) => app.countWords(String(text)),
          escapeHtml: (s) => ZMD.escapeHtml(s),
          debounce: (fn, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; },
        },
      };
      return Object.freeze(ctx);
    }
  }

  window.ZPluginHost = PluginHost;
})();
