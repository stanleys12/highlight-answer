const D = { enabled: true, mode: 'instant', model: 'opus', think: true, speculate: true, verify: true, aboutMe: '' };
const $ = (id) => document.getElementById(id);
chrome.storage.sync.get(D, (v) => { $('enabled').checked = v.enabled; $('model').value = v.model; $('mode').value = v.mode; $('think').checked = v.think; $('speculate').checked = v.speculate; $('verify').checked = v.verify; $('aboutMe').value = v.aboutMe; });
$('save').onclick = () => chrome.storage.sync.set({ enabled: $('enabled').checked, model: $('model').value, mode: $('mode').value, think: $('think').checked, speculate: $('speculate').checked, verify: $('verify').checked, aboutMe: $('aboutMe').value }, () => {
  $('saved').textContent = 'Saved'; setTimeout(() => { $('saved').textContent = ''; }, 1500);
});

// ── performance, from the helper's metrics.jsonl ──
const sec = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's');
const p = (o) => (o && o.n ? `${sec(o.p50)} <small>/ ${sec(o.p90)}</small>` : '—');
function loadStats() {
  chrome.runtime.sendMessage({ type: 'stats', days: +$('days').value }, (s) => {
    const el = $('stats');
    if (!s || !s.ok) { el.innerHTML = '<small>' + ((s && s.error) || 'helper not reachable') + '</small>'; return; }
    const w = s.youWaited;
    let h = `<p><span class="big">${p(w.clickToDoneMs)}</span> <small>typical / slow (p50 / p90) from release (or click) to the answer</small><br>
      <span class="big">${p(w.clickToFirstMs)}</span> <small>wait until the first words appear</small><br>
      <span class="big">${p(w.checkedMs)}</span> <small>until the double-check lands</small><br>
      <small>Quick answer agreed with the double-check ${w.agreed} of ${w.compared} times${w.compared ? ' (' + Math.round(100 * w.agreed / w.compared) + '%)' : ''}. ${w.readyBeforeClick} of ${w.of} answers were already done when you clicked.</small></p>`;
    h += '<table><tr><th>model</th><th>calls</th><th>total</th><th>first output</th><th>first words</th><th>CLI overhead</th><th>avg cost</th><th>avg thinking</th></tr>';
    for (const [m, b] of Object.entries(s.model)) h += `<tr><td>${m}</td><td>${b.calls}</td><td>${p(b.totalMs)}</td><td>${p(b.firstOutputMs)}</td><td>${p(b.firstAnswerMs)}</td><td>${p(b.cliOverheadMs)}</td><td>$${b.avgCost}</td><td>${b.avgThinkTok} tok</td></tr>`;
    h += '</table>';
    h += `<p><small>${s.requests} requests · ${s.modelCalls} model calls · ${s.cacheHits} cache hits · ${s.joinedInFlight} joined a call already running · ${s.errors} errors<br>
      Started early: ${s.speculation.started}, never clicked: ${s.speculation.neverUsed} ($${s.speculation.wastedCost})<br>
      Cost: today $${s.cost.today} · this window $${s.cost.window} · all time $${s.cost.allTime}</small></p>`;
    el.innerHTML = h;
  });
}
$('days').onchange = loadStats; loadStats();
