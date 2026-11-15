// The language button: English and Simplified Chinese (docs/PROTOTYPE.md §19).
//
// The pages are written in English. In Chinese mode this module replaces each piece of English text on the page with
// its Chinese from zh.js: the text of one DOM text node, a placeholder, a title, an aria-label, or a string drawn on a
// canvas (through tr()). It watches the page, so text the app writes later is translated as it appears. Text it does
// not know stays in English. English mode does nothing at all: no observer and no changes to the page.
//
// What people were told and how Jev answered was recorded in English; the Chinese is a translation for the reader.
import { EXACT, PATTERNS } from './zh.js';

const KEY = 'swarmscope-lang';
const ATTRS = ['placeholder', 'title', 'aria-label'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CANVAS', 'SVG', 'TEXTAREA', 'CODE', 'PRE']);
const ATTRS_ONLY = new Set(['TEXTAREA']);     // what is typed in a box is never translated, but its placeholder is
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
};

let lang = 'en';
const listeners = new Set();
const compiled = [];
for (const [source, zh] of PATTERNS) {
  try { compiled.push([new RegExp(source), zh]); } catch { /* a pattern that does not compile is left out */ }
}

// ---------- one string ----------
const cache = new Map();
function lookup(core, depth) {
  if (Object.hasOwn(EXACT, core)) return EXACT[core];
  if (depth > 2) return null;
  for (const [re, zh] of compiled) {
    const m = core.match(re);
    if (!m) continue;
    // Each changing part (a place name, a reason) is translated on its own; numbers and names pass through.
    return zh.replace(/\$(\d)/g, (_, k) => {
      const part = m[Number(k)] ?? '';
      return lookup(part.trim(), depth + 1) ?? part;
    });
  }
  return null;
}
function translate(text) {
  const core = text.trim();
  if (!core || !/[A-Za-z]/.test(core)) return text;
  let zh = cache.get(core);
  if (zh === undefined) {
    zh = lookup(core, 0);
    if (cache.size > 6000) cache.clear();
    cache.set(core, zh);
  }
  return zh == null ? text : text.replace(core, () => zh);       // the surrounding spaces stay
}

// For text drawn on a canvas, which the page walk cannot see.
export function tr(text) {
  return lang === 'zh' && typeof text === 'string' ? translate(text) : text;
}

// ---------- the page ----------
const original = new WeakMap();      // text node -> the English it had
const shown = new WeakMap();         // text node -> the Chinese put there
const attrState = new WeakMap();     // element -> { attribute: { en, zh } }
const skipped = el => SKIP_TAGS.has(el.tagName?.toUpperCase?.()) || el.hasAttribute?.('data-i18n-skip');
const insideSkipped = node => { for (let p = node.parentElement; p; p = p.parentElement) if (skipped(p)) return true; return false; };

function translateText(node) {
  const now = node.nodeValue;
  if (shown.get(node) === now) return;                 // this is the Chinese we wrote
  const zh = translate(now);
  original.set(node, now);
  if (zh !== now) { shown.set(node, zh); node.nodeValue = zh; } else shown.delete(node);
}
function translateAttrs(el) {
  for (const a of ATTRS) {
    if (!el.hasAttribute(a)) continue;
    const now = el.getAttribute(a);
    const state = attrState.get(el) || {};
    if (state[a]?.zh === now) continue;                // ours
    const zh = translate(now);
    state[a] = { en: now, zh: zh !== now ? zh : null };
    attrState.set(el, state);
    if (zh !== now) el.setAttribute(a, zh);
  }
}
function each(root, onText, onElement) {
  if (root.nodeType === 3) { if (!insideSkipped(root)) onText(root); return; }
  if (root.nodeType !== 1 || insideSkipped(root)) return;
  if (skipped(root)) { if (ATTRS_ONLY.has(root.tagName) && !root.hasAttribute('data-i18n-skip')) onElement(root); return; }
  onElement(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: n => {
      if (n.nodeType !== 1 || !skipped(n)) return NodeFilter.FILTER_ACCEPT;
      if (ATTRS_ONLY.has(n.tagName) && !n.hasAttribute('data-i18n-skip')) onElement(n);
      return NodeFilter.FILTER_REJECT;
    }
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) (n.nodeType === 3 ? onText : onElement)(n);
}
const toChinese = root => each(root, translateText, translateAttrs);
function toEnglish(root) {
  each(root, node => {
    if (shown.get(node) === node.nodeValue && original.has(node)) node.nodeValue = original.get(node);
    shown.delete(node);
  }, el => {
    const state = attrState.get(el);
    if (!state) return;
    for (const a of ATTRS) if (state[a]?.zh != null && el.getAttribute(a) === state[a].zh) el.setAttribute(a, state[a].en);
    attrState.delete(el);
  });
}

const observer = new MutationObserver(list => {
  for (const m of list) {
    if (m.type === 'characterData') { if (!insideSkipped(m.target)) translateText(m.target); }
    else if (m.type === 'attributes') {
      const t = m.target, own = skipped(t) && !(ATTRS_ONLY.has(t.tagName) && !t.hasAttribute('data-i18n-skip'));
      if (!own && !insideSkipped(t)) translateAttrs(t);
    }
    else for (const n of m.addedNodes) toChinese(n);
  }
});

export const getLang = () => lang;
export const onLang = f => { listeners.add(f); };

export function setLang(next) {
  next = next === 'zh' ? 'zh' : 'en';
  if (next === lang) return;
  lang = next;
  store.set(KEY, lang);
  document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : 'en';
  if (lang === 'zh') {
    toChinese(document.body);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  } else {
    observer.disconnect();
    toEnglish(document.body);
  }
  for (const f of listeners) f(lang);
}

// Wire a button to switch language. It always names the language it switches to, in that language.
// The choice is remembered, and ?lang=zh opens a page in Chinese.
export function langButton(button) {
  if (!button) return;
  button.setAttribute('data-i18n-skip', '');
  const paint = () => {
    button.textContent = lang === 'zh' ? 'English' : '中文';
    button.setAttribute('lang', lang === 'zh' ? 'en' : 'zh-Hans');
    button.setAttribute('aria-label', lang === 'zh' ? 'Switch to English' : '切换到简体中文');
  };
  button.addEventListener('click', () => { setLang(lang === 'zh' ? 'en' : 'zh'); paint(); });
  const asked = new URLSearchParams(location.search).get('lang');
  if ((asked || store.get(KEY)) === 'zh' && asked !== 'en') setLang('zh');
  paint();
}
