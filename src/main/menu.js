// Moyu 中文原生菜单（快捷键与 Typora 保持一致）
const { Menu } = require('electron');
const path = require('path');

const THEMES = [
  ['github', 'GitHub'],
  ['newsprint', 'Newsprint 报刊'],
  ['night', 'Night 夜间'],
  ['midnight', 'Midnight 午夜蓝'],
];

const ACCEL_RE = /^((CmdOrCtrl|CommandOrControl|Ctrl|Control|Alt|Option|Shift|Super|Meta|Cmd|Command)\+)*([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|[=\-[\];',./\\`]|Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc)$/i;

/** 归一化快捷键，用于检测冲突（CmdOrCtrl / Ctrl 等视为同一个键） */
function normAccel(a) {
  return String(a).toLowerCase().replace(/\s+/g, '').split('+')
    .map((k) => (/^(cmdorctrl|commandorcontrol|control|ctrl|cmd|command)$/.test(k) ? 'ctrl' : k === 'option' ? 'alt' : k))
    .sort().join('+');
}

/** 「插件」菜单：每个插件一个子菜单；与内置快捷键冲突或格式非法的快捷键会被忽略 */
function pluginMenu(template, items, c, openPluginDir) {
  const used = new Set();
  const walk = (list) => list.forEach((it) => {
    if (it.accelerator) used.add(normAccel(it.accelerator));
    if (Array.isArray(it.submenu)) walk(it.submenu);
  });
  walk(template);
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.pluginId)) groups.set(it.pluginId, { label: it.pluginName, submenu: [] });
    let accelerator;
    if (it.accelerator && ACCEL_RE.test(it.accelerator) && !used.has(normAccel(it.accelerator))) {
      accelerator = it.accelerator;
      used.add(normAccel(accelerator));
    }
    groups.get(it.pluginId).submenu.push(c(it.title, it.key, accelerator));
  }
  const submenu = [...groups.values()];
  if (!submenu.length) submenu.push({ label: '（已启用的插件没有提供命令）', enabled: false });
  submenu.push(
    { type: 'separator' },
    c('管理插件…', 'plugins.manage'),
    { label: '打开插件目录', click: openPluginDir },
    c('重新加载插件', 'plugins.reload'),
    { type: 'separator' },
    c('插件开发指南', 'help.pluginGuide'),
    c('一键提示词（用 AI 生成插件）…', 'plugins.aiPrompt'),
  );
  return { label: '插件(&X)', submenu };
}

