const KEY = 's1lumen:v1';
const DEFAULTS = {
  theme: 'auto',
  dayPalette: 'lumen',
  postSize: 16,
  nightText: 'off',
  nightWhite: 81,
  width: 'wide',
  pageFade: false,
  threadMorph: true,
  signature: false,
  relativeTime: true,
  avatarShape: 'circle',
  resume: true,
  showSensitive: false,
  appLogin: true,
  blockUsers: [],
  blockWords: [],
};

const form = document.body;
const sizeInput = document.getElementById('postSize');
const sizeValue = document.getElementById('postSizeValue');
const wordsInput = document.getElementById('blockWords');
const usersList = document.getElementById('blockUsers');
const paletteRow = document.getElementById('dayPalette');
const nightManual = document.getElementById('nightManual');
const nightInput = document.getElementById('nightWhite');
const nightValue = document.getElementById('nightWhiteValue');
const nightHint = document.getElementById('nightHint');
const nightReset = document.getElementById('nightReset');

let settings = { ...DEFAULTS };

const isDay = () => settings.theme === 'light'
  || (settings.theme === 'auto' && !matchMedia('(prefers-color-scheme: dark)').matches);

const showNightWhite = (value) => {
  nightValue.textContent = `${value}%`;
  nightReset.hidden = value === DEFAULTS.nightWhite;
};

const render = () => {
  for (const input of form.querySelectorAll('input[type="radio"]')) {
    input.checked = settings[input.name] === input.value;
  }
  for (const input of form.querySelectorAll('input[type="checkbox"]')) {
    input.checked = !!settings[input.name];
  }
  paletteRow.hidden = settings.theme === 'dark';
  nightManual.hidden = settings.nightText !== 'manual';
  nightInput.value = settings.nightWhite;
  showNightWhite(settings.nightWhite);
  nightHint.textContent = isDay() && settings.nightText !== 'off'
    ? '日间模式下不生效，切到夜间后才调暗。'
    : '调暗夜间的白字，减轻散光看到的光晕。';
  sizeInput.value = settings.postSize;
  sizeValue.textContent = `${settings.postSize}px`;
  if (document.activeElement !== wordsInput) wordsInput.value = settings.blockWords.join('\n');
  usersList.replaceChildren(...settings.blockUsers.map(({ id, name }) => {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = '解除屏蔽';
    remove.addEventListener('click', () => save({ blockUsers: settings.blockUsers.filter((user) => user.id !== id) }));
    const item = document.createElement('li');
    item.append(name, remove);
    return item;
  }));
  usersList.hidden = !settings.blockUsers.length;
};

const save = (patch) => {
  settings = { ...settings, ...patch };
  render();
  chrome.storage.sync.set({ [KEY]: settings });
};

form.addEventListener('change', ({ target }) => {
  if (target.type === 'radio') save({ [target.name]: target.value });
  else if (target.type === 'checkbox') save({ [target.name]: target.checked });
  if (target.name === 'appLogin' && !target.checked) chrome.storage.local.remove('s1lumen:sid');
});

// Saved as you type, because a popup closes without any warning.
let wordsTimer = 0;
wordsInput.addEventListener('input', () => {
  clearTimeout(wordsTimer);
  wordsTimer = setTimeout(() => {
    save({ blockWords: [...new Set(wordsInput.value.split('\n').map((line) => line.trim()).filter(Boolean))] });
  }, 250);
});

// Live preview while dragging; open forum tabs follow through storage.onChanged.
sizeInput.addEventListener('input', () => save({ postSize: Number(sizeInput.value) }));

// Throttled, unlike the font size: a long track fires far more often, and storage.sync allows
// 120 writes a minute. Every open forum tab also redoes its settings on each one.
let nightTimer = 0;
const saveNight = () => {
  clearTimeout(nightTimer);
  nightTimer = 0;
  save({ nightWhite: Number(nightInput.value) });
};
nightInput.addEventListener('input', () => {
  showNightWhite(Number(nightInput.value));
  nightTimer ||= setTimeout(saveNight, 200);
});
nightInput.addEventListener('change', saveNight);

// The default is the same lightness as 自动, so this lands exactly on its look.
nightReset.addEventListener('click', () => {
  nightInput.value = DEFAULTS.nightWhite;
  saveNight();
});

chrome.storage.sync.get(KEY).then((stored) => {
  settings = { ...DEFAULTS, ...stored[KEY] };
  if (settings.width !== 'standard') settings.width = 'wide';
  render();
});
