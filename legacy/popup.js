const DEFAULTS = { delayMs: 1600, undercutCents: 1, skipSelfUndercut: true };

document.getElementById("open-market").addEventListener("click", function () {
  chrome.tabs.create({ url: "https://steamcommunity.com/market/" });
});

chrome.storage.local.get(DEFAULTS, function (items) {
  document.getElementById("delay").value = items.delayMs || DEFAULTS.delayMs;
});

document.getElementById("delay").addEventListener("change", function (e) {
  var n = parseInt(e.target.value, 10);
  if (!n || n < 800) n = 800;
  if (n > 8000) n = 8000;
  e.target.value = n;
  chrome.storage.local.set({ delayMs: n });
});
