/**
 * The per-screen leak check. `collectSnapshot` runs inside the page (it is
 * passed to page.evaluate, so it uses nothing from this module's scope) and
 * gathers every piece of text a screenshot could show: all text including
 * hidden and chart labels, form values, the title, link and image addresses,
 * accessible labels and generated content. Anything whose text cannot be
 * read — a canvas, a frame, a video, an image from another site — is listed
 * as uninspectable, and `checkSnapshot` treats that as a failure.
 */

const { normalize } = require('./normalize');

/* eslint-disable no-undef */
function collectSnapshot() {
  const origin = window.location.origin;
  const out = { title: document.title, text: '', pseudoContent: [], fieldValues: [], attributes: [], urls: [], uninspectable: [] };
  const ATTRS = ['title', 'href', 'src', 'srcset', 'alt', 'aria-label', 'aria-description', 'placeholder', 'value', 'data-tooltip'];
  const texts = [];

  const sameOrigin = (u) => {
    if (!u) return true;
    if (/^(data|blob):/i.test(u)) return true;
    try {
      return new URL(u, origin).origin === origin;
    } catch (e) {
      return false;
    }
  };

  function visit(root) {
    const all = root.querySelectorAll('*');
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      if (['canvas', 'iframe', 'frame', 'embed', 'object', 'video'].includes(tag)) out.uninspectable.push({ tag, reason: 'content is not text' });
      for (const name of ATTRS) {
        const v = el.getAttribute(name);
        if (v) out.attributes.push(`${name}=${v}`);
      }
      if (tag === 'img' || tag === 'image' || tag === 'source') {
        const src = el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('xlink:href');
        if (src) {
          out.urls.push(src);
          if (!sameOrigin(src)) out.uninspectable.push({ tag, reason: 'image from another site' });
        }
      }
      if (tag === 'a' && el.getAttribute('href')) out.urls.push(el.getAttribute('href'));
      if (tag === 'input' || tag === 'textarea' || tag === 'select') out.fieldValues.push(String(el.value || ''));
      const style = window.getComputedStyle(el);
      const bg = style.backgroundImage;
      if (bg && bg !== 'none') {
        for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
          out.urls.push(m[1]);
          if (!sameOrigin(m[1])) out.uninspectable.push({ tag, reason: 'background image from another site' });
        }
      }
      for (const pseudo of ['::before', '::after']) {
        const c = window.getComputedStyle(el, pseudo).content;
        if (c && c !== 'none' && c !== 'normal' && c !== '""') out.pseudoContent.push(c);
      }
      if (el.shadowRoot) {
        texts.push(el.shadowRoot.textContent || '');
        visit(el.shadowRoot);
      }
    }
  }

  texts.push(document.documentElement.textContent || '');
  visit(document);
  out.text = texts.join('\n');
  return out;
}
/* eslint-enable no-undef */

/**
 * @param snapshot a collectSnapshot() result, plus `apiBodies: [{url, body}]`
 * @param terms deny-list terms from loadDenyList
 * @returns {{ok:boolean, leaks:Array<{source:string, line:number}>, uninspectable:Array}}
 */
function checkSnapshot(snapshot, terms) {
  const sources = [
    ['title', [snapshot.title]],
    ['text', [snapshot.text]],
    ['generated content', snapshot.pseudoContent || []],
    ['field value', snapshot.fieldValues || []],
    ['attribute', snapshot.attributes || []],
    ['url', snapshot.urls || []],
    ...(snapshot.apiBodies || []).map((b) => [`api ${b.url}`, [b.body]]),
  ];
  const leaks = [];
  for (const [source, values] of sources) {
    const hay = normalize(values.join('\n'));
    for (const term of terms) {
      if (term.norm && hay.includes(term.norm)) leaks.push({ source, line: term.line });
    }
  }
  const uninspectable = snapshot.uninspectable || [];
  return { ok: leaks.length === 0 && uninspectable.length === 0, leaks, uninspectable };
}

module.exports = { collectSnapshot, checkSnapshot };
