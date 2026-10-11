// 打包：构建后把 plugin/ 压成 dist/eagle-webdav-<版本>.eagleplugin。
// 实测 Eagle「打包插件」生成的 .eagleplugin 就是 plugin/ 内容的 zip，结构与这里一致；同时留一份 .zip 方便解压后用「导入本地项目」加载。
import { execFileSync } from 'child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'fs';

const manifest = JSON.parse(readFileSync('plugin/manifest.json', 'utf8'));
if (manifest.main?.devTools || manifest.devTools) {
  console.warn('提示：manifest.json 里 devTools 为 true，发布包会在启动时弹出开发者工具');
}
execFileSync('node', ['build.mjs'], { stdio: 'inherit' });
mkdirSync('dist', { recursive: true });
const out = `eagle-webdav-${manifest.version}.zip`;
rmSync(`dist/${out}`, { force: true });
execFileSync('zip', ['-r', '-q', `../dist/${out}`, '.', '-x', '.DS_Store', '*/.DS_Store'], { cwd: 'plugin', stdio: 'inherit' });
const pkg = out.replace(/\.zip$/, '.eagleplugin');
copyFileSync(`dist/${out}`, `dist/${pkg}`);
console.log(`已生成 dist/${out} 与 dist/${pkg}`);
