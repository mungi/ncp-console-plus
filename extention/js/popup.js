// 팝업: 기능 on/off 설정만 chrome.storage.sync 에 저장 (content script 가 변경을 감지해 즉시 반영)
const rows = [...document.querySelectorAll('[data-key]')];
const defaults = Object.fromEntries(rows.map((row) => [row.dataset.key, true]));

const manifest = chrome.runtime.getManifest();
document.getElementById('ext-name').textContent = manifest.name;
document.getElementById('ext-version').textContent = 'v' + manifest.version;

function render(key, enabled) {
  const row = rows.find((r) => r.dataset.key === key);
  if (row) row.setAttribute('aria-checked', String(enabled));
}

chrome.storage.sync.get(defaults, (items) => {
  for (const key of Object.keys(defaults)) render(key, items[key] !== false);
});

for (const row of rows) {
  row.addEventListener('click', () => {
    const next = row.getAttribute('aria-checked') !== 'true';
    render(row.dataset.key, next);
    chrome.storage.sync.set({ [row.dataset.key]: next });
  });
}

// 콘솔 페이지의 자동연장 토글로 바뀐 경우에도 팝업 표시 동기화
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const key of Object.keys(changes)) render(key, changes[key].newValue !== false);
});
