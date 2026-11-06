const KEY = 's1lumen:v1';
const DEFAULTS = {
  theme: 'auto',
  dayPalette: 'lumen',
  postSize: 16,
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

let settings = { ...DEFAULTS };

const render = () => {
  for (const input of form.querySelectorAll('input[type="radio"]')) {
    input.checked = settings[input.name] === input.value;
  }
  for (const input of form.querySelectorAll('input[type="checkbox"]')) {
    input.checked = !!settings[input.name];
  }
  paletteRow.hidden = settings.theme === 'dark';
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

chrome.storage.sync.get(KEY).then((stored) => {
  settings = { ...DEFAULTS, ...stored[KEY] };
  if (settings.width !== 'standard') settings.width = 'wide';
  render();
});
