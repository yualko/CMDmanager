'use strict';

// ============================================================================
// Локализация. Исходный язык — русский: строки в коде пишутся по-русски, а словарь i18n.json
// сопоставляет каждой русской строке перевод. Интерфейс переводится «на лету»: всё, что
// появляется на экране (текст, title, placeholder), сверяется со словарём. Строки с подстановками
// записаны в словаре шаблонами: «Закрыть «{0}»?». Содержимое терминалов не трогается никогда.
// ============================================================================
const LANGUAGES = [
  ['ru', 'Русский'], ['en', 'English'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'],
  ['pt', 'Português'], ['it', 'Italiano'], ['tr', 'Türkçe'], ['zh', '中文'], ['ja', '日本語'],
];

const I18N = {
  lang: 'ru',
  data: null,      // { "русская строка": { en: "...", de: "...", ... }, ... }
  exact: new Map(),
  patterns: [],    // [{ re, out }]
};

const I18N_SKIP = '.term-host, .xterm, #parking, script, style, textarea, [data-no-i18n]';
const I18N_ATTRS = ['title', 'placeholder', 'aria-label'];

async function i18nLoad() {
  try {
    const r = await fetch('i18n.json', { cache: 'no-store' });
    I18N.data = await r.json();
  } catch {
    I18N.data = null;  // без словаря просто остаёмся на русском
  }
}

// Язык по настройке (пусто — язык Windows); неподдерживаемые → английский.
function i18nResolve(setting, systemLang) {
  const want = (setting || systemLang || 'ru').toLowerCase().slice(0, 2);
  return LANGUAGES.some(([code]) => code === want) ? want : 'en';
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function i18nSetLanguage(lang) {
  I18N.lang = lang;
  I18N.exact.clear();
  I18N.patterns = [];
  const d = I18N.data;
  if (d && lang !== 'ru') {
    Object.entries(d).forEach(([key, tr]) => {
      const out = tr && tr[lang];
      if (!out) return;
      if (/\{\d\}/.test(key)) {
        // Шаблон: «{0}» превращается в захватывающую группу.
        const parts = key.split(/(\{\d\})/);
        const order = [];
        const re = parts.map((p) => {
          const m = p.match(/^\{(\d)\}$/);
          if (m) { order.push(Number(m[1])); return '([\\s\\S]*?)'; }
          return escapeRe(p);
        }).join('');
        I18N.patterns.push({ re: new RegExp(`^${re}$`), order, out, weight: key.replace(/\{\d\}/g, '').length });
      } else {
        I18N.exact.set(key, out);
      }
    });
    // Сначала самые «конкретные» шаблоны (больше постоянного текста).
    I18N.patterns.sort((a, b) => b.weight - a.weight);
  }
  document.documentElement.lang = lang;
  i18nTranslateTree(document.body);
}

// Перевод одной строки (без учёта пробелов по краям). Подстановки шаблона тоже переводятся —
// например, сообщение об ошибке внутри «Не удалось проверить обновления: {0}».
function i18nTranslate(text, depth = 0) {
  if (I18N.lang === 'ru' || !text) return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  let out = I18N.exact.get(trimmed);
  if (out === undefined) {
    for (const p of I18N.patterns) {
      const m = trimmed.match(p.re);
      if (!m) continue;
      out = p.out.replace(/\{(\d)\}/g, (_, n) => {
        const arg = m[p.order.indexOf(Number(n)) + 1] ?? '';
        return depth < 2 ? i18nTranslate(arg, depth + 1) : arg;
      });
      break;
    }
  }
  if (out === undefined) return text;
  const lead = text.match(/^\s*/)[0];
  const trail = text.match(/\s*$/)[0];
  return lead + out + trail;
}

// t('Русская строка с {0}', значение) — для текста, который выводится не в интерфейс (терминал, задание агенту, диалоги Windows).
function t(ru, ...args) {
  const tr = i18nTranslateKey(ru);
  return tr.replace(/\{(\d)\}/g, (_, n) => (args[Number(n)] ?? ''));
}

function i18nTranslateKey(key) {
  if (I18N.lang === 'ru' || !I18N.data) return key;
  return I18N.data[key]?.[I18N.lang] || key;
}

function i18nLocale() {
  return { ru: 'ru-RU', en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', pt: 'pt-BR', it: 'it-IT', tr: 'tr-TR', zh: 'zh-CN', ja: 'ja-JP' }[I18N.lang] || 'en-US';
}

// ---------- перевод DOM ----------
// Для каждого текстового узла и атрибута помним исходник (русский) и выданный перевод,
// чтобы при смене языка переводить заново из оригинала, а не из уже переведённого текста.
const i18nAttrSrc = new WeakMap();

function i18nTextNode(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest(I18N_SKIP)) return;
  const current = node.nodeValue;
  const src = node.__i18nOut !== undefined && current === node.__i18nOut ? node.__i18nSrc : current;
  const out = i18nTranslate(src);
  node.__i18nSrc = src;
  node.__i18nOut = out;
  if (out !== current) node.nodeValue = out;
}

function i18nAttributes(elem) {
  if (elem.closest(I18N_SKIP)) return;
  let store = i18nAttrSrc.get(elem);
  for (const name of I18N_ATTRS) {
    if (!elem.hasAttribute(name)) continue;
    const current = elem.getAttribute(name);
    const prev = store?.[name];
    const src = prev && current === prev.out ? prev.src : current;
    const out = i18nTranslate(src);
    if (!store) { store = {}; i18nAttrSrc.set(elem, store); }
    store[name] = { src, out };
    if (out !== current) elem.setAttribute(name, out);
  }
}

function i18nTranslateTree(root) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) { i18nTextNode(root); return; }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  if (root.closest(I18N_SKIP)) return;
  i18nAttributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && n.matches(I18N_SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) i18nTextNode(n);
    else i18nAttributes(n);
  }
}

const i18nObserver = new MutationObserver((mutations) => {
  if (I18N.lang === 'ru') return;
  for (const m of mutations) {
    if (m.type === 'childList') m.addedNodes.forEach(i18nTranslateTree);
    else if (m.type === 'characterData') i18nTextNode(m.target);
    else if (m.type === 'attributes') i18nAttributes(m.target);
  }
});
i18nObserver.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: I18N_ATTRS });
