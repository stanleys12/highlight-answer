const $ = (id) => document.getElementById(id);
function paint(v) {
  $('enabled').checked = v.enabled;
  for (const b of document.querySelectorAll('.p')) b.classList.toggle('on', b.dataset.p === v.preset);
}
chrome.storage.sync.get({ enabled: true, preset: 'balanced' }, paint);
for (const b of document.querySelectorAll('.p')) b.onclick = () => chrome.storage.sync.set({ preset: b.dataset.p, enabled: true }, () => chrome.storage.sync.get({ enabled: true, preset: 'balanced' }, paint));
$('enabled').onchange = () => chrome.storage.sync.set({ enabled: $('enabled').checked });
$('opts').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
chrome.commands.getAll((cs) => { const c = cs.find((x) => x.name === 'cycle-preset'); if (c) $('key').textContent = c.shortcut || 'not set (chrome://extensions/shortcuts)'; });
