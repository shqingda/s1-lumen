/*
 * S1 Lumen · settings shared by the content script and the popup
 *
 * storage.sync allows 8 KB for one item, and the block lists can outgrow that on their own.
 * So the settings item keeps the small values, and the lists are cut into numbered parts
 * written in the same call. The settings item says how many parts there are, which makes
 * leftovers from a longer list harmless until they are cleared.
 */
globalThis.S1Lumen = (() => {
  'use strict';

  const KEY = 's1lumen:v1';
  const PART = `${KEY}:part:`;
  const LISTS = ['blockUsers', 'blockWords'];
  // Under 8192 with room for the key. Each character is costed as the JSON escape it could
  // become, which is never less than what Chrome actually counts.
  const PART_BYTES = 7600;

  const DEFAULTS = Object.freeze({
    theme: 'auto',        // auto | light | dark
    dayPalette: 'lumen',  // lumen | classic, the colours of the light theme
    postSize: 16,         // px
    nightText: 'off',     // off | auto | manual, how bright white text is at night
    nightWhite: 81,       // manual: the lightness of body text, in percent
    width: 'wide',        // standard | wide, thread pages only
    pageFade: false,
    threadMorph: true,
    signature: false,
    relativeTime: true,
    avatarShape: 'circle', // circle | rounded
    resume: true,
    railHidden: false,
    showSensitive: false, // images in NSFW threads, unless the thread says otherwise
    appLogin: true,       // a login also fetches the App API token, for hidden posts
    blockUsers: [],       // { id, name }
    blockWords: [],
  });

  const withDefaults = (value) => ({ ...DEFAULTS, ...value });

  const cost = (char) => (char.charCodeAt(0) < 0x80 ? JSON.stringify(char).length - 2 : 6);

  // By code point, so a part never ends between the two halves of an emoji.
  const cut = (text) => {
    const parts = [];
    let part = '';
    let bytes = 0;
    for (const char of text) {
      const size = cost(char);
      if (bytes + size > PART_BYTES) {
        parts.push(part);
        part = '';
        bytes = 0;
      }
      part += char;
      bytes += size;
    }
    if (part) parts.push(part);
    return parts;
  };

  const pack = (settings) => {
    const main = { ...settings };
    const lists = {};
    for (const name of LISTS) {
      lists[name] = main[name];
      delete main[name];
    }
    const parts = cut(JSON.stringify(lists));
    main.parts = parts.length;
    return Object.fromEntries([[KEY, main], ...parts.map((part, at) => [`${PART}${at}`, part])]);
  };

  // Items written before the lists moved out still carry them, and no parts.
  const unpack = (items) => {
    const main = items[KEY];
    if (!main) return null;
    const { parts, ...settings } = main;
    if (parts) {
      try {
        Object.assign(settings, JSON.parse(Array.from({ length: parts }, (_, at) => items[`${PART}${at}`] ?? '').join('')));
      } catch { /* a part is missing: keep the rest */ }
    }
    return withDefaults(settings);
  };

  const load = async () => unpack(await chrome.storage.sync.get(null));

  // One at a time: a cleanup that ran after a newer, longer write would delete its parts.
  let queue = Promise.resolve();
  const write = async (items) => {
    await chrome.storage.sync.set(items);
    const stale = Object.keys(await chrome.storage.sync.get(null))
      .filter((key) => key.startsWith(PART) && !(key in items));
    if (stale.length) await chrome.storage.sync.remove(stale);
  };
  const save = (settings) => {
    const items = pack(settings);
    const done = queue.then(() => write(items));
    queue = done.catch(() => {});
    return done;
  };

  // Calls back with the whole settings after any change, wherever it was made. Chrome only
  // reports the items whose value changed, so a list edit may touch nothing but a part.
  const watch = (callback) => {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !Object.keys(changes).some((key) => key === KEY || key.startsWith(PART))) return;
      load().then((settings) => settings && callback(settings)).catch(() => {});
    });
  };

  return Object.freeze({ KEY, DEFAULTS, withDefaults, load, save, watch, pack, unpack });
})();
