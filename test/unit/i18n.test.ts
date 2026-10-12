import assert from 'assert';
import { test } from 'node:test';
import en from '../../plugin/_locales/en.json';
import zhCN from '../../plugin/_locales/zh_CN.json';
import zhTW from '../../plugin/_locales/zh_TW.json';
import { pickLocale, setLocale, t } from '../../src/i18n';

const keys = (o: unknown, p = ''): string[] =>
  Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (typeof v === 'object' && v ? keys(v, p + k + '.') : [p + k]));

test('三种语言的键完全一致，且没有空值', () => {
  const base = keys(zhCN).sort();
  assert.deepStrictEqual(keys(en).sort(), base);
  assert.deepStrictEqual(keys(zhTW).sort(), base);
  for (const d of [zhCN, en, zhTW]) {
    const walk = (o: any): void => Object.values(o).forEach((v) => (typeof v === 'string' ? assert.ok(v.trim(), '空翻译') : walk(v)));
    walk(d);
  }
});

test('三种语言里的 {{变量}} 一致', () => {
  const vars = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join();
  const flat = (o: any, p = ''): Record<string, string> =>
    Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[p + k, v]] : Object.entries(flat(v, p + k + '.')))));
  const a = flat(zhCN), b = flat(en), c = flat(zhTW);
  for (const k of Object.keys(a)) { assert.strictEqual(vars(b[k]), vars(a[k]), k); assert.strictEqual(vars(c[k]), vars(a[k]), k); }
});

test('pickLocale：中文区分简繁，其他语言退回英文', () => {
  assert.strictEqual(pickLocale('zh_CN'), 'zh_CN');
  assert.strictEqual(pickLocale('zh-CN'), 'zh_CN');
  assert.strictEqual(pickLocale('zh_TW'), 'zh_TW');
  assert.strictEqual(pickLocale('zh-HK'), 'zh_TW');
  assert.strictEqual(pickLocale('en'), 'en');
  assert.strictEqual(pickLocale('ja_JP'), 'en');
  assert.strictEqual(pickLocale(undefined), 'en');
});

test('t：插值、按语言取值、缺键返回键名', () => {
  setLocale('en');
  assert.strictEqual(t('library', { name: 'Production' }), 'Library: Production');
  assert.strictEqual(t('manifest.app.name'), 'WebDAV Share');
  assert.strictEqual(t('noSuchKey'), 'ui.noSuchKey');
  setLocale('zh_CN');
  assert.strictEqual(t('saveFailed', { msg: 'x' }), '没能保存：x');
  setLocale('zh_TW');
  assert.strictEqual(t('manifest.app.name'), 'WebDAV 共享');
  setLocale('zh_CN');
});
