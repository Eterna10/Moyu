/* 写作目标 —— Moyu 示例插件
 *
 * 演示的插件接口：
 *   ctx.ui.addStatusItem      状态栏项
 *   ctx.ui.addSidebarPanel    侧边栏面板
 *   ctx.ui.addStyle / prompt / toast
 *   ctx.commands.register     命令（出现在「插件」菜单，可带快捷键）
 *   ctx.workspace.onDidChange / onDidOpen / onThemeChange   事件
 *   ctx.storage               插件私有的持久化数据
 *   ctx.markdown.parse        用 Moyu 的解析器分析文档结构
 */
/* global Moyu */
Moyu.definePlugin({
  activate(ctx) {
    const { ui, workspace, editor, storage, utils, commands } = ctx;
    const esc = utils.escapeHtml;
    const IDLE = 2 * 60 * 1000; // 两次输入间隔超过 2 分钟视为休息

    const dayKey = (d) => {
      d = d || new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const history = storage.get('history', {}); // 日期 → 当日净增字数
    let goal = storage.get('goal', 1000);
    const wordsOf = () => utils.countWords(editor.getMarkdown()).total;
    let last = wordsOf();
    const session = { active: 0, lastEdit: 0, words: 0 };

    const today = () => history[dayKey()] || 0;

    function save() {
      const keys = Object.keys(history).sort();
      while (keys.length > 120) delete history[keys.shift()]; // 只保留最近 120 天
      storage.set('history', history);
    }

    /* ---------- 样式 ---------- */
    ui.addStyle(`
      .wg { padding: 6px 8px 20px; font-size: 13px; color: var(--sidebar-text); }
      .wg h4 { margin: 18px 0 8px; font-size: 12px; color: var(--muted); font-weight: 600; letter-spacing: .04em; }
      .wg-ring { display: flex; justify-content: center; margin: 4px 0 2px; }
      .wg-ring svg { width: 150px; height: 150px; }
      .wg-ring .track { stroke: var(--border); }
      .wg-ring .bar { stroke: var(--accent); transition: stroke-dashoffset .4s; }
      .wg-ring .done { stroke: #2da44e; }
      .wg-ring .num { font-size: 26px; font-weight: 700; fill: var(--heading); }
      .wg-ring .sub { font-size: 12px; fill: var(--muted); }
      .wg-goal { text-align: center; color: var(--muted); font-size: 12px; }
      .wg-row { display: flex; justify-content: space-between; padding: 4px 2px; }
      .wg-row b { font-weight: 600; color: var(--text); }
      .wg-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .wg-cell { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
      .wg-cell b { display: block; font-size: 16px; color: var(--text); }
      .wg-cell span { font-size: 11px; color: var(--muted); }
      .wg-chart svg { width: 100%; height: 110px; overflow: visible; }
      .wg-chart rect { fill: var(--accent); opacity: .75; }
      .wg-chart rect.today { opacity: 1; }
      .wg-chart rect.hit { fill: #2da44e; }
      .wg-chart text { font-size: 10px; fill: var(--muted); text-anchor: middle; }
      .wg-chart line { stroke: var(--muted); stroke-dasharray: 3 3; }
      .wg-actions { display: flex; gap: 6px; margin-top: 16px; }
      .wg-actions button { flex: 1; height: 28px; border-radius: 5px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px; }
      .wg-actions button:hover { border-color: var(--accent); color: var(--accent); }
    `);

    /* ---------- 状态栏 ---------- */
    const status = ui.addStatusItem({ title: '写作目标 —— 点击查看写作统计', onClick: () => panel.show() });

    /* ---------- 侧边栏面板 ---------- */
    const panel = ui.addSidebarPanel({ id: 'stats', title: '统计', onShow: () => renderPanel() });
    panel.el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'goal') setGoal();
      if (act && act.dataset.act === 'reset') resetToday();
    });

    /** 用 Moyu 自己的 Markdown 解析器统计文档结构 */
    function docStats() {
      const text = editor.getMarkdown();
      const c = utils.countWords(text);
      const s = { words: c.total, chars: c.chars, paragraphs: 0, headings: 0, images: 0, links: 0, code: 0, tables: 0, math: 0 };
      const walk = (tokens) => {
        for (const t of tokens) {
          if (t.type === 'paragraph_open') s.paragraphs++;
          else if (t.type === 'heading_open') s.headings++;
          else if (t.type === 'image') s.images++;
          else if (t.type === 'link_open') s.links++;
          else if (t.type === 'fence' || t.type === 'code_block') s.code++;
          else if (t.type === 'table_open') s.tables++;
          else if (t.type === 'math_block' || t.type === 'math_inline') s.math++;
          if (t.children) walk(t.children);
        }
      };
      walk(ctx.markdown.parse(text).tokens);
      s.minutes = Math.max(1, Math.round(c.cjk / 400 + c.words / 220));
      return s;
    }

    function ring(value, total) {
      const r = 60;
      const len = 2 * Math.PI * r;
      const pct = total > 0 ? Math.min(1, value / total) : 0;
      return `<svg viewBox="0 0 150 150" role="img" aria-label="今日进度 ${Math.round(pct * 100)}%">
        <circle class="track" cx="75" cy="75" r="${r}" fill="none" stroke-width="10"/>
        <circle class="bar${pct >= 1 ? ' done' : ''}" cx="75" cy="75" r="${r}" fill="none" stroke-width="10" stroke-linecap="round"
          stroke-dasharray="${len}" stroke-dashoffset="${len * (1 - pct)}" transform="rotate(-90 75 75)"/>
        <text class="num" x="75" y="78" text-anchor="middle">${Math.round(pct * 100)}%</text>
        <text class="sub" x="75" y="100" text-anchor="middle">${value} / ${total} 字</text>
      </svg>`;
    }

    function chart() {
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        days.push({ key: dayKey(d), label: i === 0 ? '今天' : `${d.getMonth() + 1}/${d.getDate()}`, value: history[dayKey(d)] || 0 });
      }
      const max = Math.max(goal, ...days.map((d) => d.value), 1);
      const W = 238;
      const H = 90;
      const bw = 22;
      const step = W / 7;
      const goalY = H - (goal / max) * H;
      const bars = days.map((d, i) => {
        const h = Math.max(d.value > 0 ? 2 : 0, (d.value / max) * H);
        const x = i * step + (step - bw) / 2;
        return `<rect class="${i === 6 ? 'today' : ''}${d.value >= goal ? ' hit' : ''}" x="${x}" y="${H - h}" width="${bw}" height="${h}" rx="3"><title>${d.key}：${d.value} 字</title></rect>` +
          `<text x="${x + bw / 2}" y="${H + 14}">${d.label}</text>`;
      }).join('');
      return `<svg viewBox="0 0 ${W} ${H + 18}" preserveAspectRatio="none">${bars}<line x1="0" x2="${W}" y1="${goalY}" y2="${goalY}"><title>目标 ${goal} 字</title></line></svg>`;
    }

    function renderPanel() {
      if (!panel.isVisible()) return;
      const s = docStats();
      const mins = Math.round(session.active / 60000);
      const speed = mins > 0 ? Math.round(Math.max(0, session.words) / mins) : 0;
      const cell = (v, label) => `<div class="wg-cell"><b>${v}</b><span>${label}</span></div>`;
      panel.el.innerHTML = `<div class="wg">
        <div class="wg-ring">${ring(today(), goal)}</div>
        <div class="wg-goal">每日目标 ${goal} 字${today() >= goal ? ' · 已完成 🎉' : ''}</div>
        <h4>本次写作</h4>
        <div class="wg-row"><span>写作时长</span><b>${mins} 分钟</b></div>
        <div class="wg-row"><span>净增字数</span><b>${session.words}</b></div>
        <div class="wg-row"><span>平均速度</span><b>${speed} 字/分钟</b></div>
        <h4>当前文档 · ${esc(workspace.getFileName())}</h4>
        <div class="wg-grid">
          ${cell(s.words, '字数')}${cell(s.chars, '字符')}
          ${cell(s.paragraphs, '段落')}${cell(s.headings, '标题')}
          ${cell(s.images, '图片')}${cell(s.links, '链接')}
          ${cell(s.code, '代码块')}${cell(s.tables, '表格')}
          ${cell(s.math, '公式')}${cell(s.minutes + ' 分钟', '阅读时长')}
        </div>
        <h4>最近 7 天</h4>
        <div class="wg-chart">${chart()}</div>
        <div class="wg-actions"><button data-act="goal">设置目标</button><button data-act="reset">重置今日</button></div>
      </div>`;
    }

    function refresh() {
      const t = today();
      const pct = goal > 0 ? Math.min(100, Math.round((t / goal) * 100)) : 0;
      status.setText(`🎯 今日 ${t} / ${goal}`);
      status.setTitle(`今日已写 ${t} 字，目标 ${goal} 字（${pct}%）—— 点击查看写作统计`);
      renderPanel();
    }

    function checkGoal() {
      const key = dayKey();
      if (today() >= goal && storage.get('celebrated') !== key) {
        storage.set('celebrated', key);
        ui.toast(`🎉 已完成今日写作目标：${goal} 字！`);
      }
    }

    async function setGoal() {
      const v = await ui.prompt('每日写作目标（字）', String(goal), '例如 1000');
      if (v === null) return;
      const n = parseInt(v, 10);
      if (!(n > 0 && n <= 1000000)) { ui.toast('请输入 1 ~ 1000000 之间的整数', true); return; }
      goal = n;
      storage.set('goal', goal);
      refresh();
      checkGoal();
    }

    function resetToday() {
      history[dayKey()] = 0;
      session.words = 0;
      save();
      refresh();
    }

    /* ---------- 事件 ---------- */
    workspace.onDidOpen(() => { last = wordsOf(); refresh(); }); // 打开文档不计入写作量
    workspace.onDidChange(() => {
      const now = wordsOf();
      const delta = now - last;
      last = now;
      if (delta !== 0) {
        const key = dayKey();
        history[key] = Math.max(0, (history[key] || 0) + delta);
        session.words += delta;
        const t = Date.now();
        if (session.lastEdit && t - session.lastEdit < IDLE) session.active += t - session.lastEdit;
        session.lastEdit = t;
        save();
        checkGoal();
      }
      refresh();
    });
    workspace.onThemeChange(() => renderPanel());

    /* ---------- 命令（「插件 → 写作目标」菜单） ---------- */
    commands.register('show', () => panel.show(), { title: '显示写作统计', accelerator: 'CmdOrCtrl+Alt+W' });
    commands.register('set-goal', setGoal, { title: '设置每日目标…' });
    commands.register('reset-today', resetToday, { title: '重置今日字数' });

    const timer = setInterval(refresh, 30000); // 跨过零点时刷新
    ctx.onDispose(() => clearInterval(timer));
    refresh();
  },
});
