import en from '../plugin/_locales/en.json';
import zhCN from '../plugin/_locales/zh_CN.json';
import zhTW from '../plugin/_locales/zh_TW.json';

export type Locale = 'zh_CN' | 'zh_TW' | 'en';

const DICTS: Record<Locale, unknown> = { zh_CN: zhCN, zh_TW: zhTW, en };
let current: Locale = 'zh_CN';

/** Eagle 的语言（如 zh_CN、zh-TW、ja_JP）归到我们有的三种；没有的退回 en（与 manifest 的 fallbackLanguage 一致）。 */
export function pickLocale(raw?: string): Locale {
  const l = (raw ?? '').replace('-', '_');
  if (/^zh_(TW|HK|MO|Hant)/i.test(l)) return 'zh_TW';
  if (/^zh/i.test(l)) return 'zh_CN';
  return 'en';
}

export function setLocale(raw?: string): Locale {
  current = pickLocale(raw);
  return current;
}

export function getLocale(): Locale { return current; }

function lookup(dict: unknown, key: string): string | undefined {
  let cur: any = dict;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** 取翻译并替换 {{变量}}；当前语言缺失时依次退回 en、zh_CN，最后返回 key 本身。 */
export function t(key: string, vars: Record<string, string | number> = {}): string {
  const k = key.includes('.') ? key : 'ui.' + key;
  const s = lookup(DICTS[current], k) ?? lookup(DICTS.en, k) ?? lookup(DICTS.zh_CN, k) ?? k;
  return s.replace(/\{\{(\w+)\}\}/g, (_m, v: string) => (v in vars ? String(vars[v]) : ''));
}

/** 把页面里带 data-i18n / data-i18n-aria 的静态文字换成当前语言。 */
export function applyStaticI18n(root: Document | HTMLElement = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n!); });
  root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria!)); });
  if (typeof document !== 'undefined') {
    document.title = t('manifest.app.name');
    document.documentElement.lang = current === 'en' ? 'en' : current === 'zh_TW' ? 'zh-TW' : 'zh-CN';
  }
}
