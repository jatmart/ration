// Brave and Chrome name the same settings differently.
const isBrave = 'brave' in navigator;
export const EXTENSIONS_PAGE = isBrave ? 'brave://extensions' : 'chrome://extensions';
export const PRIVATE_SETTING = isBrave ? 'Allow in Private' : 'Allow in Incognito';

export async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (res === undefined) throw new Error(`No reply to ${type}`);
  return res;
}

export function getState() {
  return send('getState');
}

export function incognitoAllowed() {
  return new Promise((resolve) => {
    try {
      chrome.extension.isAllowedIncognitoAccess(resolve);
    } catch {
      resolve(true);
    }
  });
}

// The egg timer logo. The page's stylesheet sets its size.
export function logo() {
  return el('img', { class: 'logo', src: '../../icons/icon48.png?v=egg2', srcset: '../../icons/icon48.png?v=egg2 1x, ../../icons/icon128.png?v=egg2 2x', alt: '' });
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
