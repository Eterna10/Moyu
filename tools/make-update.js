// 生成增量更新包：把打包好的 resources/app.asar 压缩为 dist/release/Moyu-<版本>-app-electron-<Electron 版本>.asar.gz
// 用法：npm run dist（打包完成后自动执行），或单独运行 node tools/make-update.js
//
// 已安装的 Moyu 检查更新时，若发布中有这个文件、且其中的 Electron 版本与本机一致，
// 就只下载它（几 MB）替换 app.asar，而不必下载完整安装包。
// 如果某个版本改动了 app.asar 以外的内容（Electron 版本、文件关联、安装程序设置等），
// 发布时不要上传这个文件，用户会自动改为下载完整安装包。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const electron = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
const src = path.join(ROOT, 'dist', 'Moyu-win32-x64', 'resources', 'app.asar');
const outDir = path.join(ROOT, 'dist', 'release');

if (!fs.existsSync(src)) { console.error('找不到 ' + src + '，请先运行 npm run pack'); process.exit(1); }
const name = `Moyu-${pkg.version}-app-electron-${electron}.asar.gz`;
const data = zlib.gzipSync(fs.readFileSync(src), { level: 9 });
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) if (/\.asar\.gz$/i.test(f) && f !== name) fs.rmSync(path.join(outDir, f));
fs.writeFileSync(path.join(outDir, name), data);
console.log(`${name}  ${(data.length / 1048576).toFixed(2)} MB  sha256:${crypto.createHash('sha256').update(data).digest('hex')}`);
