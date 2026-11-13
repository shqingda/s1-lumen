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

  // shared.js runs first and holds the defaults and the storage format, which the popup shares.
  const { KEY, withDefaults } = S1Lumen;
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

  let settings = withDefaults(readMirror());

  // Astigmatism spreads bright strokes into the dark around them, and the halo is a share of the
  // text's own light, so dimming white text shrinks it. Only the night text tokens change: no
  // element is visited and nothing keeps watching the page. Day never reads them, so it needs no check.
  // Lightness is OKLCH L. Above the knee, L' = K + d / (1 + B·d) with d = L - K, as in Mellow:
  // the tiers stay in order and greys near the knee barely move.
  const NIGHT_KNEE = .65;
  const NIGHT_INK = .985; // #fafafa
  // APCA Lc 68 on #171717 panels, and about 69 on the #0a0a0a page. Lumen owns those backgrounds,
  // so this is worked out here once and not measured on every page. popup.js resets to the same value.
  const NIGHT_AUTO = .81;
  const NIGHT_TIERS = {
    '--night-ink': NIGHT_INK,
    '--night-ink-2': .922,
    '--night-amber': .87,
    '--night-muted': .709,
  };

  const nightGrey = (lightness, white) => {
    const top = NIGHT_INK - NIGHT_KNEE;
    const slope = (top / (white - NIGHT_KNEE) - 1) / top;
    const d = lightness - NIGHT_KNEE;
    const soft = NIGHT_KNEE + d / (1 + slope * d);
    const value = Math.round((1.055 * soft ** (3 / 2.4) - .055) * 255);
    return `rgb(${value} ${value} ${value})`;
  };

  const applyNightText = (s) => {
    const white = { auto: NIGHT_AUTO, manual: s.nightWhite / 100 }[s.nightText];
    for (const [name, lightness] of Object.entries(NIGHT_TIERS)) {
      if (white) root.style.setProperty(name, nightGrey(lightness, white));
      else root.style.removeProperty(name);
    }
  };

  const applySettings = (s) => {
    root.toggleAttribute('data-lumen-fade', s.pageFade);
    if (s.theme === 'auto') delete root.dataset.lumenTheme;
    else root.dataset.lumenTheme = s.theme;
    if (s.dayPalette === 'classic') root.dataset.lumenPalette = 'classic';
    else delete root.dataset.lumenPalette;
    root.dataset.lumenWidth = s.width === 'standard' ? 'standard' : 'wide';
    root.dataset.lumenSignature = s.signature ? 'on' : 'off';
    root.dataset.lumenAvatar = s.avatarShape === 'rounded' ? 'rounded' : 'circle';
    if (s.railHidden) root.dataset.lumenRail = 'hidden';
    else delete root.dataset.lumenRail;
    root.style.setProperty('--post-size', `${s.postSize}px`);
    applyNightText(s);
  };

  applySettings(settings);

  // Only the parts of the page a changed setting reaches are redone.
  const adoptSettings = (next) => {
    const merged = withDefaults(next);
    const before = settings;
    const differs = (...names) => names.some((name) => JSON.stringify(merged[name]) !== JSON.stringify(before[name]));
    settings = merged;
    writeMirror(merged);
    if (!differs(...Object.keys(merged))) return;
    applySettings(merged);
    if (differs('relativeTime')) refreshTimes();
    if (differs('resume')) {
      if (!merged.resume) forgetReading();
      markRows();
    }
    if (differs('blockUsers', 'blockWords')) applyBlocks();
    if (differs('showSensitive')) applySensitive();
    if (differs('theme', 'dayPalette', 'nightText', 'nightWhite')) repaintEditor();
  };

  // Whether the stored block lists have all arrived. Until they have, the page keeps the lists
  // it already knows, and a save leaves the stored ones alone.
  let listsKnown = true;
  const adoptStored = (stored) => {
    listsKnown = S1Lumen.hasLists(stored);
    adoptSettings({ ...settings, ...stored });
  };

  if (hasExtensionApi()) {
    S1Lumen.load().then((stored) => {
      if (stored) adoptStored(stored);
      else S1Lumen.save(settings);
    }).catch(() => {});
    S1Lumen.watch(adoptStored);
  }

  const saveSettings = (patch) => {
    adoptSettings({ ...settings, ...patch });
    // A block added here starts from the lists this page knows, the best there is to go on.
    if ('blockUsers' in patch || 'blockWords' in patch) listsKnown = true;
    if (hasExtensionApi()) S1Lumen.save(listsKnown ? settings : S1Lumen.withoutLists(settings)).catch(() => {});
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

  /* ------------------------------------------------------- thread title morph */

  // A view transition suspends the new page while it runs, so only the trips in and out of a
  // thread get one. Both sides opt in for that single trip, and switching boards never pays for
  // it. The thread's title is carried across when it is on both pages. Turning a thread's page
  // gets none: the rail and toolbar stay where they are, so a fade only reads as a flash.
  const MORPH_KEY = 's1lumen:morph';
  // Transitions between pages arrived in Chrome 126. Before that a trip is a plain fade-in.
  const canMorph = 'CSSViewTransitionRule' in window;
  let morphId = null;
  let morphTitle = null;
  const morphRule = document.createElement('style');
  morphRule.textContent = '@media (prefers-reduced-motion: no-preference) { @view-transition { navigation: auto; } }';

  const startMorph = () => {
    root.dataset.lumenMorph = '';
    root.appendChild(morphRule);
  };
  const nameTitle = (node) => {
    node.style.viewTransitionName = 'lumen-title';
    morphTitle = node;
  };
  const endMorph = () => {
    delete root.dataset.lumenMorph;
    morphRule.remove();
    morphTitle?.style.removeProperty('view-transition-name');
    morphTitle = null;
    morphId = null;
  };

  try {
    morphId = sessionStorage.getItem(MORPH_KEY);
    if (morphId && canMorph) startMorph();
    else if (morphId) root.dataset.lumenTrip = '';
    sessionStorage.removeItem(MORPH_KEY);
  } catch { /* ignore */ }

  addEventListener('pagereveal', ({ viewTransition }) => {
    if (viewTransition) viewTransition.finished.then(endMorph, endMorph);
    else endMorph();
  });
  addEventListener('pageshow', ({ persisted }) => {
    if (persisted) endMorph();
  });

  /* ------------------------------------------------------------- DOM helpers */

  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // A left click with no modifier, which is what opens a link in this tab.
  const plainClick = (event) => !(event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);

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

  // Keys pressed in a dialog stay in it. The forum turns the page on ←/→ from document.onkeyup,
  // which would leave the page underneath a picture being stepped through.
  const openDialog = (dialog) => {
    for (const type of ['keydown', 'keyup']) dialog.addEventListener(type, (event) => event.stopPropagation());
    document.body.append(dialog);
    dialog.showModal();
  };

  /* ------------------------------------------------------------ page helpers */

  const threadOf = (url) => (url.match(/thread-(\d+)/) || url.match(/[?&]tid=(\d+)/))?.[1];
  const tid = threadOf(location.href);
  const postUrl = (thread, pid) => `forum.php?mod=redirect&goto=findpost&ptid=${thread}&pid=${pid}`;

  const POST = '#postlist > div[id^=post_]';
  const listPosts = () => $$(POST);
  const postById = (pid) => document.getElementById(`post_${pid}`);
  const pidOf = (post) => post.id.slice('post_'.length);
  const floorOf = (post) => {
    const label = $('[id^=postnum]', post)?.textContent ?? '';
    return label.includes('楼主') ? 1 : Number.parseInt(label, 10) || 0;
  };
  const threadRows = () => $$('tbody[id^="normalthread_"], tbody[id^="stickthread_"]');

  // Only one author's posts, or the thread in reverse: floors there are not a reading position.
  const filteredView = /[?&](authorid|ordertype)=/.test(location.search);
  // navigate, reload or back_forward.
  const arrivedBy = () => performance.getEntriesByType('navigation')[0]?.type;

  /* -------------------------------------------------------------------- rail */

  const effectiveTheme = () => {
    if (settings.theme !== 'auto') return settings.theme;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };

  const setTheme = (theme) => {
    const apply = () => saveSettings({ theme });
    if (document.startViewTransition && !calm()) document.startViewTransition(apply);
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
    if (!content || calm()) return;
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

  // The old page stays up until the server answers, which can take a while. Lighting the
  // board straight away shows that the click was taken.
  const pressBoard = (event) => {
    const link = event.target.closest?.('#nv li > a[href]:not([target])');
    if (!link?.protocol.startsWith('http')) return;
    if (event.defaultPrevented || !plainClick(event)) return;
    $$('#nv li.a').forEach((item) => item.classList.remove('a'));
    link.parentElement.classList.add('a');
  };

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

  // The title on screen right now: the big one, or the toolbar's once that has scrolled away.
  const shownTitle = () => [$('#thread_subject'), $('.lumen-bar-title')].find((node) => {
    if (!node?.checkVisibility?.({ opacityProperty: true, visibilityProperty: true })) return false;
    const { top, bottom } = node.getBoundingClientRect();
    return bottom > 0 && top < innerHeight;
  });

  const pressTrip = (event) => {
    // A chip that opens a later floor lands below the title, so it has nothing to carry across.
    const within = pageKind === 'thread'
      ? '.lumen-crumb'
      : 'a.xst, .tps a, .lumen-resume:not([href*="goto=findpost"])';
    const link = event.target.closest?.(within);
    if (!link?.protocol.startsWith('http') || !settings.threadMorph || link.target === '_blank') return;
    if (event.defaultPrevented || !plainClick(event)) return;
    const row = link.closest('tbody');
    const title = row ? $('a.xst', row) : shownTitle();
    try { sessionStorage.setItem(MORPH_KEY, row?.id.split('_')[1] ?? tid); } catch { return; }
    if (!canMorph) return;
    if (title) nameTitle(title);
    startMorph();
  };

  // Inside the render gate, so the title is named before the new page is captured.
  const landTrip = () => {
    if (!morphId || morphTitle || !canMorph) return;
    const title = pageKind === 'thread'
      ? $('#thread_subject')
      : $(`#normalthread_${morphId} a.xst, #stickthread_${morphId} a.xst`);
    if (title?.getBoundingClientRect().top < innerHeight) nameTitle(title);
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
    // Unchanged text is left alone, so the minute-by-minute refresh costs no layout.
    const text = node.dataset.lumenTimeNode
      ? [...node.childNodes].find((child) => child.nodeType === 3 && child.textContent.trim())
      : node;
    const label = node.dataset.lumenTimeNode ? `${shown} · ` : `${node.dataset.lumenPrefix ?? ''}${shown}`;
    if (text && text.textContent !== label) text.textContent = label;
    if (node.title !== raw) node.title = raw;
  };

  const refreshTimes = () => $$(TIME_SELECTORS).forEach(formatTime);

  // "3 分钟前" keeps ageing while the page stays open.
  const keepTimesFresh = () => {
    const tick = () => {
      if (settings.relativeTime && !document.hidden) refreshTimes();
    };
    setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
  };

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

  // Near-white greys read as body text, so they follow it when night text is softened.
  const fitToNight = (rgb) => {
    const fitted = fitTo(rgb, NIGHT, INK_LIGHT);
    const grey = Math.max(...fitted) - Math.min(...fitted) < 24;
    return grey && Math.min(...fitted) >= 224 ? 'var(--night-ink)' : toCss(fitted);
  };

  const sameColour = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 10);

  const PAPER = [255, 255, 255];
  const NIGHT = [14, 12, 17];
  const INK_DARK = [31, 26, 36];
  const INK_LIGHT = [244, 240, 235];
  const SITE_BG = [246, 247, 235];

  // Pale tints vanish on the forum's page colour as surely as white does, and that is why they
  // are picked. Bright yellow is about as light, but it shows, so strong colours do not count.
  const hiddenOnSite = (rgb) => contrast(rgb, SITE_BG) < 1.15 && Math.max(...rgb) - Math.min(...rgb) <= 60;

  const parseRgb = (value) => {
    const m = value.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  };

  // What one coloured node needs, worked out from the colours the author gave it.
  const colourFix = (node, fill, own) => {
    const textColour = node.getAttribute('color') || node.style.color;
    // Text painted in its own fill is a spoiler, whatever the colour.
    if (fill && own && sameColour(own, fill)) return { spoiler: true };
    // A real highlight keeps its fill in both themes, so its text is chosen against it.
    if (fill && !sameColour(fill, PAPER) && !sameColour(fill, SITE_BG)) {
      if (textColour) return {};
      const light = fill[0] * .299 + fill[1] * .587 + fill[2] * .114 > 140;
      return { ink: light ? '#171717' : '#fafafa' };
    }
    // What is left of a fill is the page colour, which pasted text often carries and which
    // would glow at night. It goes, and the text colour is handled as if it had none.
    const dropFill = !!fill;
    // `[style*="color"]` also matches background-color; only real text colours count.
    if (!textColour || !own) return { dropFill };
    // Text that disappears on the forum's page is its spoiler idiom. Keep it hidden.
    if (hiddenOnSite(own)) return { dropFill, spoiler: true };
    return { dropFill, light: toCss(fitTo(own, PAPER, INK_DARK)), dark: fitToNight(own) };
  };

  // Every colour is read before anything is written. Mixing the two made Chrome work out the
  // styles again for each node, inside the render gate, and a colourful thread has hundreds.
  // Reading first also means each node is judged by the colours the author gave it.
  const fixColours = (scope = document) => {
    const nodes = $$('.t_f font[color], .t_f [style*="color"]', scope)
      .filter((node) => !node.dataset.lumenColor && !node.closest('.quote font[size]'));
    const fixes = nodes.map((node) => {
      const style = getComputedStyle(node);
      const fill = node.style.backgroundColor ? parseRgb(style.backgroundColor) : null;
      return colourFix(node, fill, parseRgb(style.color));
    });
    nodes.forEach((node, at) => {
      const { spoiler, dropFill, ink, light, dark } = fixes[at];
      node.dataset.lumenColor = '1';
      if (spoiler) node.dataset.lumenSpoiler = '1';
      if (dropFill) node.style.backgroundColor = '';
      if (ink) node.style.setProperty('color', ink, 'important');
      if (light) {
        node.style.setProperty('--c-light', light);
        node.style.setProperty('--c-dark', dark);
      }
    });
  };

  /* --------------------------------------------------------------- thread page */

  const markAuthors = () => {
    const posts = listPosts();
    if (!posts.length) return;

    const authorOf = (post) => $('.favatar .authi a', post)?.getAttribute('href') ?? null;
    const isFirstFloor = $('[id^=postnum]', posts[0])?.textContent.includes('楼主');
    const storageKey = `s1lumen:op:${tid}`;
    if (isFirstFloor && tid) {
      try { sessionStorage.setItem(storageKey, authorOf(posts[0]) ?? ''); } catch { /* ignore */ }
    }
    // Later pages name the thread starter in the title block, so this works on a direct link too.
    let op = isFirstFloor ? authorOf(posts[0]) : $('#tath a')?.getAttribute('href') ?? null;
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

  // Discuz copies the avatar into its card 500ms after hover, later than the card opens here.
  const fillCardAvatar = ({ target }) => {
    const avatar = target.closest?.('.favatar .avatar');
    const slot = avatar?.closest('.favatar').querySelector('.bui .m > div');
    if (slot && !slot.hasChildNodes()) slot.append(...[...avatar.childNodes].map((node) => node.cloneNode(true)));
  };

  /* ---------------------------------------------------------- reading position */

  // The floor each thread was left on, as { tid: [floor, pid, time] }. It never leaves
  // this browser, and a list row works out its unread count from the reply column.
  const READ_KEY = 's1lumen:read';
  const READ_LIMIT = 400;

  const loadReading = () => {
    try { return JSON.parse(localStorage.getItem(READ_KEY)) ?? {}; } catch { return {}; }
  };

  const forgetReading = () => {
    try { localStorage.removeItem(READ_KEY); } catch { /* ignore */ }
  };

  // 26bc87d kept a copy in chrome.storage.local, shared between addresses. Nothing reads it now.
  // TODO: drop this line in the release after next.
  if (hasExtensionApi()) chrome.storage.local.remove(READ_KEY).catch(() => {});

  let held = null; // a post jumped to: it stays the place until the reader moves

  // The post crossing the line just under where a jump lands, or the last one once it is in view.
  const postAtLine = () => {
    const posts = listPosts();
    if (posts.at(-1)?.getBoundingClientRect().bottom <= innerHeight) return posts.at(-1);
    const line = (Number.parseFloat(getComputedStyle(root).scrollPaddingTop) || 0) + 24;
    return posts.find((post) => post.getBoundingClientRect().bottom > line);
  };
  const currentPost = () => held ?? postAtLine();

  const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

  const releaseHeld = ({ type, key, target }) => {
    if (type === 'keydown' && !MOVE_KEYS.has(key)) return;
    if (type === 'pointerdown' && target !== root) return; // the scrollbar, not a link
    held = null;
  };

  const saveReading = () => {
    if (!settings.resume || filteredView) return;
    const post = currentPost();
    const floor = post && floorOf(post);
    if (!floor) return;
    const read = loadReading();
    read[tid] = [floor, pidOf(post), Date.now()];
    const stale = Object.keys(read).sort((a, b) => read[b][2] - read[a][2]).slice(READ_LIMIT);
    for (const key of stale) delete read[key];
    try { localStorage.setItem(READ_KEY, JSON.stringify(read)); } catch { /* ignore */ }
  };

  /* The pill: one small floating action at a time, for 接着读 and 返回. */

  let pill = null;

  const hidePill = () => {
    const leaving = pill;
    pill = null;
    if (!leaving) return;
    leaving.classList.add('is-leaving');
    setTimeout(() => leaving.remove(), 180);
  };

  const showPill = (kind, label, action) => {
    hidePill();
    const go = el('button', { type: 'button', class: 'lumen-pill-go' }, label);
    const close = el('button', { type: 'button', class: 'lumen-pill-close', title: '关闭' });
    go.addEventListener('click', action);
    close.addEventListener('click', hidePill);
    pill = el('div', { class: `lumen-pill lumen-pill-${kind}` }, go, close);
    document.body.append(pill);
    return pill;
  };

  const flashPost = (post) => {
    if (!post) return;
    post.classList.remove('lumen-flash');
    void post.offsetWidth;
    post.classList.add('lumen-flash');
    post.addEventListener('animationend', () => post.classList.remove('lumen-flash'), { once: true });
  };

  const scrollToPost = (post) => {
    held = post;
    post.scrollIntoView({ behavior: calm() ? 'auto' : 'smooth', block: 'start' });
    flashPost(post);
  };

  /* 续读 */

  // Reload, Back and a restored tab keep their place without being asked. The browser puts
  // the scroll offset back, but images load in at their own pace, so the floor gets the last word.
  const settleRestored = () => {
    if (arrivedBy() === 'navigate') return;
    const post = postById(loadReading()[tid]?.[1]);
    if (!post) return; // Left from another page of the thread, and the offset is all there is.
    held = post;
    const finish = () => {
      if (held === post && postAtLine() !== post) post.scrollIntoView({ behavior: 'instant', block: 'start' });
    };
    if (document.readyState === 'complete') finish();
    else addEventListener('load', finish, { once: true });
  };

  const offerResume = () => {
    if (!settings.resume || location.hash || scrollY > 200) return;
    if (filteredView) return;
    // Paging inside the thread, Back and reload are not coming back to it.
    if (threadOf(document.referrer) === tid) return;
    if (arrivedBy() !== 'navigate') return;
    const saved = loadReading()[tid];
    const here = currentPost();
    if (!saved || !here || saved[0] <= 1 || Math.abs(saved[0] - floorOf(here)) <= 1) return;
    const [floor, pid] = saved;
    const offer = showPill('resume', `接着读 ${floor} 楼`, () => {
      hidePill();
      const post = postById(pid);
      if (post) scrollToPost(post);
      else location.href = postUrl(tid, pid);
    });
    setTimeout(() => {
      if (pill === offer && !offer.matches(':hover')) hidePill();
    }, 12000);
  };

  const markRows = () => {
    const read = settings.resume ? loadReading() : {};
    for (const row of threadRows()) {
      const chip = $('.lumen-resume', row);
      const thread = row.id.split('_')[1];
      const title = $('a.xst', row);
      const replies = Number.parseInt($('td.num a', row)?.textContent, 10);
      const seen = read[thread];
      const fresh = seen && title && !Number.isNaN(replies) ? replies + 1 - seen[0] : 0;
      if (fresh <= 0) {
        chip?.remove();
        continue;
      }
      // Left on the first floor, the top of the thread is the place, title included.
      const href = seen[0] <= 1 ? title.getAttribute('href') : postUrl(thread, seen[1]);
      // This runs on every change to the list, and a chip that is already right stays as it is.
      if (chip?.getAttribute('href') === href && chip.textContent === `+${fresh}`) continue;
      chip?.remove();
      title.after(el('a', { class: 'lumen-resume', href, title: `后面还有 ${fresh} 楼，从 ${seen[0]} 楼接着读` }, `+${fresh}`));
    }
  };

  /* 引用跳转与返回 */

  const BACK_KEY = 's1lumen:back';
  const returnSpots = []; // { top, floor }, one per jump within this page
  let returning = false;

  const backLabel = (floor) => (floor ? `返回 ${floor} 楼` : '返回');

  const offerReturn = (floor) => {
    showPill('back', backLabel(floor), () => {
      returning = true;
      history.scrollRestoration = 'manual';
      history.back();
    });
  };

  // The whole quote leads to its post, apart from what has a click of its own and text being selected.
  const quoteLink = ({ target }) => {
    const direct = target.closest?.('.t_f a[href*="goto=findpost"]');
    if (direct) return direct;
    if (target.closest?.('a, img, button') || !getSelection().isCollapsed) return null;
    return target.closest?.('.t_f .quote')?.querySelector('a[href*="goto=findpost"]');
  };

  const followQuote = (event) => {
    if (!plainClick(event)) return;
    const link = quoteLink(event);
    if (!link) return;
    const url = new URL(link.href);
    const pid = url.searchParams.get('pid');
    if (!pid || url.searchParams.get('ptid') !== tid) return;
    event.preventDefault();

    const from = event.target.closest(POST);
    const floor = from ? floorOf(from) : 0;
    const post = postById(pid);
    if (!post) {
      try { sessionStorage.setItem(BACK_KEY, JSON.stringify({ tid, pid, floor })); } catch { /* ignore */ }
      location.href = link.href;
      return;
    }
    returnSpots.push({ top: scrollY, floor });
    // The page has a <base>, so a bare "#pid" would point at the forum root.
    history.pushState({ lumenJump: returnSpots.length }, '', `${location.pathname}${location.search}#pid${pid}`);
    scrollToPost(post);
    offerReturn(floor);
  };

  const settleReturn = ({ state }) => {
    if ((state?.lumenJump ?? 0) >= returnSpots.length) return;
    held = null;
    const { top } = returnSpots.pop();
    if (returning) {
      returning = false;
      scrollTo({ top, behavior: calm() ? 'auto' : 'smooth' });
      history.scrollRestoration = 'auto';
    }
    if (returnSpots.length) offerReturn(returnSpots.at(-1).floor);
    else hidePill();
  };

  const startThread = () => {
    if (!tid) return;
    buildScrubber();
    document.addEventListener('click', followQuote);
    addEventListener('popstate', settleReturn);
    // A tab closed in the background was saved when it was hidden, or never read at all.
    addEventListener('pagehide', () => {
      if (!document.hidden) saveReading();
      // Left without taking it, so it no longer applies if Back brings this page out of the cache.
      if (pill?.classList.contains('lumen-pill-resume')) {
        pill.remove();
        pill = null;
      }
    });
    // Quitting the browser does not always get as far as pagehide. scrollend arrived in
    // Chrome 114; before that, a pause in scroll events stands in for it.
    if ('onscrollend' in window) {
      addEventListener('scrollend', () => saveReading());
    } else {
      let pause = 0;
      addEventListener('scroll', () => {
        clearTimeout(pause);
        pause = setTimeout(saveReading, 200);
      }, { passive: true });
    }
    for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) {
      addEventListener(type, releaseHeld, { passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) saveReading();
    });

    const landed = location.hash.match(/^#pid(\d+)/)?.[1];
    if (landed) {
      held = postById(landed);
      flashPost(held);
    }
    settleRestored();
    let jump = null;
    try {
      jump = JSON.parse(sessionStorage.getItem(BACK_KEY));
      sessionStorage.removeItem(BACK_KEY);
    } catch { /* ignore */ }
    if (jump?.tid === tid && postById(jump.pid)) {
      showPill('back', backLabel(jump.floor), () => history.back());
      return;
    }
    offerResume();
  };

  /* ---------------------------------------------------------- floor scrubber */

  const FLOOR_KEY = 's1lumen:floor';

  // Arriving from the scrubber on another page. Runs inside the render gate, so the top of
  // the page never shows first.
  const landOnFloor = () => {
    let target = null;
    try {
      target = JSON.parse(sessionStorage.getItem(FLOOR_KEY));
      sessionStorage.removeItem(FLOOR_KEY);
    } catch { /* ignore */ }
    if (target?.tid !== tid) return;
    const posts = listPosts();
    const post = posts.find((item) => floorOf(item) >= target.floor) ?? posts.at(-1);
    post?.scrollIntoView({ behavior: 'instant', block: 'start' });
  };

  // Chrome only scrolls to a #pid after the first paint, so the top of the thread would flash
  // first. Going there inside the render gate makes the floor the first thing on screen.
  let anchored = false;
  const landOnAnchor = () => {
    const pid = location.hash.match(/^#pid(\d+)/)?.[1];
    const target = pid && document.getElementById(`pid${pid}`);
    if (!target || anchored || arrivedBy() !== 'navigate') return;
    anchored = true;
    target.scrollIntoView({ behavior: 'instant', block: 'start' });
  };

  const buildScrubber = () => {
    if ($('.lumen-scrub') || filteredView) return;
    const pages = Math.max(0, ...$$('#pgt .pg a, #pgt .pg strong')
      .map((node) => Number.parseInt(node.textContent.replace(/\D/g, ''), 10))
      .filter(Boolean));
    const page = Number.parseInt($('#pgt .pg strong')?.textContent, 10) || 1;
    const posts = listPosts();
    if (pages < 2 || !posts.length) return;
    const perPage = page > 1 ? Math.round((floorOf(posts[0]) - 1) / (page - 1)) : posts.length;
    if (!perPage) return;

    const tip = el('span', { class: 'lumen-scrub-tip' });
    const scrub = el('div', { class: 'lumen-scrub' }, el('i', { class: 'lumen-scrub-thumb' }), tip);
    let dragging = false;
    let queued = false;

    const showProgress = () => {
      queued = false;
      if (dragging) return;
      const room = root.scrollHeight - innerHeight;
      const loaded = Math.max(1, Math.ceil(floorOf(listPosts().at(-1)) / perPage) - page + 1);
      const through = room > 0 ? Math.min(1, scrollY / room) : 0;
      scrub.style.setProperty('--at', (page - 1 + loaded * through) / pages);
    };

    const spotAt = (y) => {
      const { top, height } = scrub.getBoundingClientRect();
      const at = Math.min(.9999, Math.max(0, (y - top) / height));
      const target = Math.floor(at * pages) + 1;
      const floor = (target - 1) * perPage + Math.floor((at * pages % 1) * perPage) + 1;
      tip.textContent = `第 ${target} 页 · ${floor} 楼`;
      scrub.style.setProperty('--tip', at);
      return { at, floor, target };
    };

    const postFor = (floor) => {
      const loaded = listPosts();
      if (floor < floorOf(loaded[0]) || floor > floorOf(loaded.at(-1))) return null;
      return loaded.find((item) => floorOf(item) >= floor);
    };

    scrub.addEventListener('pointermove', ({ clientY }) => {
      const { at, floor } = spotAt(clientY);
      if (!dragging) return;
      scrub.style.setProperty('--at', at);
      postFor(floor)?.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
    scrub.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      scrub.setPointerCapture(event.pointerId);
      dragging = true;
      held = null;
      scrub.classList.add('is-dragging');
      const { at, floor } = spotAt(event.clientY);
      scrub.style.setProperty('--at', at);
      postFor(floor)?.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
    scrub.addEventListener('pointerup', ({ clientY }) => {
      if (!dragging) return;
      dragging = false;
      scrub.classList.remove('is-dragging');
      const { floor, target } = spotAt(clientY);
      if (postFor(floor)) return;
      try { sessionStorage.setItem(FLOOR_KEY, JSON.stringify({ tid, floor })); } catch { /* ignore */ }
      location.href = `forum.php?mod=viewthread&tid=${tid}&page=${target}`;
    });
    scrub.addEventListener('pointercancel', () => {
      dragging = false;
      scrub.classList.remove('is-dragging');
      showProgress();
    });

    addEventListener('scroll', () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(showProgress);
    }, { passive: true });
    requestAnimationFrame(showProgress);
    document.body.append(scrub);
  };

  /* -------------------------------------------------- images and attachments */

  const sizeIn = (text) => text.match(/[\d.]+\s*[KMG]?B\b/)?.[0];

  // Only what is on this page: reading the other pages would count as views of them.
  const pageMedia = () => {
    const images = [];
    const files = [];
    const seen = new Set();
    for (const post of listPosts()) {
      if (post.dataset.lumenBlocked !== undefined && post.dataset.lumenShown === undefined) continue;
      for (const image of $$('.t_f img, .pattl img', post)) {
        const source = image.getAttribute('zoomfile') || image.getAttribute('file') || image.getAttribute('src');
        if (!source || image.hasAttribute('smilieid')) continue;
        const url = new URL(source, document.baseURI).href;
        if (/\/(smiley|filetype)\/|\/image\/common\//.test(url) || seen.has(url)) continue;
        seen.add(url);
        // An uploaded image carries its file name and download link in a hover tip.
        const tip = image.id && document.getElementById(`${image.id}_menu`);
        images.push({
          url,
          post,
          floor: floorOf(post),
          referrerPolicy: image.referrerPolicy,
          name: tip && $('strong', tip)?.textContent.trim(),
          size: tip && sizeIn(tip.textContent),
          download: tip && $('a[href*="mod=attachment"]', tip)?.href,
        });
      }
      for (const link of $$('.t_f a[href*="mod=attachment"], .pattl a[href*="mod=attachment"]', post)) {
        const name = link.textContent.trim();
        if (!name || $('img', link) || link.closest('.aimg_tip') || seen.has(link.href)) continue;
        seen.add(link.href);
        const size = sizeIn(link.closest('dd, .tattl')?.textContent ?? '');
        files.push({ url: link.href, name, size, post, floor: floorOf(post) });
      }
    }
    return { images, files };
  };

  const mediaLabel = ({ images, files }) => [
    images.length && `图片 ${images.length} 张`,
    files.length && `附件 ${files.length} 个`,
  ].filter(Boolean).join(' · ');

  const openGallery = () => {
    const { images, files } = pageMedia();
    let index = -1;

    const close = el('button', { type: 'button', class: 'lumen-gallery-close', title: '关闭' });
    const picture = el('img', { class: 'lumen-viewer-image', alt: '' });
    const count = el('span', { class: 'lumen-viewer-count' });
    const file = el('span', { class: 'lumen-viewer-file' });
    const save = el('a', { class: 'lumen-viewer-jump', target: '_blank' }, '下载原图');
    const jump = el('button', { type: 'button', class: 'lumen-viewer-jump' });
    const prev = el('button', { type: 'button', class: 'lumen-viewer-prev', title: '上一张' });
    const next = el('button', { type: 'button', class: 'lumen-viewer-next', title: '下一张' });
    const viewer = el('div', { class: 'lumen-viewer', hidden: true }, prev, picture, next,
      el('div', { class: 'lumen-viewer-bar' }, count, file, jump, save));

    const show = (at) => {
      index = (at + images.length) % images.length;
      const item = images[index];
      picture.referrerPolicy = item.referrerPolicy;
      picture.src = item.url;
      count.textContent = `${index + 1} / ${images.length}`;
      jump.textContent = `跳到 ${item.floor} 楼`;
      file.textContent = [item.name, item.size].filter(Boolean).join(' · ');
      save.hidden = !item.download;
      if (item.download) save.href = item.download;
      viewer.hidden = false;
      // The neighbours load while this one is looked at, so stepping through does not wait.
      for (const step of [1, -1]) {
        const near = images[(index + step + images.length) % images.length];
        Object.assign(new Image(), { referrerPolicy: near.referrerPolicy, src: near.url });
      }
    };
    const backToGrid = () => {
      index = -1;
      viewer.hidden = true;
      picture.removeAttribute('src');
    };

    const grid = el('div', { class: 'lumen-gallery-grid' }, ...images.map((item, at) => {
      const thumb = el('img', { src: item.url, alt: '', loading: 'lazy', decoding: 'async', referrerPolicy: item.referrerPolicy });
      const tile = el('button', { type: 'button', class: 'lumen-gallery-tile' }, thumb,
        el('span', {}, `${item.floor} 楼`));
      tile.addEventListener('click', () => show(at));
      return tile;
    }));
    const list = el('ul', { class: 'lumen-gallery-files' }, ...files.map(({ url, name, size, floor }) => el('li', {},
      el('a', { href: url, target: '_blank', title: name }, el('strong', {}, name),
        el('span', {}, [size, `${floor} 楼`].filter(Boolean).join(' · '))))));
    const dialog = el('dialog', { class: 'lumen-gallery' },
      el('header', {}, el('strong', {}, '本页图片与附件'), el('span', {}, mediaLabel({ images, files })), close),
      ...(images.length ? [grid] : []), ...(files.length ? [list] : []), viewer);

    const goToPost = (post) => {
      dialog.close();
      scrollToPost(post);
    };
    close.addEventListener('click', () => dialog.close());
    prev.addEventListener('click', () => show(index - 1));
    next.addEventListener('click', () => show(index + 1));
    picture.addEventListener('click', backToGrid);
    viewer.addEventListener('click', ({ target }) => {
      if (target === viewer) backToGrid();
    });
    jump.addEventListener('click', () => goToPost(images[index].post));
    dialog.addEventListener('cancel', (event) => {
      if (viewer.hidden) return;
      event.preventDefault();
      backToGrid();
    });
    dialog.addEventListener('keydown', ({ key }) => {
      if (viewer.hidden) return;
      if (key === 'ArrowLeft') show(index - 1);
      if (key === 'ArrowRight') show(index + 1);
    });
    dialog.addEventListener('close', () => dialog.remove());
    openDialog(dialog);
  };

  const offerMedia = () => {
    const bar = $('#pgt');
    if (!bar) return;
    const { images, files } = pageMedia();
    let button = $('.lumen-media', bar);
    if (!images.length && !files.length) {
      button?.remove();
      return;
    }
    if (!button) {
      button = el('button', { type: 'button', class: 'lumen-media', title: '查看本页图片与附件' });
      button.addEventListener('click', openGallery);
      bar.append(button);
    }
    button.textContent = mediaLabel({ images, files });
  };

  /* --------------------------------------------------------------- NSFW images */

  // A thread's own choice lasts as long as this tab; the setting covers everything else.
  const SENSITIVE_KEY = 's1lumen:sensitive';
  let sensitive = false;

  const threadChoices = () => {
    try { return JSON.parse(sessionStorage.getItem(SENSITIVE_KEY)) ?? {}; } catch { return {}; }
  };
  const showingSensitive = () => threadChoices()[tid] ?? settings.showSensitive;

  const applySensitive = () => {
    const hidden = sensitive && !showingSensitive();
    root.toggleAttribute('data-lumen-blur', hidden);
    const button = $('.lumen-sensitive');
    if (button) button.textContent = hidden ? '显示敏感图片' : '隐藏敏感图片';
  };

  const toggleSensitive = () => {
    const choices = { ...threadChoices(), [tid]: !showingSensitive() };
    try { sessionStorage.setItem(SENSITIVE_KEY, JSON.stringify(choices)); } catch { /* ignore */ }
    applySensitive();
  };

  const offerSensitive = () => {
    const bar = $('#pgt');
    if (!sensitive || !bar || $('.lumen-sensitive', bar)) return;
    const button = el('button', { type: 'button', class: 'lumen-sensitive', title: '只对当前帖子生效，默认值在扩展设置里' });
    button.addEventListener('click', toggleSensitive);
    bar.append(button);
    applySensitive();
  };

  /* ----------------------------------------------------------------- blocking */

  const userIdOf = (link) => link?.getAttribute('href')?.match(/space-uid-(\d+)|[?&]uid=(\d+)/)?.slice(1).find(Boolean);

  const blockUser = (id, name) => {
    if (settings.blockUsers.some((user) => user.id === id)) return;
    saveSettings({ blockUsers: [...settings.blockUsers, { id, name }] });
  };
  const unblockUser = (id) => saveSettings({ blockUsers: settings.blockUsers.filter((user) => user.id !== id) });

  const foldPost = (post, label, userId) => {
    const note = $(':scope > .lumen-blocked', post);
    if (note?.dataset.label === label) return;
    note?.remove();
    delete post.dataset.lumenShown;
    post.dataset.lumenBlocked = '';
    const toggle = el('button', { type: 'button' }, '显示');
    toggle.addEventListener('click', () => {
      toggle.textContent = post.toggleAttribute('data-lumen-shown') ? '收起' : '显示';
    });
    const undo = el('button', { type: 'button' }, '解除屏蔽');
    undo.addEventListener('click', () => unblockUser(userId));
    const fold = el('div', { class: 'lumen-blocked' }, el('span', {}, label), toggle, ...(userId ? [undo] : []));
    fold.dataset.label = label;
    post.prepend(fold);
  };

  const unfoldPost = (post) => {
    $(':scope > .lumen-blocked', post)?.remove();
    delete post.dataset.lumenBlocked;
    delete post.dataset.lumenShown;
  };

  const applyBlocks = () => {
    const users = new Map(settings.blockUsers.map(({ id, name }) => [id, name]));
    const words = settings.blockWords.map((word) => word.toLowerCase());
    // This runs on every change to the page; with no words, no post's text is read at all.
    const wordIn = (node) => {
      if (!words.length || !node) return undefined;
      const text = node.textContent.toLowerCase();
      return words.find((word) => text.includes(word));
    };

    for (const row of threadRows()) {
      const blocked = users.has(userIdOf($('td.by cite a', row))) || !!wordIn($('a.xst', row));
      row.toggleAttribute('data-lumen-blocked', blocked);
    }
    for (const post of listPosts()) {
      const author = $('.favatar .authi a', post);
      const id = userIdOf(author);
      const word = !users.has(id) && wordIn($('.t_f', post));
      if (users.has(id)) foldPost(post, `已屏蔽 ${author.textContent.trim()} 的回复`, id);
      else if (word) foldPost(post, `这条回复含屏蔽词「${word}」`);
      else unfoldPost(post);
    }
  };

  const addBlockLinks = () => {
    for (const post of listPosts()) {
      const meta = $('.pti .authi', post);
      const author = $('.favatar .authi a', post);
      const id = userIdOf(author);
      if (!meta || !id || $('.lumen-block-user', meta)) continue;
      meta.append(el('a', { class: 'lumen-block-user', role: 'button' }, '屏蔽'));
    }
  };

  document.addEventListener('click', ({ target }) => {
    if (!target.closest?.('.lumen-block-user')) return;
    const author = $('.favatar .authi a', target.closest(POST));
    blockUser(userIdOf(author), author.textContent.trim());
  });

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

  // Discuz keeps hidden stickies by thread id, in this site's localStorage, and leaves them out of
  // every list. Hiding writes the same list, so a thread pinned later still shows up, and Discuz's
  // own 显示置顶 brings them back. The two links take turns in one place in the header.
  const STICKY_KEY = 'Discuz_sticktids';
  const stickyRows = () => $$('#threadlisttableid > tbody[id^="stickthread_"]');

  const hideStickies = () => {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(STICKY_KEY)) ?? []; } catch { /* Discuz's own format */ }
    const ids = new Set((Array.isArray(saved) ? saved : []).map(String));
    for (const row of stickyRows()) {
      ids.add(row.id.split('_')[1]);
      row.remove();
    }
    try { localStorage.setItem(STICKY_KEY, `[${[...ids].join(',')}]`); } catch { /* ignore */ }
    const restore = $('#clearstickthread');
    if (restore) restore.style.display = '';
    offerStickyToggle();
  };

  const offerStickyToggle = () => {
    const table = $('#threadlisttableid');
    const tabs = $('#threadlist .tf');
    const restore = $('#clearstickthread', tabs ?? document);
    if (!table || !tabs || !restore) return;
    // With every sticky hidden, Discuz drops this row while the page loads, and its check for new
    // threads then fails on the missing row: 有新回复的主题 never comes. An empty one stands in.
    if (!$('#separatorline', table)) {
      table.prepend(el('tbody', { id: 'separatorline' }, el('tr', { class: 'ts' }, el('td'))));
    }
    const any = stickyRows().length > 0;
    tabs.classList.toggle('lumen-has-sticky', any);
    const hide = $('.lumen-hide-sticky', tabs);
    if (!any) hide?.remove();
    else if (!hide) {
      const link = el('a', { class: 'lumen-hide-sticky', role: 'button', tabIndex: 0 }, '隐藏置顶');
      link.addEventListener('click', hideStickies);
      link.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          hideStickies();
        }
      });
      restore.before(link);
    }
  };

  const tidyIndex = () => {
    foldBoardRules();
    offerStickyToggle();
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

  /* ------------------------------------------------------------------ keyboard */

  const bindKeys = () => {
    addEventListener('keydown', (event) => {
      // Chrome's autofill sends keydown events that have no key.
      const key = event.key?.toLowerCase();
      const command = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
      // Inside a text field these stay with the field: bold, and whatever ⌘K means there.
      if (typing) {
        if (key === 'escape' && event.target.id === 'scbar_txt') event.target.blur();
        return;
      }
      if (command && key === 'b') {
        event.preventDefault();
        toggleRail();
        return;
      }
      if ((command && key === 'k') || key === '/') {
        const input = $('#scbar_txt');
        if (!input) return;
        event.preventDefault();
        input.focus();
        input.select();
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

  const repaintEditor = () => {
    const frame = document.getElementById('e_iframe');
    if (frame) paintEditor(frame);
  };

  // The frame's colours are written out, so it does not follow the system by itself.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'auto') repaintEditor();
  });

  /* --------------------------------------------------------------------- polls */

  // Discuz posts votes and ratings into a hidden frame and expects an XML reply. S1 answers
  // a good one with an ordinary page, Discuz's handler throws on it, and the page just sits
  // there until a manual refresh. So: reload afterwards, unless the reply is a refusal,
  // which Discuz shows by itself.
  const FRAME_FORMS = new Set(['poll', 'rateform']);
  let framePending = false;
  document.addEventListener('submit', ({ target }) => {
    if (FRAME_FORMS.has(target.id)) framePending = true;
  }, true);

  // Discuz sends whatever is typed, and a rating is a whole number.
  document.addEventListener('input', ({ target }) => {
    if (!target.matches?.('#rateform input[id^="score"]')) return;
    const whole = target.value.replace(/\..*$/, '').replace(/(?!^-)\D/g, '');
    if (whole !== target.value) target.value = whole;
  }, true);

  const finishFrameForm = (frame) => {
    const reply = frame.contentDocument;
    // The frame fires one load for about:blank as soon as Discuz inserts it.
    if (reply?.URL === 'about:blank') return;
    framePending = false;
    const refused = reply?.contentType.includes('xml')
      && /ajaxerror|errorhandle_|alert_error/.test(reply.documentElement.textContent);
    if (!refused) location.reload();
  };

  /* -------------------------------------------------------------- hidden posts */

  // Posts the web hides ("作者被禁止或删除") still come through the forum's App API. That API
  // has a login of its own: the web session does not count, and its token (sid) is only handed
  // out for a user name and password. The password is never stored. The token stays in
  // chrome.storage.local, away from page scripts, and leaves only for the forum itself.
  const SID_KEY = 's1lumen:sid';
  const APP_TIMEOUT_MS = 5000;
  const WEB_PAGE_SIZE = 40;
  const CREDENTIALS_TTL_MS = 60_000;
  const HIDDEN_NOTE = /内容自动屏蔽|被管理员或版主屏蔽/;
  const SECURITY_QUESTIONS = ['没有安全提问', '母亲的名字', '爷爷的名字', '父亲出生的城市', '您其中一位老师的名字',
    '您个人计算机的型号', '您最喜欢的餐馆名称', '驾驶执照最后四位数字'];

  // The content script also matches http:// and any subdomain. Credentials go nowhere but here.
  const appApiAllowed = location.protocol === 'https:'
    && /^(www\.)?stage1st\.com$/.test(location.hostname);

  // No cookies: the web session stays out of it, and nothing here can be triggered from elsewhere.
  const appPost = async (path, fields, sid) => {
    try {
      const reply = await fetch(`${location.origin}/2b/api/app/${path}`, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: sid ? { authorization: sid } : {},
        body: new URLSearchParams(fields),
        signal: AbortSignal.timeout(APP_TIMEOUT_MS),
      });
      return await reply.json();
    } catch {
      throw new Error('连接失败');
    }
  };

  const accountLink = () => $('#um .vwmy a');
  const forgetSid = async () => {
    if (hasExtensionApi()) await chrome.storage.local.remove(SID_KEY);
  };

  const savedSid = async () => {
    // After the extension updates, the page keeps this script but loses its storage.
    if (!hasExtensionApi()) throw new Error('扩展已更新，请刷新页面');
    const { [SID_KEY]: saved } = await chrome.storage.local.get(SID_KEY);
    return saved && saved.uid === userIdOf(accountLink()) ? saved.sid : null;
  };

  const appLogin = async (fields) => {
    const { success, message, data } = await appPost('user/login', fields);
    if (!success || !data?.sid) throw new Error(message || '登录失败');
    await chrome.storage.local.set({ [SID_KEY]: { sid: data.sid, uid: String(data.uid) } });
    return data.sid;
  };

  // In the page like the forum's own login box, which is what lets Chrome fill in a saved password.
  const askPassword = (hint) => new Promise((resolve) => {
    const username = el('input', {
      type: 'text', name: 'username', value: accountLink()?.textContent.trim() ?? '', readOnly: true, autocomplete: 'username',
    });
    const password = el('input', {
      type: 'password', name: 'password', required: true, autofocus: true, autocomplete: 'current-password', placeholder: '密码',
    });
    const question = el('select', { name: 'questionid' },
      ...SECURITY_QUESTIONS.map((label, value) => el('option', { value }, label)));
    const answer = el('input', { type: 'text', name: 'answer', autocomplete: 'off', placeholder: '安全提问的答案', hidden: true });
    const error = el('p', { class: 'lumen-app-error', role: 'alert' });
    const cancel = el('button', { type: 'button' }, '取消');
    const submit = el('button', { type: 'submit', class: 'lumen-app-submit' }, '确定');
    const form = el('form', {},
      el('strong', {}, '查看被屏蔽的内容'),
      el('p', {}, hint ?? '这部分内容走论坛的 App 接口，网页登录不算数，需要再验证一次。密码只发给论坛，不保存。'),
      username, password, question, answer, error,
      el('div', { class: 'lumen-app-actions' }, cancel, submit));
    const dialog = el('dialog', { class: 'lumen-app-login' }, form);
    let sid = null;

    question.addEventListener('change', () => { answer.hidden = question.value === '0'; });
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.textContent = '';
      try {
        sid = await appLogin(Object.fromEntries(new FormData(form)));
        dialog.close();
      } catch ({ message }) {
        error.textContent = message;
        submit.disabled = false;
        password.select();
      }
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(sid);
    });
    openDialog(dialog);
  });

  // Hidden posts tend to come several to a page, and one reply covers them all.
  const appPages = new Map();
  const appPage = (sid, pageNo) => {
    if (!appPages.has(pageNo)) {
      const request = appPost('thread/page', { sid, tid, pageNo }, sid).then(({ success, message, data }) => {
        if (success && data) return data;
        throw Object.assign(new Error(message || '读取失败'), { expired: /重新登录|^请先登录/.test(message) });
      });
      appPages.set(pageNo, request);
      request.catch(() => appPages.delete(pageNo));
    }
    return appPages.get(pageNo);
  };

  // The App may page differently from the web, and deleted posts shift things by a page at most.
  const findAppPost = async (sid, pid, floor) => {
    const inList = ({ list }) => list?.find((post) => String(post.pid) === pid);
    const first = await appPage(sid, Math.ceil(floor / WEB_PAGE_SIZE));
    const found = inList(first);
    if (found) return found;
    const near = Math.ceil(floor / (first.pageSize || WEB_PAGE_SIZE));
    for (const pageNo of [near, near - 1, near + 1]) {
      const hit = pageNo > 0 && inList(await appPage(sid, pageNo));
      if (hit) return hit;
    }
    return null;
  };

  const readHiddenPost = async (pid, floor, hint) => {
    const sid = await savedSid() ?? await askPassword(hint);
    if (!sid) return undefined; // the reader cancelled
    try {
      return await findAppPost(sid, pid, floor);
    } catch (error) {
      if (!error.expired || hint) throw error;
      await forgetSid();
      appPages.clear();
      return readHiddenPost(pid, floor, '登录已失效，请再验证一次。密码只发给论坛，不保存。');
    }
  };

  // Whoever wrote this post may have been banned for what is in it. An allowlist, on an inert
  // document, and the nodes themselves are moved over: the markup is never parsed a second time.
  const SAFE_TAGS = new Set(['A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'FONT', 'HR', 'I', 'IMG', 'LI', 'OL', 'P',
    'PRE', 'S', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL']);
  const DROPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'TEXTAREA', 'TITLE']);
  const SAFE_ATTRIBUTES = { FONT: ['color', 'size'], IMG: ['alt'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'] };

  const webUrl = (value) => {
    try {
      const url = new URL(value, `${location.origin}/2b/`);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };

  const cleanNode = (node) => {
    if (!SAFE_TAGS.has(node.tagName)) {
      if (DROPPED_TAGS.has(node.tagName)) node.remove();
      else node.replaceWith(...node.childNodes);
      return;
    }
    const { color, backgroundColor } = node.style;
    const href = node.tagName === 'A' && webUrl(node.getAttribute('href') ?? '');
    const src = node.tagName === 'IMG' && webUrl(node.getAttribute('src') ?? '');
    const kept = SAFE_ATTRIBUTES[node.tagName] ?? [];
    const quote = node.className === 'quote';
    for (const { name } of [...node.attributes]) {
      if (!kept.includes(name)) node.removeAttribute(name);
    }
    if (quote) node.className = 'quote';
    if (color) node.style.color = color;
    if (backgroundColor) node.style.backgroundColor = backgroundColor;
    if (href) Object.assign(node, { href, target: '_blank', rel: 'noopener noreferrer' });
    if (src) Object.assign(node, { src, loading: 'lazy', referrerPolicy: 'no-referrer' });
    if (node.tagName === 'IMG' && !src) node.remove();
  };

  const restoredBody = (message) => {
    const { body } = new DOMParser().parseFromString(message, 'text/html');
    for (const node of [...body.querySelectorAll('*')].reverse()) cleanNode(node);
    const box = el('div', { class: 't_f lumen-restored' }, ...body.childNodes);
    if (!/<(br|p|div)\b/i.test(message)) box.dataset.lumenPlain = '';
    return box;
  };

  const revealPost = async (note, button) => {
    const post = note.closest(POST);
    button.disabled = true;
    button.textContent = '读取中…';
    try {
      const found = await readHiddenPost(post.id.replace('post_', ''), floorOf(post));
      if (found === undefined) {
        button.textContent = '查看内容';
      } else if (found?.message) {
        const box = restoredBody(found.message);
        note.replaceWith(el('p', { class: 'lumen-restored-note' }, '网页已屏蔽此楼，以下内容来自 App 接口'), box);
        fixColours(post);
      } else {
        button.textContent = '接口没有返回这一楼，重试';
      }
    } catch ({ message }) {
      button.textContent = `${message}，重试`;
    }
    button.disabled = false;
  };

  const offerHidden = () => {
    if (!appApiAllowed || !accountLink()) return;
    for (const note of $$('#postlist .pcb > .locked')) {
      if ($('.lumen-reveal', note) || !HIDDEN_NOTE.test(note.textContent)) continue;
      const button = el('button', { type: 'button', class: 'lumen-reveal' }, '查看内容');
      button.addEventListener('click', () => revealPost(note, button));
      note.append(button);
    }
  };

  document.addEventListener('click', ({ target }) => {
    if (target.closest?.('a[href*="action=logout"]')) forgetSid();
  }, true);

  /* --------------------------------------------------------------------- login */

  // Login goes through the same hidden frame and stalls the same way. The reply's format
  // says little, so ask the forum instead: a fresh page shows the account bar once the
  // session exists. Wrong passwords and security questions stay with Discuz.
  let loginPending = false;

  // Held in memory only until the forum has answered: a wrong password is never tried twice.
  let loginFields = null;
  let loginFieldsTimer = 0;

  // On unless turned off in the popup.
  const holdLoginFields = (form) => {
    clearTimeout(loginFieldsTimer);
    loginFields = null;
    if (!appApiAllowed || !settings.appLogin) return;
    const data = new FormData(form);
    const by = data.get('loginfield') ?? data.get('fastloginfield') ?? 'username';
    const username = data.get('username');
    const password = data.get('password');
    if (by !== 'username' || !username || !password) return; // the App only knows user names
    loginFields = { username, password, questionid: data.get('questionid') ?? 0, answer: data.get('answer') ?? '' };
    loginFieldsTimer = setTimeout(() => { loginFields = null; }, CREDENTIALS_TTL_MS);
  };

  document.addEventListener('submit', ({ target }) => {
    if (!target.matches?.('form[name="login"], #lsform, form[action*="mod=logging"]')) return;
    loginPending = true;
    holdLoginFields(target);
  }, true);
  const finishLogin = async (frame) => {
    if (frame.contentDocument?.URL === 'about:blank') return;
    loginPending = false;
    const fields = loginFields;
    loginFields = null;
    clearTimeout(loginFieldsTimer);
    const page = await fetch('forum.php', { credentials: 'same-origin' }).then((reply) => reply.text()).catch(() => '');
    if (!page.includes('id="um"')) return;
    // Failing here costs nothing: the first hidden post asks for the password instead.
    if (fields) await appLogin(fields).catch(() => {});
    const back = $('input[name="referer"]')?.value;
    if (/mod=logging/.test(location.href)) location.href = back && !/mod=logging/.test(back) ? back : 'forum.php';
    else location.reload();
  };

  document.addEventListener('load', ({ target }) => {
    if (target.id === 'e_iframe') paintEditor(target);
    if (target.id === 'ajaxframe' && framePending) finishFrameForm(target);
    if (target.id === 'ajaxframe' && loginPending) finishLogin(target);
  }, true);

  /* ------------------------------------------------------------------ prefetch */

  // Hovering a board link fetches that board ahead of the click. Threads are left out:
  // a prefetch would count as a view.
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

  // The back link is printed as "[ 点击这里返回上一页 ]"; the card gives it its own line already.
  const tidyMessage = () => {
    for (const link of $$('.alert_btnleft a')) link.textContent = link.textContent.replace(/^\[\s*|\s*\]$/g, '');
  };

  // Date filters use layout tables, with the submit button stranded on a separate row.
  const tidyFilterForms = () => {
    for (const table of $$('.exfm > table:has(input[name="starttime"]):has(input[name="endtime"])')) {
      const rows = [...table.rows];
      if (!rows.every((row) => row.cells.length % 2 === 0 && [...row.cells].every((cell, i) => cell.tagName === (i % 2 ? 'TD' : 'TH')))) continue;
      const fields = [];
      for (const row of rows) {
        for (let i = 0; i < row.cells.length; i += 2) {
          const label = row.cells[i];
          const field = el('fieldset', { class: 'lumen-filter-field' });
          if (label.textContent.trim()) field.append(el('legend', {}, ...label.childNodes));
          field.append(el('div', {}, ...row.cells[i + 1].childNodes));
          fields.push(field);
        }
      }
      table.parentElement.classList.add('lumen-filters');
      table.replaceWith(...fields);
    }
  };

  // Same treatment for "RE: 标题 [修改]", which arrives with the reply dialog.
  const tidySubject = () => {
    const line = document.getElementById('subjecthide');
    if (!line || line.dataset.lumenTidy) return;
    line.dataset.lumenTidy = '1';
    for (const node of line.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) node.textContent = node.textContent.replace(/\s*\[\s*$|^\s*\]\s*$/, '');
    }
  };

  // Discuz always links the first and last page, as a number the compact pager hides.
  // Those two links become the buttons, so there are no URLs to build. Discuz leaves out what
  // does not apply on this page; a greyed stand-in holds its place, so the page number stays put.
  const showPagerEnds = () => {
    const pager = $('#pgt .pg');
    if (!pager || $('.lumen-pg-end', pager)) return;
    const pageOf = (node) => Number.parseInt(node?.textContent.replace(/\D/g, ''), 10);
    const current = pageOf($('strong', pager));
    if (!current) return;
    const links = $$('a:not(.nxt):not(.prev)', pager);
    const spare = (name) => el('a', { class: `${name} lumen-pg-off` });
    const end = (link, title) => {
      link.classList.add('lumen-pg-end');
      link.title = title;
      return link;
    };
    pager.prepend(
      pageOf(links[0]) < current ? end(links[0], '首页') : spare('lumen-pg-end'),
      $('.prev', pager) ?? spare('prev'),
    );
    pager.append(
      $('.nxt', pager) ?? spare('nxt'),
      pageOf(links.at(-1)) > current ? end(links.at(-1), '末页') : spare('lumen-pg-end'),
    );
  };

  // A quick reply lands in #postlistreply as <div><table id="pid…">, one level below the posts
  // the page came with and without their post_ id. It moves up beside them, under that id, so
  // everything that reads posts finds it. Discuz has renamed its #post_new by then; the next
  // reply goes into the fresh #post_new it leaves behind, which stays where it is.
  const adoptNewPosts = () => {
    const reply = document.getElementById('postlistreply');
    if (!reply) return;
    // Discuz renames it with id = '', which leaves an empty id behind.
    for (const table of $$(':scope > div:is(:not([id]), [id=""]) > table[id^="pid"]', reply)) {
      const box = table.parentElement;
      const id = `post_${table.id.slice('pid'.length)}`;
      if (document.getElementById(id)) continue;
      box.id = id;
      reply.before(box);
    }
  };

  const polish = (scope = document) => {
    markRail();
    refreshTimes();
    fixColours(scope);
    applyBlocks();
    landTrip();
    if (pageKind === 'thread') {
      adoptNewPosts();
      buildThreadBar();
      showPagerEnds();
      markAuthors();
      tidyPostMeta();
      addBlockLinks();
      offerHidden();
      offerSensitive();
      offerMedia();
      landOnFloor();
      landOnAnchor();
    } else {
      tidyIndex();
      tidyMessage();
      tidyFilterForms();
      markRows();
    }
  };

  let railDone = false;
  let contentDone = false;
  let titleRead = false;

  // The footer writes its cnzz counter as a blocking script. That server is often slow, and
  // DOMContentLoaded waits for it, sometimes for seconds. Stop it before the inline code runs.
  const counterWatcher = new MutationObserver((records) => {
    for (const { addedNodes } of records) {
      for (const node of addedNodes) {
        if (node.nodeName === 'SCRIPT' && node.textContent.includes('cnzz_protocol')) {
          node.type = 'text/plain';
          counterWatcher.disconnect();
          return;
        }
      }
    }
  });
  counterWatcher.observe(root, { childList: true, subtree: true });

  // Both landmarks are parsed before the render gate opens, so this observer
  // finishes its work inside the hold and nothing moves after the first paint.
  const parseWatcher = new MutationObserver(() => {
    // <title> comes long before the first image, so nothing shows before the blur is on.
    if (!titleRead && document.title) {
      titleRead = true;
      sensitive = pageKind === 'thread' && /nsfw/i.test(document.title);
      applySensitive();
    }
    if (!railDone && document.getElementById('wp')) {
      railDone = true;
      buildRail();
    }
    if (!contentDone && document.getElementById(gateId)) {
      contentDone = true;
      polish();
      addPrefetch();
      parseWatcher.disconnect();
    }
  });
  parseWatcher.observe(root, { childList: true, subtree: true });

  document.addEventListener('click', pressBoard);
  document.addEventListener('click', pressTrip);
  addEventListener('pageshow', ({ persisted }) => {
    if (persisted) markRail();
  });

  document.addEventListener('DOMContentLoaded', () => {
    parseWatcher.disconnect();
    counterWatcher.disconnect();
    if (!railDone) buildRail();
    if (!contentDone) addPrefetch();
    polish();
    bindKeys();
    keepTimesFresh();

    centreBoard();
    if (pageKind === 'thread') {
      document.addEventListener('pointerover', fillCardAvatar);
      startThread();
    } else {
      // Coming back to a list, whether by Back or from a thread in another tab.
      addEventListener('pageshow', ({ persisted }) => {
        if (persisted) markRows();
      });
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) markRows();
      });
    }

    // "下一页" appends threads in place, and quick reply adds new posts.
    let queued = false;
    const watched = new WeakSet();
    // "补充内容" reloads a post's insides in place, which undoes the tidying. Each post is
    // watched on its own, so changes deeper down, such as an opened user card, cost nothing.
    const watchPosts = () => {
      for (const post of listPosts()) {
        if (watched.has(post)) continue;
        watched.add(post);
        dynamic.observe(post, { childList: true });
      }
    };
    const dynamic = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        polish();
        watchPosts();
      });
    });
    for (const target of [$('#threadlisttableid'), $('#postlist')]) {
      if (target) dynamic.observe(target, { childList: true });
    }
    // A reply is filled in while its box is still #post_new, and only counts once Discuz renames it.
    const replies = $('#postlistreply');
    if (replies) dynamic.observe(replies, { childList: true, subtree: true, attributes: true, attributeFilter: ['id'] });
    watchPosts();
    const dialogs = $('#append_parent');
    if (dialogs) {
      new MutationObserver(tidySubject).observe(dialogs, { childList: true, subtree: true });
    }
    tidySubject();
  });
})();
