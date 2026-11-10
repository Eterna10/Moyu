// Moyu 预加载脚本：只向页面暴露白名单内的 IPC 通道
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set([
  'settings:get', 'settings:set', 'settings:reset', 'win:initial', 'win:setTitle', 'win:close', 'win:new',
  'dialog:open', 'dialog:openFolder', 'dialog:save', 'dialog:pickImage', 'dialog:pickExe', 'dialog:confirmSave', 'dialog:message',
  'fs:read', 'fs:write', 'fs:stat', 'fs:tree', 'fs:newFile', 'fs:exists', 'fs:imageDataUrl',
  'image:insert', 'image:uploadLocal', 'image:testUpload',
  'plugins:list', 'plugins:setEnabled', 'plugins:openDir', 'plugins:dir', 'plugins:storageGet', 'plugins:storageSet', 'plugins:setMenu',
  'app:addRecent', 'app:readAsset', 'app:info', 'app:helpDoc',
  'export:html', 'export:pdf', 'shell:open', 'shell:reveal',
]);
const EVENTS = new Set(['menu', 'open-file', 'before-close', 'settings-changed', 'plugins-changed']);

contextBridge.exposeInMainWorld('zmark', {
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error('channel not allowed: ' + channel));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, cb) {
    if (!EVENTS.has(channel)) return;
    ipcRenderer.on(channel, (_e, ...args) => cb(...args));
  },
  pathForFile(file) {
    try { return webUtils.getPathForFile(file); } catch (e) { return ''; }
  },
  platform: process.platform,
});
