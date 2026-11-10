// 打包脚本：组装只含运行时依赖的暂存目录，再用 @electron/packager 生成 dist/Moyu-win32-x64/Moyu.exe
// 用法：npm run pack
// （@electron/packager 自带的依赖裁剪在 npm 11 下会把运行时依赖一并删掉，因此手动暂存）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'dist', '.stage');
const COPY = ['src', 'samples', 'build', 'docs', 'plugins', 'test', 'README.md'];

async function main() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  for (const item of COPY) {
    const from = path.join(ROOT, item);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(STAGE, item), { recursive: true });
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  delete pkg.devDependencies;
  delete pkg.scripts;
  delete pkg.build; // electron-builder 配置只在构建安装包时使用
  fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(pkg, null, 2));

  // 渲染进程只通过 <script>/<link> 加载各库的浏览器构建，只需复制这些文件（及许可证）
  const RUNTIME = [
    'markdown-it/dist/browser/markdown-it.umd.min.js', 'markdown-it/LICENSE',
    'markdown-it-footnote/dist/markdown-it-footnote.min.js', 'markdown-it-footnote/LICENSE',
    'katex/dist/katex.min.js', 'katex/dist/katex.min.css', 'katex/dist/fonts', 'katex/LICENSE',
    '@highlightjs/cdn-assets/highlight.min.js', '@highlightjs/cdn-assets/styles/github.min.css',
    '@highlightjs/cdn-assets/styles/github-dark.min.css', '@highlightjs/cdn-assets/LICENSE',
    'dompurify/dist/purify.min.js', 'dompurify/LICENSE',
    'mermaid/dist/mermaid.min.js', 'mermaid/LICENSE',
  ];
  for (const rel of RUNTIME) {
    const from = path.join(ROOT, 'node_modules', rel);
    if (!fs.existsSync(from)) { if (/LICENSE$/.test(rel)) continue; throw new Error('missing runtime file: ' + rel); }
    fs.cpSync(from, path.join(STAGE, 'node_modules', rel), { recursive: true });
  }
  console.log(`staged ${RUNTIME.length} runtime assets`);

  const { packager } = require('@electron/packager');
  const paths = await packager({
    dir: STAGE,
    name: 'Moyu',
    platform: 'win32',
    arch: 'x64',
    out: path.join(ROOT, 'dist'),
    overwrite: true,
    prune: false,
    asar: true,
    icon: path.join(ROOT, 'build', 'icon.ico'),
    appCopyright: 'ZRID',
    win32metadata: { FileDescription: 'Moyu Markdown 编辑器', ProductName: 'Moyu', CompanyName: 'ZRID' },
    electronVersion: require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version,
  });
  fs.rmSync(STAGE, { recursive: true, force: true });
  console.log('Wrote', paths.join(', '));
}

main().catch((e) => { console.error(e); process.exit(1); });
