// 大库压测（假数据）：npx tsx test/dev/bench.ts [条目数] [单目录条目数]
import * as http from 'http';
import { performance } from 'perf_hooks';
import { DavRouter } from '../../src/dav/router';
import type { FolderInfo, ItemFile, ItemInfo } from '../../src/eagle/adapter';
import { FakeEagleAdapter } from '../../src/eagle/fakeAdapter';
import { LibraryIndex } from '../../src/index/libraryIndex';
import { RingLogger } from '../../src/util/log';

const total = Number(process.argv[2] || 200_000);
const big = Number(process.argv[3] || 20_000);

class BigAdapter extends FakeEagleAdapter {
  folderCount = 500;
  async getFolders(): Promise<FolderInfo[]> {
    return Array.from({ length: this.folderCount }, (_, i) => ({ id: 'F' + String(i).padStart(8, '0'), name: '文件夹 ' + i, parentId: i % 10 === 0 || i === 0 ? null : 'F' + String(i - (i % 10)).padStart(8, '0'), createdAt: i }));
  }
  private make(i: number, folder: string | null): ItemInfo {
    return { id: 'I' + String(i).padStart(9, '0'), name: '素材 ' + i, ext: 'jpg', size: 1000 + i, folders: folder ? [folder] : [], tags: [], importedAt: 1_700_000_000_000 + i, modifiedAt: 1_700_000_000_000 + i, star: 0, annotation: '', url: '' };
  }
  async getItems(folderId: string | null): Promise<ItemInfo[]> {
    if (folderId === 'F00000000') return Array.from({ length: big }, (_, i) => this.make(i, folderId));
    if (folderId === null) return Array.from({ length: Math.min(total - big, 50_000) }, (_, i) => this.make(big + i, null));
    const per = Math.max(Math.floor((total - big) / this.folderCount), 1);
    return Array.from({ length: per }, (_, i) => this.make(i + Number(folderId.slice(1)) * 1000, folderId));
  }
  async getItemFile(): Promise<ItemFile | null> { return null; }
}

const adapter = new BigAdapter();
const router = new DavRouter(adapter, new LibraryIndex(adapter), new RingLogger());

function propfind(url: string, depth: string): Promise<{ ms: number; bytes: number; n: number }> {
  const t = performance.now();
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => { router.handle(req, res).catch(() => res.end()); });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      const r = http.request({ host: '127.0.0.1', port, method: 'PROPFIND', path: url, headers: { Depth: depth } }, (res) => {
        let bytes = 0; let n = 0;
        res.on('data', (d: Buffer) => { bytes += d.length; n += (d.toString().match(/<D:response>/g) ?? []).length; });
        res.on('end', () => { srv.close(); resolve({ ms: Math.round(performance.now() - t), bytes, n }); });
      });
      r.end();
    });
  });
}

(async () => {
  const mem = () => Math.round(process.memoryUsage().heapUsed / 1048576);
  console.log(`总量约 ${total}，大目录 ${big}，初始堆 ${mem()}MB`);
  for (const [label, url, depth] of [
    ['根目录 Depth:1（冷）', '/', '1'], ['根目录 Depth:1（热）', '/', '1'],
    [`大目录 Depth:1（冷，${big} 条）`, '/' + encodeURIComponent('文件夹 0'), '1'],
    ['大目录 Depth:1（热）', '/' + encodeURIComponent('文件夹 0'), '1'],
    ['大目录里单个文件 Depth:0', '/' + encodeURIComponent('文件夹 0') + '/' + encodeURIComponent('素材 19999.jpg'), '0'],
    ['未分类 Depth:1（冷）', '/' + encodeURIComponent('@未分类'), '1'],
    ['未分类 Depth:1（热）', '/' + encodeURIComponent('@未分类'), '1']
  ] as const) {
    const r = await propfind(url, depth);
    console.log(`${label.padEnd(28)} ${String(r.ms).padStart(6)}ms  ${String(r.n).padStart(6)} 项  ${(r.bytes / 1048576).toFixed(1)}MB  堆 ${mem()}MB`);
  }
})();
