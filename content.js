/*
 * S1 Lumen · content script (runs at document_start, before the HTML parser starts)
 *
 * Why the page no longer flashes:
 *
 *  1. All CSS is declared in the manifest, so Chrome attaches it before the DOM
 *     exists. Style managers like Stylus inject over an async round trip, which
 *     is what lets a frame of the original white theme reach the screen.
 *  2. Settings are read synchronously from localStorage right here, so the theme
 *     attribute is on <html> before anything can paint. chrome.storage is async,
 *     so it stays the source of truth and is only mirrored into localStorage.
 *  3. A render-blocking <link rel="expect"> holds the first paint until the main
 *     content is parsed. Chrome keeps showing the previous page meanwhile, so a
 *     half-parsed page never appears. A timeout releases it on slow connections.
 *  4. DOM tweaks run inside that hold, so they also land before the first paint.
 */
(() => {
  'use strict';

  const KEY = 's1lumen:v1';
  const DEFAULTS = {
    theme: 'auto',        // auto | light | dark
    postSize: 17,         // px
    width: 'wide',        // standard | wide, thread pages only
    pageFade: true,
    signature: false,
    relativeTime: true,
    railHidden: false,
  };
  // While the gate holds, Chrome shows the old page and drops clicks on it, so it stays short.
  const GATE_TIMEOUT_MS = 600;

  const root = document.documentElement;
  const hasExtensionApi = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };

  /* ---------------------------------------------------------------- settings */

  const readMirror = () => {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  };
  const writeMirror = (value) => {
    try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* private mode */ }
  };

  let settings = { ...DEFAULTS, ...readMirror() };

  const applySettings = (s) => {
    if (s.theme === 'auto') delete root.dataset.lumenTheme;
    else root.dataset.lumenTheme = s.theme;
    root.dataset.lumenWidth = s.width === 'standard' ? 'standard' : 'wide';
    root.dataset.lumenSignature = s.signature ? 'on' : 'off';
    if (s.railHidden) root.dataset.lumenRail = 'hidden';
    else delete root.dataset.lumenRail;
    root.style.setProperty('--post-size', `${s.postSize}px`);
  };

  applySettings(settings);

  const adoptSettings = (next) => {
    const merged = { ...DEFAULTS, ...next };
    const changed = JSON.stringify(merged) !== JSON.stringify(settings);
    const timeChanged = merged.relativeTime !== settings.relativeTime;
    settings = merged;
    writeMirror(merged);
    if (!changed) return;
    applySettings(merged);
    if (timeChanged) refreshTimes();
    const editor = document.getElementById('e_iframe');
    if (editor) paintEditor(editor);
  };

  if (hasExtensionApi()) {
    chrome.storage.sync.get(KEY).then((stored) => {
      if (stored[KEY]) adoptSettings(stored[KEY]);
      else chrome.storage.sync.set({ [KEY]: settings });
    }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes[KEY]?.newValue) adoptSettings(changes[KEY].newValue);
    });
  }

  const saveSettings = (patch) => {
    adoptSettings({ ...settings, ...patch });
    if (hasExtensionApi()) chrome.storage.sync.set({ [KEY]: settings }).catch(() => {});
  };

  /* ------------------------------------------------------------- render gate */

  // search.php has its own template with no rail. A :has(#hd) test on <body> would say
  // the same, but it doubled style recalculation on every page.
  if (location.pathname.endsWith('/search.php')) root.dataset.lumenBare = '';

  const pageKind = (() => {
    const url = location.pathname + location.search;
    if (/thread-\d+|mod=viewthread|mod=redirect/.test(url)) return 'thread';
    if (/forum-\d+|mod=forumdisplay/.test(url)) return 'forum';
    return 'other';
  })();

  // The last element of the main content on each page type. It sits before the
  // third-party scripts at the end of the page, so those cannot delay the paint.
  const gateId = { thread: 'postlistreply', forum: 'fd_page_bottom', other: 'ft' }[pageKind];

  const gate = document.createElement('link');
  gate.rel = 'expect';
  gate.href = `#${gateId}`;
  gate.setAttribute('blocking', 'render');
  root.appendChild(gate);
  setTimeout(() => gate.remove(), GATE_TIMEOUT_MS);

  /* --------------------------------------------------------- view transitions */

  addEventListener('pagereveal', (event) => {
    if (event.viewTransition && !settings.pageFade) event.viewTransition.skipTransition();
  });

  /* ------------------------------------------------------------- DOM helpers */

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  };

  /* -------------------------------------------------------------------- rail */

  const effectiveTheme = () => {
    if (settings.theme !== 'auto') return settings.theme;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };

  const setTheme = (theme) => {
    const apply = () => saveSettings({ theme });
    const animate = document.startViewTransition
      && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (animate) document.startViewTransition(apply);
    else apply();
  };

  const toggleTheme = () => setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');

  // The slide only runs on a click, never when a page loads with the rail already hidden.
  const toggleRail = () => {
    const content = document.getElementById('ct');
    const before = content?.getBoundingClientRect().left;
    root.dataset.lumenRailMoving = '';
    saveSettings({ railHidden: !settings.railHidden });
    setTimeout(() => delete root.dataset.lumenRailMoving, 240);

    // The page reflows once, then glides from its old spot on the compositor.
    // Animating the padding instead would lay out a whole thread on every frame.
    if (!content || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const shift = before - content.getBoundingClientRect().left;
    const easing = getComputedStyle(root).getPropertyValue('--ease').trim() || 'ease';
    for (const part of [document.getElementById('wp'), document.getElementById('ft')]) {
      part?.animate([{ transform: `translateX(${shift}px)` }, { transform: 'none' }], { duration: 200, easing });
    }
  };

  const boardId = (href) => href?.match(/forum-(\d+)-|[?&]fid=(\d+)/)?.slice(1).find(Boolean);

  // Runs once the breadcrumbs exist, so a thread lights up the board it belongs to.
  const markRail = () => {
    // The page's own board first, then the breadcrumbs from the deepest level up.
    const trail = [location.href, ...$$('#pt .z a').reverse().map((link) => link.getAttribute('href'))]
      .map(boardId).filter(Boolean);
    if (!trail.length) return;
    const links = $$('#nv > ul > li > a');
    const current = trail.map((id) => links.find((link) => boardId(link.getAttribute('href')) === id)).find(Boolean);
    if (!current) return;
    $$('#nv li.a').forEach((item) => item.classList.remove('a'));
    current.parentElement.classList.add('a');
  };

  const navSection = (label, items) => el('div', { class: 'lumen-section' },
    el('div', { class: 'lumen-label' }, label),
    el('ul', {}, ...items.map(({ href, text, icon, active, badge }) => el('li', { class: active ? 'a' : '' },
      el('a', { href, 'data-icon': icon }, text,
        ...(badge ? [el('span', { class: 'lumen-badge' }, badge === true ? '' : badge)] : []))))));

  const buildRail = () => {
    const nav = $('#nv');
    const list = $('#nv > ul');
    if (!nav || !list || nav.dataset.lumenReady) return;
    nav.dataset.lumenReady = '1';

    const isHome = document.body?.classList.contains('pg_index');
    list.prepend(el('li', { class: isHome ? 'a' : '' }, el('a', { href: 'forum.php', 'data-icon': 'home' }, '全部板块')));

    // Hover submenus do not suit a vertical rail, so sub-boards become plain rows.
    for (const item of document.querySelectorAll('#nv > ul > li[id]')) {
      item.removeAttribute('onmouseover');
      const menu = document.getElementById(`${item.id}_menu`);
      if (!menu) continue;
      item.after(...[...menu.querySelectorAll('a')].map((link) => el('li', { class: 'lumen-sub' },
        el('a', { href: link.getAttribute('href') }, link.textContent))));
    }

    const here = location.href;
    const icons = { 帖子: 'post', 收藏: 'star', 好友: 'users' };
    const mine = $$('#myitem_menu a').map((link) => ({
      href: link.getAttribute('href'),
      text: link.textContent,
      icon: icons[link.textContent.trim()] || 'post',
      active: here.includes(link.getAttribute('href')),
    }));

    // Messages and notices live with the other destinations, with their unread count.
    const unread = (link) => link?.textContent.match(/\d+/)?.[0] ?? link?.classList.contains('new');
    for (const [selector, text, icon] of [['#pm_ntc', '消息', 'mail'], ['#myprompt', '提醒', 'bell']]) {
      const link = $(`#um ${selector}`);
      if (!link) continue;
      const href = link.getAttribute('href');
      mine.push({ href, text, icon, active: here.includes(href), badge: unread(link) });
    }
    if (mine.length) nav.append(navSection('我的', mine));

    const railToggle = el('button', { type: 'button', class: 'lumen-rail-toggle', title: '折叠或展开侧边栏（⌘B）', 'aria-label': '折叠或展开侧边栏' });
    railToggle.addEventListener('click', toggleRail);
    document.body.append(railToggle);

    const account = $('#um');
    if (account) {
      $('#hd .wp')?.append(buildUserMenu(account));
    } else {
      const button = el('button', {
        type: 'button',
        class: 'lumen-theme',
        title: '切换亮暗主题',
        'aria-label': '切换亮暗主题',
      });
      button.addEventListener('click', toggleTheme);
      $('#hd .wp')?.append(el('div', { id: 'lumen-guest' },
        el('a', { class: 'lumen-login', href: 'member.php?mod=logging&action=login' }, '登录'),
        el('a', { class: 'lumen-register', href: 'member.php?mod=register' }, '注册'),
        button));
    }
  };

  /* --------------------------------------------------------------- account menu */

  // One row in the rail; everything account-related opens above it. Discuz keeps its
  // own #um in the page (hidden) because its scripts still read and update it.
  const buildUserMenu = (account) => {
    const name = $('.vwmy a', account);
    const space = name?.getAttribute('href') ?? '#';
    const avatar = () => el('img', { class: 'lumen-avatar', src: $('.avt img', account)?.src ?? '', alt: '' });
    const group = $('#g_upmine', account)?.textContent.replace(/^用户组:\s*/, '').trim() ?? '';
    const credits = $('#extcreditmenu', account)?.textContent.trim() ?? '';
    const item = (href, text, icon) => el('a', { class: 'lumen-menu-item', href, 'data-icon': icon }, text);

    const modes = [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([mode, title]) => {
      const button = el('button', { type: 'button', title, 'aria-label': title });
      button.dataset.mode = mode;
      button.addEventListener('click', () => setTheme(mode));
      return button;
    });

    const menu = el('div', { class: 'lumen-menu', hidden: true },
      el('a', { class: 'lumen-menu-head', href: space }, avatar(),
        el('span', { class: 'lumen-user-text' },
          el('strong', {}, name?.textContent ?? ''),
          el('small', {}, credits || group))),
      el('hr'),
      item(space, '个人空间', 'user'),
      item('home.php?mod=spacecp', '设置', 'gear'),
      el('div', { class: 'lumen-menu-theme' }, '主题', el('div', { class: 'lumen-seg' }, ...modes)),
      el('hr'),
      item($('a[href*="action=logout"]', account)?.getAttribute('href') ?? '#', '退出登录', 'exit'));

    const toggle = el('button', { type: 'button', class: 'lumen-user-btn', 'aria-expanded': 'false' }, avatar(),
      el('span', { class: 'lumen-user-text' },
        el('strong', {}, name?.textContent ?? ''),
        el('small', {}, group)));

    const setOpen = (open) => {
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    };
    const box = el('div', { class: 'lumen-user' }, menu, toggle);
    toggle.addEventListener('click', () => setOpen(menu.hidden));
    document.addEventListener('click', ({ target }) => {
      if (!box.contains(target)) setOpen(false);
    });
    document.addEventListener('keydown', ({ key }) => {
      if (key === 'Escape') setOpen(false);
    });
    return box;
  };

  /* -------------------------------------------------------------- relative time */

  // The forum prints times in Beijing time regardless of where the reader is.
  const parseForumTime = (text) => {
    const m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (!m) return null;
    const [, y, mo, d, h = 0, mi = 0] = m.map((v) => (v === undefined ? undefined : +v));
    return new Date(Date.UTC(y, mo - 1, d, h - 8, mi));
  };

  const pad = (n) => String(n).padStart(2, '0');

  const relative = (date) => {
    const seconds = (Date.now() - date) / 1000;
    if (seconds < 0) return null;
    if (seconds < 60) return '刚刚';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
    const bj = new Date(date.getTime() + 8 * 3600e3);
    const nowBj = new Date(Date.now() + 8 * 3600e3);
    const days = Math.round((Date.UTC(nowBj.getUTCFullYear(), nowBj.getUTCMonth(), nowBj.getUTCDate())
      - Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate())) / 86400e3);
    if (days === 1) return `昨天 ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
    if (days < 7) return `${days} 天前`;
    const md = `${bj.getUTCMonth() + 1}月${bj.getUTCDate()}日`;
    return bj.getUTCFullYear() === nowBj.getUTCFullYear() ? md : `${bj.getUTCFullYear()}年${md}`;
  };

  const TIME_SELECTORS = [
    '#threadlisttableid td.by em > span',
    '#threadlisttableid td.by em > a',
    '[id^=authorposton]',
    '.fl_g cite',
    '.fl_g dd > a:not(.xi2)',
  ].join(',');

  const formatTime = (node) => {
    if (!node.dataset.lumenTime) {
      // Discuz wraps recent times as <span title="2026-11-6 10:01">半小时前</span>.
      const titled = node.querySelector?.('span[title]');
      const raw = titled?.title || node.title || node.textContent;
      const match = raw.match(/\d{4}-\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2})?/);
      if (!match) return;
      node.dataset.lumenTime = match[0];
      // "<cite>time <a>name</a></cite>": only touch the leading text node.
      if (node.matches('.fl_g cite')) node.dataset.lumenTimeNode = '1';
      if (node.matches('.fl_g dd > a')) node.dataset.lumenPrefix = '最后发表 ';
    }
    const raw = node.dataset.lumenTime;
    const date = parseForumTime(raw);
    const shown = settings.relativeTime && date ? (relative(date) ?? raw) : raw;
    if (node.dataset.lumenTimeNode) {
      const text = [...node.childNodes].find((child) => child.nodeType === 3 && child.textContent.trim());
      if (text) text.textContent = `${shown} · `;
    } else {
      node.textContent = `${node.dataset.lumenPrefix ?? ''}${shown}`;
    }
    node.title = raw;
  };

  const refreshTimes = () => $$(TIME_SELECTORS).forEach(formatTime);

  /* ------------------------------------------------------- user-coloured text */

  const channel = (v) => {
    const c = v / 255;
    return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]) => .2126 * channel(r) + .7152 * channel(g) + .0722 * channel(b);
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + .05) / (lo + .05);
  };
  const mix = (from, to, t) => from.map((v, i) => Math.round(v + (to[i] - v) * t));
  const toCss = (rgb) => `rgb(${rgb.join(' ')})`;

  // Keep the author's hue, but move it just far enough to stay readable. Greys carry
  // no meaning of their own, so an unreadable grey simply becomes normal body text.
  const fitTo = (rgb, background, target) => {
    if (contrast(rgb, background) >= 4.5) return rgb;
    if (Math.max(...rgb) - Math.min(...rgb) < 24) return target;
    for (let t = .1; t <= 1; t += .1) {
      const candidate = mix(rgb, target, t);
      if (contrast(candidate, background) >= 5) return candidate;
    }
    return target;
  };

  const sameColour = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 10);

  const PAPER = [255, 255, 255];
  const NIGHT = [14, 12, 17];
  const INK_DARK = [31, 26, 36];
  const INK_LIGHT = [244, 240, 235];
  const SITE_BG = [246, 247, 235];

  const parseRgb = (value) => {
    const m = value.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  };

  const fixColours = (scope = document) => {
    for (const node of $$('.t_f font[color], .t_f [style*="color"]', scope)) {
      if (node.dataset.lumenColor || node.closest('.quote font[size]')) continue;
      node.dataset.lumenColor = '1';
      // `[style*="color"]` also matches background-color; only real text colours count.
      if (!node.getAttribute('color') && !node.style.color) continue;
      const rgb = parseRgb(getComputedStyle(node).color);
      if (!rgb) continue;
      // White or page-coloured text is the forum's spoiler idiom. Keep it hidden.
      if (sameColour(rgb, PAPER) || sameColour(rgb, SITE_BG)) {
        node.dataset.lumenSpoiler = '1';
        continue;
      }
      node.style.setProperty('--c-light', toCss(fitTo(rgb, PAPER, INK_DARK)));
      node.style.setProperty('--c-dark', toCss(fitTo(rgb, NIGHT, INK_LIGHT)));
    }
  };

  /* --------------------------------------------------------------- thread page */

  const markAuthors = () => {
    const tid = (location.href.match(/thread-(\d+)/) || location.href.match(/[?&]tid=(\d+)/))?.[1];
    const posts = $$('#postlist > div[id^=post_]');
    if (!posts.length) return;

    const authorOf = (post) => $('.favatar .authi a', post)?.getAttribute('href') ?? null;
    const isFirstFloor = $('[id^=postnum]', posts[0])?.textContent.includes('楼主');
    const storageKey = `s1lumen:op:${tid}`;
    if (isFirstFloor && tid) {
      try { sessionStorage.setItem(storageKey, authorOf(posts[0]) ?? ''); } catch { /* ignore */ }
    }
    let op = isFirstFloor ? authorOf(posts[0]) : null;
    if (!op) {
      try { op = sessionStorage.getItem(storageKey); } catch { /* ignore */ }
    }
    if (!op) return;
    for (const post of posts) {
      if (authorOf(post) === op) post.dataset.lumenOp = '1';
    }
  };

  const buildThreadBar = () => {
    const bar = $('#pgt');
    if (!bar || $('.lumen-crumb', bar)) return;
    // Breadcrumbs end with "... / board / thread title".
    const board = $$('#pt .z > a').at(-2);
    if (board) {
      bar.prepend(el('a', { class: 'lumen-crumb', href: board.getAttribute('href') }, board.textContent));
    }
    const subject = $('#thread_subject');
    if (subject) bar.append(el('span', { class: 'lumen-bar-title' }, subject.textContent));
    if ($('#um') && !$('#post_reply', bar)) {
      const reply = el('a', { class: 'lumen-reply', href: '#f_pst' }, '回复');
      reply.addEventListener('click', () => {
        requestAnimationFrame(() => $('#fastpostmessage')?.focus({ preventScroll: true }));
      });
      bar.append(reply);
    }
  };

  const tidyPostMeta = () => {
    for (const span of $$('.pti .authi .xg1, .pti .authi em')) {
      if (!span.id && span.textContent.includes('来自')) span.classList.add('lumen-device');
    }

    // Blank lines left at the end of a post read as a broken gap above the divider.
    for (const body of $$('.t_f')) {
      let last = body.lastChild;
      while (last && (last.nodeName === 'BR' || (last.nodeType === 3 && !last.textContent.trim()))) {
        last.remove();
        last = body.lastChild;
      }
    }

    // Discuz spells the button out with non-breaking spaces.
    const next = $('.pgbtn a');
    if (next) next.textContent = next.textContent.replace(/[\s »]/g, '');
  };

  /* --------------------------------------------------------------- forum index */

  // The board banner is a random picture, so it waits behind a button.
  const foldBoardRules = () => {
    const rules = $('[id^="forum_rules_"]:not([id$="_img"])');
    if (!rules || rules.dataset.lumenFolded) return;
    rules.dataset.lumenFolded = '1';

    // Hand-written tables pad themselves with cells holding only "_".
    for (const cell of $$('td', rules)) {
      if (/^[_\s]*$/.test(cell.textContent) && !cell.querySelector('img')) cell.hidden = true;
    }

    const images = $$('img', rules).filter((image) => !image.hasAttribute('smilieid'));
    if (!rules.textContent.trim() && !images.length) return;

    // The rules wait behind a button in the board header, next to 收藏 and 订阅.
    rules.classList.add('lumen-rules-folded');
    const show = el('button', { type: 'button', class: 'lumen-rules-btn', 'aria-expanded': 'false' }, '版规');
    show.addEventListener('click', () => {
      const folded = rules.classList.toggle('lumen-rules-folded');
      show.setAttribute('aria-expanded', String(!folded));
    });
    const actions = $('.fa_fav, .fa_rss')?.parentElement;
    if (actions) actions.prepend(show);
    else rules.classList.remove('lumen-rules-folded');

    if (!images.length) return;
    rules.classList.add('lumen-images-folded');
    const toggle = el('button', { type: 'button', class: 'lumen-fold' }, '显示随机图');
    toggle.addEventListener('click', () => {
      const folded = rules.classList.toggle('lumen-images-folded');
      toggle.textContent = folded ? '显示随机图' : '收起随机图';
    });
    images[0].before(toggle);
  };

  const tidyIndex = () => {
    foldBoardRules();
    for (const count of $$('.fl_g dt em, .fl_tb h2 em')) count.textContent = count.textContent.replace(/[()\s]/g, '');

    // " - [阅读权限 <b>60</b>]" is three loose pieces; one small tag reads better.
    for (const level of $$('#threadlisttableid th > .xw1')) {
      const before = level.previousSibling;
      const after = level.nextSibling;
      if (before?.nodeType !== Node.TEXT_NODE || !before.textContent.includes('阅读权限')) continue;
      before.remove();
      if (after?.nodeType === Node.TEXT_NODE) after.remove();
      level.className = 'lumen-perm';
      level.textContent = `权限 ${level.textContent}`;
    }

    // The stats line ends with "欢迎新会员: name"; the numbers are all that is useful.
    const chart = $('#chart .chart');
    if (!chart) return;
    const nodes = [...chart.childNodes];
    const start = nodes.findIndex((node) => node.textContent.includes('欢迎新会员'));
    if (start >= 0) nodes.slice(start).forEach((node) => node.remove());
    const tail = [...chart.children].at(-1);
    if (tail?.classList.contains('pipe')) tail.remove();
    chart.querySelector('svg, img, i')?.remove();
  };

  /* -------------------------------------------------------------------- search */

  const bindKeys = () => {
    addEventListener('keydown', (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
      // Inside a text field this stays the editor's bold shortcut.
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b' && !typing) {
        event.preventDefault();
        toggleRail();
        return;
      }
      const palette = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
      if (palette || (event.key === '/' && !typing)) {
        const input = $('#scbar_txt');
        if (!input) return;
        event.preventDefault();
        input.focus();
        input.select();
      } else if (event.key === 'Escape' && event.target.id === 'scbar_txt') {
        event.target.blur();
      }
    });
  };

  /* ------------------------------------------------------------ editor iframe */

  // editor.js fills this frame with document.write, which wipes anything added earlier,
  // so it is styled on every load. CSS keeps it hidden until its real document is styled.
  const paintEditor = (frame) => {
    const doc = frame.contentDocument;
    if (!doc?.head) return;
    const tokens = getComputedStyle(root);
    const sheet = doc.getElementById('lumen-editor') ?? doc.head.appendChild(el('style', { id: 'lumen-editor' }));
    sheet.textContent = `
      :root { color-scheme: ${tokens.colorScheme}; }
      body { margin: 12px 14px !important; background: transparent !important; color: ${tokens.getPropertyValue('--ink')} !important;
             font: 15px/1.7 ${tokens.getPropertyValue('--font-ui')}; }
      a { color: ${tokens.getPropertyValue('--accent-text')}; }`;
    if (doc.querySelector('link[href*="wysiwyg"]')) frame.dataset.lumenReady = '';
  };

  /* --------------------------------------------------------------------- polls */

  // Discuz posts a vote into a hidden frame and expects an XML reply. S1 answers a good
  // vote with an ordinary page, Discuz's handler throws on it, and the page just sits
  // there until a manual refresh. So: reload after a vote, unless the reply is a refusal,
  // which Discuz shows by itself.
  let votePending = false;
  document.addEventListener('submit', ({ target }) => {
    if (target.id === 'poll') votePending = true;
  }, true);
  const finishVote = (frame) => {
    const reply = frame.contentDocument;
    // The frame fires one load for about:blank as soon as Discuz inserts it.
    if (reply?.URL === 'about:blank') return;
    votePending = false;
    const refused = reply?.contentType.includes('xml')
      && /ajaxerror|errorhandle_|alert_error/.test(reply.documentElement.textContent);
    if (!refused) location.reload();
  };

  /* --------------------------------------------------------------------- login */

  // Login goes through the same hidden frame and stalls the same way. The reply's format
  // says little, so ask the forum instead: a fresh page shows the account bar once the
  // session exists. Wrong passwords and security questions stay with Discuz.
  let loginPending = false;
  document.addEventListener('submit', ({ target }) => {
    if (target.matches?.('form[name="login"], #lsform, form[action*="mod=logging"]')) loginPending = true;
  }, true);
  const finishLogin = async (frame) => {
    if (frame.contentDocument?.URL === 'about:blank') return;
    loginPending = false;
    const page = await fetch('forum.php', { credentials: 'same-origin' }).then((reply) => reply.text()).catch(() => '');
    if (!page.includes('id="um"')) return;
    const back = $('input[name="referer"]')?.value;
    if (/mod=logging/.test(location.href)) location.href = back && !/mod=logging/.test(back) ? back : 'forum.php';
    else location.reload();
  };

  document.addEventListener('load', ({ target }) => {
    if (target.id === 'e_iframe') paintEditor(target);
    if (target.id === 'ajaxframe' && votePending) finishVote(target);
    if (target.id === 'ajaxframe' && loginPending) finishLogin(target);
  }, true);

  /* ------------------------------------------------------------------ prefetch */

  // Hovering a board link fetches that board ahead of the click. Threads are left out:
  // a prefetch would count as a view.
  // In the top bar the boards scroll sideways; keep the current one in view.
  const centreBoard = () => {
    if (!matchMedia('(max-width: 960px)').matches) return;
    const nav = document.getElementById('nv');
    const active = nav?.querySelector('li.a');
    if (!active) return;
    const box = nav.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    nav.scrollLeft += item.left - box.left - (box.width - item.width) / 2;
  };

  const addPrefetch = () => {
    if (!HTMLScriptElement.supports?.('speculationrules')) return;
    const rules = el('script', { type: 'speculationrules' });
    rules.textContent = JSON.stringify({
      prefetch: [{
        where: { and: [{ href_matches: '/2b/forum-*' }, { selector_matches: '#nv a, .pg a' }] },
        eagerness: 'moderate',
      }],
    });
    document.head.append(rules);
  };

  /* ------------------------------------------------------------------ pipeline */

  const polish = (scope = document) => {
    markRail();
    refreshTimes();
    fixColours(scope);
    if (pageKind === 'thread') {
      buildThreadBar();
      markAuthors();
      tidyPostMeta();
    } else {
      tidyIndex();
    }
  };

  let railDone = false;
  let contentDone = false;

  // Both landmarks are parsed before the render gate opens, so this observer
  // finishes its work inside the hold and nothing moves after the first paint.
  const parseWatcher = new MutationObserver(() => {
    if (!railDone && document.getElementById('wp')) {
      railDone = true;
      buildRail();
    }
    if (!contentDone && document.getElementById(gateId)) {
      contentDone = true;
      polish();
      parseWatcher.disconnect();
    }
  });
  parseWatcher.observe(root, { childList: true, subtree: true });

  document.addEventListener('DOMContentLoaded', () => {
    parseWatcher.disconnect();
    if (!railDone) buildRail();
    polish();
    bindKeys();

    addPrefetch();
    centreBoard();

    // "下一页" appends posts and threads in place, and quick reply adds new posts.
    let queued = false;
    const dynamic = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        polish();
      });
    });
    for (const target of [$('#threadlisttableid'), $('#postlist')]) {
      if (target) dynamic.observe(target, { childList: true });
    }
  });
})();
