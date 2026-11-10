const { DEFAULTS, withDefaults } = S1Lumen;

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
const saveError = document.getElementById('saveError');

let settings = withDefaults();

const isDay = () => settings.theme === 'light'
  || (settings.theme === 'auto' && !matchMedia('(prefers-color-scheme: dark)').matches);

const showNightWhite = (value) => {
  nightValue.textContent = `${value}%`;
  nightReset.hidden = value === DEFAULTS.nightWhite;
};

// A change from a forum tab can arrive while a control is in use. That control keeps what
// the reader is doing with it, and takes the stored value once they let go.
const busy = (input) => document.activeElement === input;

const render = () => {
  for (const input of form.querySelectorAll('input[type="radio"]')) {
    input.checked = settings[input.name] === input.value;
  }
  for (const input of form.querySelectorAll('input[type="checkbox"]')) {
    input.checked = !!settings[input.name];
  }
  paletteRow.hidden = settings.theme === 'dark';
  nightManual.hidden = settings.nightText !== 'manual';
  if (!busy(nightInput)) {
    nightInput.value = settings.nightWhite;
    showNightWhite(settings.nightWhite);
  }
  nightHint.textContent = isDay() && settings.nightText !== 'off'
    ? '日间模式下不生效，切到夜间后才调暗。'
    : '调暗夜间的白字，减轻散光看到的光晕。';
  if (!busy(sizeInput)) sizeInput.value = settings.postSize;
  sizeValue.textContent = `${settings.postSize}px`;
  if (!busy(wordsInput)) wordsInput.value = settings.blockWords.join('\n');
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

// While a write of this popup is under way, the changes Chrome reports are its own, possibly
// an older one, and taking them would undo what was just set.
let writing = 0;

const save = (patch) => {
  settings = { ...settings, ...patch };
  render();
  writing += 1;
  S1Lumen.save(settings).finally(() => {
    writing -= 1;
  }).then(() => {
    saveError.hidden = true;
    // Catch up on anything a forum tab changed in the meantime.
    if (!writing) S1Lumen.load().then(adopt).catch(() => {});
  }, () => {
    // What was typed stays on screen, so it can be trimmed and saved again.
    // Most likely the block lists have outgrown what sync storage holds in all.
    saveError.textContent = '没能保存：屏蔽列表可能太长了，删掉一些再试。';
    saveError.hidden = false;
  });
};

form.addEventListener('change', ({ target }) => {
  if (target.type === 'radio') save({ [target.name]: target.value });
  else if (target.type === 'checkbox') save({ [target.name]: target.checked });
  if (target.name === 'appLogin' && !target.checked) chrome.storage.local.remove('s1lumen:sid');
});

// Saved as you type, because a popup closes without any warning. Leaving the field, or
// closing the popup, saves straight away instead of waiting out the pause.
let wordsTimer = 0;
const saveWords = () => {
  clearTimeout(wordsTimer);
  wordsTimer = 0;
  const words = [...new Set(wordsInput.value.split('\n').map((line) => line.trim()).filter(Boolean))];
  if (words.join('\n') !== settings.blockWords.join('\n')) save({ blockWords: words });
};
wordsInput.addEventListener('input', () => {
  clearTimeout(wordsTimer);
  wordsTimer = setTimeout(saveWords, 250);
});
wordsInput.addEventListener('blur', saveWords);
addEventListener('pagehide', () => {
  if (wordsTimer) saveWords();
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

const adopt = (stored) => {
  settings = withDefaults(stored);
  if (settings.width !== 'standard') settings.width = 'wide';
  render();
};

S1Lumen.load().then(adopt);
// A forum tab may change something while this is open, such as the rail or a block.
S1Lumen.watch((stored) => {
  if (!writing) adopt(stored);
});
