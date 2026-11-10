/* 提示块 Callout —— Moyu 语法扩展示例插件
 *
 *   > [!NOTE]
 *   > 这是一条说明。
 *
 *   > [!WARNING] 自定义标题
 *   > 标题写在标记后面即可。
 *
 * 演示的插件接口：ctx.markdown.use（markdown-it 插件）、ctx.markdown.addStyle（导出时保留的文档样式）、
 * ctx.commands.register（菜单命令与快捷键）、ctx.editor.insertBlock。
 */
/* global Moyu */
Moyu.definePlugin({
  activate(ctx) {
    const TYPES = {
      note: { title: '说明', icon: 'ℹ' },
      tip: { title: '提示', icon: '💡' },
      important: { title: '重要', icon: '❗' },
      warning: { title: '警告', icon: '⚠' },
      caution: { title: '注意', icon: '⛔' },
    };
    const MARK = /^\[!(note|tip|important|warning|caution)\][ \t]*(.*)$/i;
    const esc = ctx.utils.escapeHtml;

    /** markdown-it 插件：把以 [!TYPE] 开头的引用块改写为提示块 */
    function calloutPlugin(md) {
      md.core.ruler.after('inline', 'zmark_callout', (state) => {
        const t = state.tokens;
        for (let i = 0; i < t.length - 2; i++) {
          if (t[i].type !== 'blockquote_open' || t[i + 1].type !== 'paragraph_open' || t[i + 2].type !== 'inline') continue;
          const inline = t[i + 2];
          const firstLine = inline.content.split('\n', 1)[0];
          const m = MARK.exec(firstLine.trim());
          if (!m) continue;
          const type = m[1].toLowerCase();
          const info = TYPES[type];
          t[i].attrJoin('class', `callout callout-${type}`);

          // 去掉段落第一行（标记行），剩余内容保留为正文
          const kids = inline.children || [];
          const br = kids.findIndex((k) => k.type === 'softbreak' || k.type === 'hardbreak');
          const titleTok = new state.Token('html_block', '', 0);
          titleTok.level = t[i + 1].level;
          // data-md：纯文本模式下把提示块还原为 Markdown 时使用的原始标记
          titleTok.content = `<div class="callout-title" data-md="${esc(firstLine.trim())}"><span class="callout-icon">${info.icon}</span>${esc(m[2].trim() || info.title)}</div>\n`;
          if (br >= 0) {
            inline.children = kids.slice(br + 1);
            inline.content = inline.content.slice(inline.content.indexOf('\n') + 1);
            t.splice(i + 1, 0, titleTok);
          } else {
            t.splice(i + 1, 3, titleTok); // 只有标记行：移除整个段落
          }
        }
      });
    }

    ctx.markdown.use(calloutPlugin);

    ctx.markdown.addStyle(`
      .markdown-body blockquote.callout {
        --callout: #0969da;
        color: var(--text);
        border-left: 4px solid var(--callout);
        background: color-mix(in srgb, var(--callout) 8%, transparent);
        border-radius: 0 6px 6px 0;
        padding: 0.55em 1em 0.6em;
      }
      .markdown-body blockquote.callout > p { margin: 0.3em 0; }
      .markdown-body .callout-title { display: flex; align-items: center; gap: 0.45em; font-weight: 600; color: var(--callout); margin: 0.1em 0 0.25em; }
      .markdown-body .callout-icon { font-size: 0.95em; width: 1.2em; text-align: center; }
      .markdown-body blockquote.callout-tip { --callout: #1a7f37; }
      .markdown-body blockquote.callout-important { --callout: #8250df; }
      .markdown-body blockquote.callout-warning { --callout: #9a6700; }
      .markdown-body blockquote.callout-caution { --callout: #cf222e; }
      body:is([data-theme="night"], [data-theme="midnight"]) .markdown-body blockquote.callout-note { --callout: #4493f8; }
      body:is([data-theme="night"], [data-theme="midnight"]) .markdown-body blockquote.callout-tip { --callout: #3fb950; }
      body:is([data-theme="night"], [data-theme="midnight"]) .markdown-body blockquote.callout-important { --callout: #ab7df8; }
      body:is([data-theme="night"], [data-theme="midnight"]) .markdown-body blockquote.callout-warning { --callout: #d29922; }
      body:is([data-theme="night"], [data-theme="midnight"]) .markdown-body blockquote.callout-caution { --callout: #f85149; }
    `);

    for (const [type, info] of Object.entries(TYPES)) {
      const head = `> [!${type.toUpperCase()}]\n> `;
      ctx.commands.register(`insert-${type}`, () => ctx.editor.insertBlock(head, head.length), {
        title: `插入「${info.title}」提示块`,
        accelerator: type === 'note' ? 'CmdOrCtrl+Alt+N' : undefined,
      });
    }
  },
});
