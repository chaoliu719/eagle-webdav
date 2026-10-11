import assert from 'assert';
import { test } from 'node:test';
import { buildEntries, buildName, cleanBase, eagleSanitizeName, matchEntry } from '../../src/vfs/naming';
import type { FolderInfo, ItemInfo } from '../../src/eagle/adapter';

const item = (id: string, name: string, ext: string, importedAt: number): ItemInfo =>
  ({ id, name, ext, size: 1, folders: [], tags: [], importedAt, modifiedAt: 1, star: 0, annotation: '', url: '' });
const folder = (id: string, name: string, createdAt: number): FolderInfo => ({ id, name, parentId: null, createdAt });

test('名字规范化', () => {
  assert.strictEqual(cleanBase('a/b'), 'a／b');
  assert.strictEqual(cleanBase('x\u0001y'), 'x_y');
  assert.strictEqual(cleanBase('name. . '), 'name');
  assert.strictEqual(cleanBase('é'), 'é');
});

test('超长名字按字节截断且保留扩展名', () => {
  const n = buildName('中'.repeat(200), 'jpg');
  assert.ok(Buffer.byteLength(n) <= 255);
  assert.ok(n.endsWith('.jpg'));
  assert.ok(!n.includes('�'));
});

test('重名消歧：先到先得，文件夹优先，大小写不敏感', () => {
  const e = buildEntries(
    [folder('F00000000001', 'Photo.jpg', 1)],
    [item('AAAAAAAAAAAA1', 'Photo', 'jpg', 5), item('AAAAAAAAAAAA2', 'photo', 'JPG', 3), item('AAAAAAAAAAAA3', 'x', 'png', 9)]
  );
  const names = e.map((x) => x.name);
  assert.deepStrictEqual(names, ['Photo.jpg', 'photo ~AAAAA2.JPG', 'Photo ~AAAAA1.jpg', 'x.png']);
});

test('保留名占用与旧路径的 ID 后缀解析', () => {
  const e = buildEntries([folder('F00000000002', '@未分类', 1)], [], ['@未分类']);
  assert.strictEqual(e[0].name, '@未分类 ~000002');
  const it = buildEntries([], [item('AAAAAAAAAAAA1', 'a', 'jpg', 1), item('AAAAAAAAAAAA2', 'a', 'jpg', 2)]);
  assert.strictEqual(matchEntry(it, 'a ~AAAAA2.jpg')?.id, 'AAAAAAAAAAAA2');
  assert.strictEqual(matchEntry(it, 'A.JPG')?.id, 'AAAAAAAAAAAA1');
  assert.strictEqual(matchEntry(it, 'nope.jpg'), null);
});

test('模拟 Eagle 对条目名的改写，并据此匹配请求路径', () => {
  const cases: Array<[string, string]> = [
    ['emoji😀.txt', 'emoji.txt'], ['a:b.txt', 'ab.txt'], ['a"b.txt', 'ab.txt'], ['a<b>c.txt', 'abc.txt'], ['a%b.txt', 'ab.txt'],
    ['a\\b|c?d*e.txt', 'abcde.txt'], ['a\u200bb.txt', 'ab.txt'], ['a\u00adb.txt', 'ab.txt'], ['a🇨🇳b.txt', 'ab.txt'],
    ['a𠮷b.txt', 'ab.txt'], ['a★b.txt', 'ab.txt'], ['a❤b.txt', 'ab.txt'], ['a✨b.txt', 'ab.txt'], ['trail .txt', 'trail.txt'],
    [' lead.txt', 'lead.txt'], ['dots...txt', 'dots.txt'],
    // 保留的
    ['a#b&c;d=e,f.txt', 'a#b&c;d=e,f.txt'], ["it's [1] (2).txt", "it's [1] (2).txt"], ['a\u00a0b.txt', 'a\u00a0b.txt'],
    ['日本語.txt', '日本語.txt'], ['héllo.txt', 'héllo.txt'], ['a✓b.txt', 'a✓b.txt'], ['.hidden.txt', '.hidden.txt'], ['a~b.txt', 'a~b.txt']
  ];
  for (const [input, want] of cases) assert.strictEqual(eagleSanitizeName(input), want, input);
  assert.strictEqual(eagleSanitizeName('😀.txt'), '.txt');

  const e = buildEntries([], [item('AAAAAAAAAAAA1', 'emoji', 'txt', 1), item('AAAAAAAAAAAA2', 'ab', 'txt', 2)]);
  assert.strictEqual(matchEntry(e, 'emoji😀.txt')?.id, 'AAAAAAAAAAAA1');
  assert.strictEqual(matchEntry(e, 'a:b.txt')?.id, 'AAAAAAAAAAAA2');
});
