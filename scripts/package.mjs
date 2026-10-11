// 打包：构建后把 plugin/ 压成 dist/eagle-webdav-<版本>.zip，解压即得 Eagle 可加载的插件目录。
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, rmSync } from 'fs';

const manifest = JSON.parse(readFileSync('plugin/manifest.json', 'utf8'));
if (manifest.main?.devTools || manifest.devTools) {
  console.warn('提示：manifest.json 里 devTools 为 true，发布包会在启动时弹出开发者工具');
}
execFileSync('node', ['build.mjs'], { stdio: 'inherit' });
mkdirSync('dist', { recursive: true });
const out = `eagle-webdav-${manifest.version}.zip`;
rmSync(`dist/${out}`, { force: true });
execFileSync('zip', ['-r', '-q', `../dist/${out}`, '.', '-x', '.DS_Store', '*/.DS_Store'], { cwd: 'plugin', stdio: 'inherit' });
console.log(`已生成 dist/${out}`);
