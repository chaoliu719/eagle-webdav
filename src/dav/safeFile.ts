import * as fs from 'fs';
import * as path from 'path';

export interface SafeFile { realPath: string; size: number }

/**
 * 读取文件前的安全校验：realpath 必须落在「资源库/images/」下，
 * 且直接父目录以 .info 结尾，否则视为不存在。
 */
export async function safeLibraryFile(libraryPath: string, filePath: string): Promise<SafeFile | null> {
  try {
    const base = await fs.promises.realpath(path.join(libraryPath, 'images'));
    const real = await fs.promises.realpath(filePath);
    if (!real.startsWith(base + path.sep)) return null;
    if (!path.basename(path.dirname(real)).endsWith('.info')) return null;
    const st = await fs.promises.stat(real);
    if (!st.isFile()) return null;
    return { realPath: real, size: st.size };
  } catch {
    return null;
  }
}
