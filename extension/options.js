const D = { enabled: true, model: 'sonnet', aboutMe: '' };
const $ = (id) => document.getElementById(id);
chrome.storage.sync.get(D, (v) => { $('enabled').checked = v.enabled; $('model').value = v.model; $('aboutMe').value = v.aboutMe; });
$('save').onclick = () => chrome.storage.sync.set({ enabled: $('enabled').checked, model: $('model').value, aboutMe: $('aboutMe').value }, () => {
  $('saved').textContent = 'Saved'; setTimeout(() => { $('saved').textContent = ''; }, 1500);
});
