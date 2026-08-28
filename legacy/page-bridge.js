(function () {
  const SRC = "steam-reprice-page";

  function snapshot() {
    return {
      source: SRC,
      sessionid: window.g_sessionID || null,
      steamid: window.g_steamID || null,
      wallet: window.g_rgWalletInfo || null,
      language: window.g_strLanguage || "english",
      country: window.g_strCountryCode || null,
      assets: window.g_rgAssets || null,
    };
  }

  function send() {
    window.postMessage(snapshot(), "*");
  }

  send();
  var ticks = 0;
  var timer = setInterval(function () {
    ticks += 1;
    if (window.g_rgWalletInfo && window.g_sessionID) {
      send();
      clearInterval(timer);
      return;
    }
    if (ticks >= 60) clearInterval(timer);
  }, 250);

  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    if (e.data && e.data.source === "steam-reprice-ext" && e.data.type === "request-page") {
      send();
    }
  });
})();
