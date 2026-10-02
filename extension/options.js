const D = { enabled: true, mode: 'button', model: 'opus', think: true, aboutMe: '' };
const $ = (id) => document.getElementById(id);
chrome.storage.sync.get(D, (v) => { $('enabled').checked = v.enabled; $('model').value = v.model; $('mode').value = v.mode; $('think').checked = v.think; $('aboutMe').value = v.aboutMe; });
$('save').onclick = () => chrome.storage.sync.set({ enabled: $('enabled').checked, model: $('model').value, mode: $('mode').value, think: $('think').checked, aboutMe: $('aboutMe').value }, () => {
  $('saved').textContent = 'Saved'; setTimeout(() => { $('saved').textContent = ''; }, 1500);
});
