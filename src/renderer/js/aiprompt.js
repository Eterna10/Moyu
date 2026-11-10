/* Moyu — 「一键提示词」：生成交给 AI 工具编写 Moyu 插件的完整提示词
 * 内容依据插件宿主（js/plugins.js）的实际实现编写；内置命令列表取自命令面板的命令表，随软件自动更新。
 */
/* global ZExtras */
(function () {
  'use strict';

  const PLACEHOLDER = '（在这里用自己的话描述想要的功能：做什么、在哪里触发、界面长什么样、需要记住哪些数据。描述越具体，生成的插件越准确。）';

  /** 根据功能描述生成提示词 */
  function build(feature, info) {
    info = info || {};
    const want = String(feature || '').trim() || PLACEHOLDER;
    const commands = (window.ZExtras && ZExtras.COMMANDS ? ZExtras.COMMANDS : [])
      .map(([id, label]) => `${id}（${label}）`).join('、');
    return `# 任务

你是一名熟悉 JavaScript、DOM 与 markdown-it 的前端工程师。请为桌面 Markdown 编辑器 **Moyu**（版本 ${info.version || '1.6'}，插件接口 apiVersion = ${info.apiVersion || 1}）编写一个插件，实现下面「我想要的功能」。请严格遵守本文描述的运行环境与接口，不要使用文中没有列出的接口。

# 我想要的功能

${want}

# 一、插件的形式

一个插件就是一个文件夹，放在用户插件目录 \`%APPDATA%\\Moyu\\plugins\\<文件夹名>\\\` 下，包含：

1. \`plugin.json\`（清单，必需）：
\`\`\`json
{
  "id": "my-plugin",
  "name": "插件显示名称",
  "version": "1.0.0",
  "description": "一句话说明插件做什么",
  "author": "作者",
  "main": "main.js",
  "apiVersion": 1
}
\`\`\`
   - \`id\` 必须匹配正则 \`^[a-z0-9][a-z0-9._-]{0,63}$\`，全局唯一；命令 id、私有数据都以它区分。
   - \`main\` 是入口脚本，相对插件文件夹，必须位于插件文件夹内。
2. \`main.js\`（入口脚本）：普通浏览器脚本（不是 ES Module，不能 \`import\` / \`export\` / \`require\`），由 Moyu 以 \`<script>\` 标签加载。
3. 可选的其它资源（图片、额外脚本），通过 \`ctx.asset()\`、\`ctx.loadScript()\` 使用。

# 二、运行环境与硬性约束

- 运行在 Electron 渲染进程（Chromium，支持现代 ES2023 语法），开启了 contextIsolation 与 sandbox：**没有 Node.js**（无 \`require\`、\`fs\`、\`process\`），不能直接读写文件，只能使用下面列出的 \`ctx\` 接口和浏览器标准 API。
- 入口脚本必须在加载时**同步**调用一次 \`Moyu.definePlugin({ activate(ctx) {…}, deactivate() {…} })\`（\`ZMark.definePlugin\` 是兼容旧名）。不要放在 \`setTimeout\`、\`await\` 或事件回调里调用。
- \`activate(ctx)\` 可以是 async 函数，但必须在 **5 秒**内完成；抛出的异常只会让本插件显示为「加载失败」，不影响编辑器。
- 通过 \`ctx\` 注册的一切（命令、样式、状态栏项、侧边栏面板、事件监听、markdown 扩展）在插件停用或「重新加载插件」时都会**自动撤销**；自己创建的定时器、全局事件监听、追加到页面的 DOM 节点，必须用 \`ctx.onDispose(fn)\` 登记清理，否则重新加载后会重复。
- 不要修改 Moyu 自身的 DOM 结构或全局对象（\`window.Moyu\`、\`window.zmark\` 等），只通过 \`ctx\` 扩展。
- 插件输出到文档中的 HTML（\`addFence\`、markdown-it 渲染规则）会经过 **DOMPurify 净化**：\`<script>\`、\`<style>\`、\`<iframe>\`、\`<form>\`、\`on*\` 事件属性、\`javascript:\` 链接都会被移除；\`class\`、\`style\` 属性、\`data-*\` 属性、SVG 可以正常使用。交互逻辑请放在 \`ctx.markdown.onRender\` 中给 DOM 绑定事件。
- \`ui.showModal\` 的 HTML **不会**被净化：插入任何用户内容或文档内容前，必须用 \`ctx.utils.escapeHtml()\` 转义。
- 界面文字使用简体中文。颜色只用主题 CSS 变量，以便自动适配四套主题（GitHub、Newsprint、Night、Midnight）：
  \`--bg\`、\`--bg-soft\`、\`--text\`、\`--text-soft\`、\`--muted\`、\`--border\`、\`--accent\`、\`--accent-soft\`、\`--heading\`、\`--code-bg\`、\`--sidebar-bg\`、\`--sidebar-text\`、\`--sidebar-active\`、\`--font-body\`、\`--font-mono\`。
  深色主题的判断用 \`ctx.ui.getTheme().dark\`，并通过 \`ctx.workspace.onThemeChange\` 响应切换。
- 文档的唯一真相是 Markdown 文本：修改文档请使用 \`ctx.editor\` 的方法，不要直接改编辑区 DOM。
- 网络请求只能使用浏览器 \`fetch\`，需要处理失败与超时（可能离线）；不要请求用户没有同意的地址。

# 三、完整接口（ctx）

所有「返回可释放对象」的方法返回 \`{ dispose() }\`，可提前撤销；插件停用时会自动撤销。

## 基本信息
- \`ctx.id\`、\`ctx.manifest\`（plugin.json 内容）、\`ctx.apiVersion\`、\`ctx.appVersion\`
- \`ctx.asset(相对路径)\` → 插件目录内文件的 file:// URL（如图片）
- \`ctx.loadScript(相对路径)\` → Promise，加载插件目录内的其它脚本
- \`ctx.log(...参数)\` → 带插件前缀的控制台日志（Shift+F12 打开开发者工具查看）
- \`ctx.onDispose(fn)\` → 登记插件停用时执行的清理函数

## ctx.commands
- \`register(命令id, handler, { title, accelerator })\` → 可释放对象。命令 id 只能包含字母、数字、\`_\` \`.\` \`-\`；命令自动出现在菜单「插件 → 插件名」与命令面板（F1）中。\`accelerator\` 使用 Electron 格式，例如 \`CmdOrCtrl+Alt+K\`；与内置快捷键或其它插件冲突、或格式非法时快捷键会被忽略（命令仍可用），因此优先选择 \`CmdOrCtrl+Alt+字母\` 组合。插件命令在其它地方的完整 id 为 \`plugin:<插件id>:<命令id>\`。
- \`execute(命令, ...参数)\` → 执行内置命令或插件命令。可用的内置命令：${commands || 'file.save、fmt.bold、para.h1 等'}。

## ctx.markdown（作用于编辑器渲染与导出的 HTML / PDF）
- \`use(plugin, ...options)\` → 注册 markdown-it（v15）插件 \`plugin(md, ...options)\`。Moyu 会在多种时机重建 markdown-it 实例，插件函数可能被调用多次，必须是纯函数、不保存实例相关的全局状态；注册规则名请加插件前缀避免冲突。
- \`addFence(语言, render(code, info))\` → 自定义代码块语言（\`\`\`语言 … \`\`\`），返回 HTML 字符串；返回 \`null\` 则按普通代码块显示；抛出异常会显示为错误提示。
- \`onRender(fn(rootElement))\` → 每次渲染后对 DOM 做后处理（绑定事件、绘制图表等）。会被频繁调用、且 root 可能是整篇文档或单个预览区，**必须幂等**（例如处理过的元素加 \`data-done\` 标记后跳过）。
- \`addStyle(css)\` → 文档样式：作用于编辑器，并写入导出的 HTML / PDF。选择器请以 \`.markdown-body\` 开头。
- \`parse(text)\` → \`{ tokens, env }\`，用 Moyu 的解析器解析（\`env.headings\` 为标题列表）。
- \`render(text)\` → 渲染为已净化的 HTML 字符串。
- 文档按「块」（段落、标题、列表、代码块等）分别渲染，单个块的渲染只能看到本块内容；需要整篇信息时使用 \`ctx.editor.getMarkdown()\`。
- 纯文本模式（编辑时不显示源码）兼容：自定义的**行内**语法如果输出了新元素，请在该元素上加 \`data-md="原始 Markdown 文本"\` 属性，Moyu 才能在纯文本编辑时还原出源码；否则该段落会自动改为显示源码编辑。

## ctx.editor（读写当前文档）
- \`getMarkdown()\` / \`setMarkdown(text)\` → 读取 / 整体替换文档（替换可撤销）
- \`getSelection()\` → 当前选中的文本（未在编辑时为空字符串）
- \`replaceSelection(text)\` / \`insertText(text)\` → 在光标处插入（替换选中内容）
- \`insertBlock(text, caret)\` → 在当前块之后插入新块，\`caret\` 为光标在新块中的位置
- \`getHeadings()\` → \`[{ level, text, id, line }]\`
- \`isSourceMode()\` → 是否处于源代码模式

## ctx.workspace（文档与事件）
- \`getFilePath()\`（未保存的新文档为 \`null\`）、\`getFileName()\`、\`getBaseDir()\`、\`isDirty()\`
- \`onDidOpen(fn)\`：打开或新建文档后
- \`onDidChange(fn)\`：内容变化后（约 250ms 防抖）
- \`onWillSave(fn(text, { filePath }))\`：保存前调用；**返回字符串则替换要保存的内容**（编辑器同步更新），返回 undefined 则不改动
- \`onDidSave(fn({ filePath }))\`：保存成功后
- \`onThemeChange(fn({ name, dark }))\`：切换主题后

## ctx.ui（界面）
- \`toast(消息, 是否错误)\` → 底部提示
- \`prompt(标题, 默认值, 占位文字)\` → \`Promise<string | null>\`（取消为 null）
- \`showModal(html, onMount(element, close))\` → 对话框，返回 \`close\` 函数；Esc 与点击遮罩可关闭。按钮可复用样式 \`class="text-btn"\` / \`class="text-btn primary"\`，底部按钮区用 \`<div class="actions">\`
- \`addStyle(css)\` → 界面样式（不进入导出文件），选择器请加插件专属前缀
- \`addStatusItem({ text, title, onClick })\` → \`{ el, setText, setTitle, setVisible, dispose }\`，显示在底部状态栏
- \`addSidebarPanel({ id, title, onShow })\` → \`{ el, show, isVisible, dispose }\`，在侧边栏新增页签；\`el\` 是面板容器，内容由插件自行渲染；\`id\` 只能包含字母、数字、\`_\` \`-\`
- \`getTheme()\` → \`{ name, dark }\`

## ctx.storage（插件私有、持久保存的 JSON 数据）
- \`get(key, 默认值)\`、\`set(key, value)\`（自动延迟写盘）、\`delete(key)\`、\`all()\`
- 只能保存可 JSON 序列化的数据；体积保持在几百 KB 以内。

## ctx.utils
- \`countWords(text)\` → \`{ total, cjk, words, chars }\`（与状态栏字数一致）
- \`escapeHtml(text)\`、\`debounce(fn, ms)\`

# 四、参考示例（最小可运行插件）

\`\`\`javascript
/* global Moyu */
Moyu.definePlugin({
  activate(ctx) {
    const { commands, editor, ui, workspace, utils } = ctx;
    const item = ui.addStatusItem({ title: '当前文档的标题数' });
    const update = () => item.setText('标题 ' + editor.getHeadings().length);
    workspace.onDidOpen(update);
    workspace.onDidChange(update);
    update();
    commands.register('greet', () => ui.toast('你好，' + workspace.getFileName()), { title: '打个招呼', accelerator: 'CmdOrCtrl+Alt+H' });
    ctx.markdown.addFence('hello', (code) => '<p class="hello-out">👋 ' + utils.escapeHtml(code.trim()) + '</p>');
    ctx.markdown.addStyle('.markdown-body .hello-out { color: var(--accent); }');
  },
  deactivate() {},
});
\`\`\`

# 五、编写要求

1. 先用 3～6 条要点复述你对功能的理解与设计（触发方式、界面位置、数据存储、边界情况），如果功能描述有歧义，选择最合理的做法并说明。
2. 完整实现功能，不留 TODO 或省略号；代码有必要的中文注释。
3. 处理边界情况：文档为空、未保存的新文档（filePath 为 null）、源代码模式、深色主题、重复执行命令、插件被停用后重新加载。
4. 不阻塞界面：耗时操作放在异步流程中，频繁触发的逻辑使用 \`ctx.utils.debounce\`。
5. 只使用上文列出的接口；如果某个需求无法用这些接口实现，明确说明并给出最接近的替代方案，不要臆造接口。

# 六、输出格式

依次输出：
1. 设计要点（简短）。
2. \`plugin.json\` 的完整内容（代码块）。
3. \`main.js\` 的完整内容（代码块）。
4. 其它文件（如有），每个文件一个代码块并标明文件名。
5. 安装与使用说明：把文件夹放到 \`%APPDATA%\\Moyu\\plugins\\\`（Moyu 菜单「插件 → 打开插件目录」），然后执行「插件 → 重新加载插件」，再说明如何触发功能。
6. 自测步骤：列出在 Moyu 中验证功能的具体操作与预期结果。

# 七、交付前自查

- [ ] \`plugin.json\` 字段齐全，\`id\` 合法，\`apiVersion\` 为 1
- [ ] \`Moyu.definePlugin\` 在脚本顶层同步调用
- [ ] 没有使用 \`require\`、\`import\`、Node.js API 或未列出的接口
- [ ] 所有定时器、全局监听、自建 DOM 都通过 \`ctx.onDispose\` 清理
- [ ] 插入对话框或文档的用户内容都经过 \`escapeHtml\` 转义
- [ ] 颜色使用主题变量，深色主题下清晰可读
- [ ] \`onRender\` 处理逻辑幂等
- [ ] 快捷键使用不易冲突的组合，且没有快捷键时功能仍可从菜单或命令面板使用
`;
  }

  window.ZAIPrompt = { build, PLACEHOLDER };
})();