function buildMenu({ settings, send, newWindow, openRecent, clearRecent, plugins, openPluginDir }) {
  const c = (label, cmd, accelerator, extra) => Object.assign({ label, accelerator, click: (_item, win) => send(cmd, win) }, extra || {});
  const recent = (settings.recentFiles || []).map((p) => ({ label: path.basename(p) + '    ' + path.dirname(p), click: () => openRecent(p) }));
  if (recent.length) recent.push({ type: 'separator' }, { label: '清除最近文件', click: clearRecent });
  else recent.push({ label: '（无）', enabled: false });

  const template = [
    {
      label: '文件(&F)',
      submenu: [
        c('新建', 'file.new', 'CmdOrCtrl+N'),
        { label: '新建窗口', accelerator: 'CmdOrCtrl+Shift+N', click: newWindow },
        { type: 'separator' },
        c('打开…', 'file.open', 'CmdOrCtrl+O'),
        c('打开文件夹…', 'file.openFolder', 'CmdOrCtrl+Shift+O'),
        { label: '最近打开', submenu: recent },
        { type: 'separator' },
        c('保存', 'file.save', 'CmdOrCtrl+S'),
        c('另存为…', 'file.saveAs', 'CmdOrCtrl+Shift+S'),
        c('自动保存', 'file.toggleAutoSave', null, { type: 'checkbox', checked: !!settings.autoSave }),
        c('历史版本…', 'file.history'),
        { type: 'separator' },
        { label: '导出', submenu: [c('HTML…', 'file.exportHtml'), c('PDF…', 'file.exportPdf', 'CmdOrCtrl+Shift+P')] },
        c('在资源管理器中显示', 'file.reveal'),
        { type: 'separator' },
        c('快速打开…', 'file.quickOpen', 'CmdOrCtrl+P'),
        { type: 'separator' },
        c('偏好设置…', 'file.preferences', 'CmdOrCtrl+,'),
        c('主题与外观…', 'file.preferencesTheme'),
        { type: 'separator' },
        c('关闭窗口', 'file.close', 'CmdOrCtrl+W'),
        { label: '退出', role: 'quit', accelerator: 'Alt+F4' },
      ],
    },
    {
      label: '编辑(&E)',
      submenu: [
        c('撤销', 'edit.undo', 'CmdOrCtrl+Z'),
        c('重做', 'edit.redo', 'CmdOrCtrl+Y'),
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '粘贴为纯文本', role: 'pasteAndMatchStyle', accelerator: 'CmdOrCtrl+Shift+V' },
        c('全选', 'edit.selectAll', 'CmdOrCtrl+A'),
        { type: 'separator' },
        c('查找', 'edit.find', 'CmdOrCtrl+F'),
        c('替换', 'edit.replace', 'CmdOrCtrl+H'),
        c('查找下一个', 'edit.findNext', 'F3'),
        c('查找上一个', 'edit.findPrev', 'Shift+F3'),
        { type: 'separator' },
        c('命令面板…', 'edit.commandPalette', 'F1'),
      ],
    },
    {
      label: '段落(&P)',
      submenu: [
        c('一级标题', 'para.h1', 'CmdOrCtrl+1'),
        c('二级标题', 'para.h2', 'CmdOrCtrl+2'),
        c('三级标题', 'para.h3', 'CmdOrCtrl+3'),
        c('四级标题', 'para.h4', 'CmdOrCtrl+4'),
        c('五级标题', 'para.h5', 'CmdOrCtrl+5'),
        c('六级标题', 'para.h6', 'CmdOrCtrl+6'),
        c('段落', 'para.p', 'CmdOrCtrl+0'),
        c('提升标题级别', 'para.headingUp', 'CmdOrCtrl+='),
        c('降低标题级别', 'para.headingDown', 'CmdOrCtrl+-'),
        { type: 'separator' },
        c('表格', 'para.table', 'CmdOrCtrl+T'),
        c('代码块', 'para.code', 'CmdOrCtrl+Shift+K'),
        c('公式块', 'para.math', 'CmdOrCtrl+Shift+M'),
        { type: 'separator' },
        c('引用', 'para.quote', 'CmdOrCtrl+Shift+Q'),
        c('有序列表', 'para.ol', 'CmdOrCtrl+Shift+['),
        c('无序列表', 'para.ul', 'CmdOrCtrl+Shift+]'),
        c('任务列表', 'para.task', 'CmdOrCtrl+Shift+X'),
        { type: 'separator' },
        c('水平分割线', 'para.hr'),
        c('内容目录 [TOC]', 'para.toc'),
      ],
    },
    {
      label: '格式(&O)',
      submenu: [
        c('加粗', 'fmt.bold', 'CmdOrCtrl+B'),
        c('斜体', 'fmt.italic', 'CmdOrCtrl+I'),
        c('下划线', 'fmt.underline', 'CmdOrCtrl+U'),
        c('删除线', 'fmt.strike', 'Alt+Shift+5'),
        c('高亮', 'fmt.mark', 'CmdOrCtrl+Shift+H'),
        c('行内代码', 'fmt.code', 'CmdOrCtrl+Shift+`'),
        c('行内公式', 'fmt.math', 'CmdOrCtrl+Shift+E'),
        { type: 'separator' },
        c('超链接', 'fmt.link', 'CmdOrCtrl+K'),
        {
          label: '图片',
          submenu: [
            c('插入图片…', 'fmt.image', 'CmdOrCtrl+Shift+I'),
            c('上传所有本地图片', 'fmt.uploadAll'),
            { type: 'separator' },
            c('图片设置…', 'file.preferencesImage'),
          ],
        },
        { type: 'separator' },
        c('清除样式', 'fmt.clear', 'CmdOrCtrl+\\'),
      ],
    },
    {
      label: '视图(&V)',
      submenu: [
        c('源代码模式', 'view.source', 'CmdOrCtrl+/'),
        c('纯文本模式（不显示源码）', 'view.rich', 'F7', { type: 'checkbox', checked: !!settings.richMode }),
        { type: 'separator' },
        c('显示 / 隐藏侧边栏', 'view.sidebar', 'CmdOrCtrl+Shift+L'),
        c('大纲', 'view.outline', 'CmdOrCtrl+Shift+1'),
        c('文件树', 'view.files', 'CmdOrCtrl+Shift+3'),
        { type: 'separator' },
        c('专注模式', 'view.focus', 'F8'),
        c('打字机模式', 'view.typewriter', 'F9'),
        { type: 'separator' },
        { label: '放大', role: 'zoomIn', accelerator: 'CmdOrCtrl+Shift+=' },
        { label: '缩小', role: 'zoomOut', accelerator: 'CmdOrCtrl+Shift+-' },
        { label: '实际大小', role: 'resetZoom', accelerator: 'CmdOrCtrl+Shift+0' },
        { label: '全屏', role: 'togglefullscreen', accelerator: 'F11' },
        { type: 'separator' },
        { label: '开发者工具', role: 'toggleDevTools', accelerator: 'Shift+F12' },
      ],
    },
    {
      label: '主题(&T)',
      submenu: THEMES.map(([id, label]) => c(label, 'theme.' + id, null, { type: 'radio', checked: settings.theme === id })),
    },
    {
      label: '帮助(&H)',
      submenu: [
        c('欢迎文档', 'help.welcome'),
        c('Markdown 语法参考', 'help.syntax'),
        c('快捷键一览', 'help.shortcuts'),
        c('插件开发指南', 'help.pluginGuide'),
        { type: 'separator' },
        c('检查更新…', 'help.checkUpdate'),
        c('关于 Moyu', 'help.about'),
      ],
    },
  ];
  template.splice(template.length - 1, 0, pluginMenu(template, plugins || [], c, openPluginDir));
  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu };
