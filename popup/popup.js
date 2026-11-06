const KEY = 's1lumen:v1';
const DEFAULTS = {
  theme: 'auto',
  postSize: 17,
  width: 'wide',
  pageFade: true,
  signature: false,
  relativeTime: true,
};

const form = document.body;
const sizeInput = document.getElementById('postSize');
const sizeValue = document.getElementById('postSizeValue');

let settings = { ...DEFAULTS };

const render = () => {
  for (const input of form.querySelectorAll('input[type="radio"]')) {
    input.checked = settings[input.name] === input.value;
  }
  for (const input of form.querySelectorAll('input[type="checkbox"]')) {
    input.checked = !!settings[input.name];
  }
  sizeInput.value = settings.postSize;
  sizeValue.textContent = `${settings.postSize}px`;
};

const save = (patch) => {
  settings = { ...settings, ...patch };
  render();
  chrome.storage.sync.set({ [KEY]: settings });
};

form.addEventListener('change', ({ target }) => {
  if (target.type === 'radio') save({ [target.name]: target.value });
  else if (target.type === 'checkbox') save({ [target.name]: target.checked });
});

// Live preview while dragging; open forum tabs follow through storage.onChanged.
sizeInput.addEventListener('input', () => save({ postSize: Number(sizeInput.value) }));

chrome.storage.sync.get(KEY).then((stored) => {
  settings = { ...DEFAULTS, ...stored[KEY] };
  if (settings.width !== 'standard') settings.width = 'wide';
  render();
});
