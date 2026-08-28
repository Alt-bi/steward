(function () {
  const HOST_ID = "srp-root";
  if (document.getElementById(HOST_ID)) return;

  var state = {
    busy: false,
    abort: false,
    listings: [],
    plans: [],
    settings: Object.assign({}, SRP_DEFAULTS),
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function currency() {
    return srpCurrencyId();
  }

  function money(cents) {
    if (cents == null || cents === "") return "—";
    return srpFormatCents(cents, currency());
  }

  function loadSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(SRP_DEFAULTS, function (items) {
          state.settings = Object.assign({}, SRP_DEFAULTS, items || {});
          resolve(state.settings);
        });
      } catch (e) {
        resolve(state.settings);
      }
    });
  }

  function setStatus(text, kind) {
    var s = document.getElementById("srp-status");
    if (!s) return;
    s.textContent = text;
    s.dataset.kind = kind || "";
  }

  function setBusy(busy) {
    state.busy = busy;
    var scan = document.getElementById("srp-scan");
    var apply = document.getElementById("srp-apply");
    var stop = document.getElementById("srp-stop");
    if (scan) scan.disabled = busy;
    if (apply) apply.disabled = busy || countReprices() === 0;
    if (stop) stop.disabled = !busy;
  }

  function countReprices() {
    var n = 0;
    for (var i = 0; i < state.plans.length; i++) {
      if (state.plans[i].action === "reprice" && state.plans[i].result !== "ok") n++;
    }
    return n;
  }

  function renderStats() {
    var total = state.listings.length;
    var over = 0;
    var skip = 0;
    for (var i = 0; i < state.plans.length; i++) {
      if (state.plans[i].action === "reprice") over++;
      else skip++;
    }
    document.getElementById("srp-stat-total").textContent = String(total);
    document.getElementById("srp-stat-over").textContent = String(over);
    document.getElementById("srp-stat-skip").textContent = String(skip);
    var apply = document.getElementById("srp-apply");
    if (apply) {
      apply.textContent = over ? "Переставить " + over : "Переставить";
      apply.disabled = state.busy || over === 0;
    }
  }

  function renderRows() {
    var body = document.getElementById("srp-rows");
    body.replaceChildren();
    if (!state.plans.length) {
      body.appendChild(el("div", "srp-empty", "Нажми «Сканировать» — сверю лоты с минимумом рынка."));
      return;
    }
    for (var i = 0; i < state.plans.length; i++) {
      body.appendChild(rowEl(state.plans[i]));
    }
  }

  function rowEl(plan) {
    var row = el("div", "srp-row");
    row.dataset.id = plan.listingId;
    var kind = plan.result || plan.action;
    row.dataset.kind = kind;

    var name = el("div", "srp-name", plan.name);
    name.title = plan.hash;

    var prices = el("div", "srp-prices");
    var ours = el("span", "srp-our", money(plan.ourBuyer));
    var arrow = el("span", "srp-arrow", "→");
    var target =
      plan.action === "reprice"
        ? el("span", "srp-tgt", money(plan.targetBuyer))
        : el("span", "srp-tgt srp-muted", money(plan.competitorBuyer));
    prices.appendChild(ours);
    prices.appendChild(arrow);
    prices.appendChild(target);

    var why = el("div", "srp-why", plan.resultMessage || plan.reason);
    row.appendChild(name);
    row.appendChild(prices);
    row.appendChild(why);
    return row;
  }

  function patchRow(plan) {
    var node = document.querySelector('#srp-rows .srp-row[data-id="' + plan.listingId + '"]');
    if (!node) return;
    var next = rowEl(plan);
    node.replaceWith(next);
  }

  async function scan() {
    if (state.busy) return;
    state.abort = false;
    setBusy(true);
    state.listings = [];
    state.plans = [];
    renderRows();
    renderStats();
    srpRequestPageInfo();
    await srpSleep(200);
    await loadSettings();

    if (!srpSessionId()) {
      setStatus("Не вижу sessionid — зайди в Steam в этой вкладке.", "err");
      setBusy(false);
      return;
    }

    try {
      setStatus("Читаю мои лоты…", "work");
      var listings = await srpLoadMyListings(function (p) {
        setStatus("Лоты: " + p.loaded + " / " + p.total, "work");
      });
      if (state.abort) throw new Error("stopped");
      state.listings = listings;
      renderStats();

      if (!listings.length) {
        setStatus(
          "Лоты не разобрались (Steam total=" +
            (typeof srpLastLoadMeta !== "undefined" ? srpLastLoadMeta.total : "?") +
            "). Нажми обновление расширения на edge://extensions и перезагрузи маркет.",
          "err"
        );
        renderRows();
        setBusy(false);
        return;
      }

      var groups = {};
      for (var i = 0; i < listings.length; i++) {
        var L = listings[i];
        var key = L.appid + "\t" + L.hash;
        if (!groups[key]) {
          groups[key] = { key: key, appid: L.appid, hash: L.hash, name: L.name };
        }
      }
      var uniques = Object.keys(groups).map(function (k) { return groups[k]; });
      setStatus(
        "Лотов " + listings.length + ", уникальных " + uniques.length + " — качаю минимумы пачками…",
        "work"
      );

      var marketLowByKey = await srpFetchMarketLows(uniques, {
        concurrency: state.settings.scanConcurrency || 3,
        gapMs: state.settings.scanGapMs || 150,
        abort: function () { return state.abort; },
        onProgress: function (done, total, item, net) {
          var extra = net && net.hits429 ? " · лимит×" + net.hits429 : "";
          setStatus("Цены " + done + "/" + total + extra + " · " + item.name, "work");
        },
        onWait: function (left, hits) {
          setStatus("Лимит Steam, пауза " + left + "с (срабатываний " + hits + ")", "warn");
        },
      });

      state.plans = srpPlan(listings, marketLowByKey, state.settings.undercutCents || 1);
      renderRows();
      renderStats();
      var n = countReprices();
      var lim =
        typeof srpNet !== "undefined" && (srpNet.hits429 || srpNet.hitsFalse)
          ? " Steam: ок " + srpNet.ok + ", 429×" + srpNet.hits429 + ", пустых " + srpNet.hitsFalse + "."
          : "";
      setStatus(
        (n ? n + " оверпрайс — можно переставить на −1 коп. от чужого минимума." : "Оверпрайса нет.") + lim,
        n ? "warn" : "ok"
      );
    } catch (e) {
      if (e.message === "stopped") setStatus("Остановлено.", "");
      else if (e.message === "not_logged_in") setStatus("Нужен логин Steam в этой вкладке.", "err");
      else setStatus("Ошибка скана: " + e.message, "err");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (state.busy) return;
    var todo = state.plans.filter(function (p) {
      return p.action === "reprice" && p.result !== "ok";
    });
    if (!todo.length) return;
    if (
      !window.confirm(
        "Снять " +
          todo.length +
          " лот(ов) и выставить на 1 копейку ниже чужого минимума?\n\nПосле этого подтверди продажи в приложении Steam Guard."
      )
    ) {
      return;
    }

    state.abort = false;
    setBusy(true);
    await loadSettings();
    var delay = Math.max(900, state.settings.delayMs || 1600);
    var ok = 0;
    var fail = 0;
    var needGuard = 0;

    for (var i = 0; i < todo.length; i++) {
      if (state.abort) break;
      var plan = todo[i];
      setStatus("Переставляю " + (i + 1) + "/" + todo.length + ": " + plan.name, "work");
      try {
        var json = await srpApplyOne(plan, delay);
        plan.result = "ok";
        if (json.needs_mobile_confirmation || json.requires_confirmation) {
          plan.resultMessage = "ожидает Steam Guard";
          needGuard++;
        } else {
          plan.resultMessage = "выставлен " + money(plan.targetBuyer);
        }
        ok++;
      } catch (e) {
        plan.result = "fail";
        plan.resultMessage = "ошибка: " + e.message;
        fail++;
        if (e.message === "rate_limited") await srpSleep(8000);
      }
      patchRow(plan);
      renderStats();
    }

    var parts = ["Готово: " + ok + " ок"];
    if (fail) parts.push(fail + " ошибок");
    if (needGuard) parts.push("подтверди " + needGuard + " в Steam Guard");
    if (state.abort) parts.push("остановлено");
    setStatus(parts.join(" · "), fail ? "warn" : "ok");
    setBusy(false);
  }

  function build() {
    var root = el("div", "srp-panel");
    root.id = HOST_ID;

    var head = el("div", "srp-head");
    var title = el("div", "srp-title", "Steam Reprice");
    var sub = el("div", "srp-sub", "оверпрайс → −1 коп. от чужого минимума");
    var titles = el("div", "srp-titles");
    titles.appendChild(title);
    titles.appendChild(sub);
    var minBtn = el("button", "srp-iconbtn", "–");
    minBtn.type = "button";
    minBtn.title = "Свернуть";
    minBtn.addEventListener("click", function () {
      root.classList.toggle("srp-collapsed");
    });
    head.appendChild(titles);
    head.appendChild(minBtn);

    var stats = el("div", "srp-stats");
    function stat(id, label) {
      var box = el("div", "srp-stat");
      box.appendChild(el("div", "srp-stat-n", "0")).id = id;
      box.appendChild(el("div", "srp-stat-l", label));
      return box;
    }
    stats.appendChild(stat("srp-stat-total", "лотов"));
    stats.appendChild(stat("srp-stat-over", "оверпрайс"));
    stats.appendChild(stat("srp-stat-skip", "пропуск"));

    var actions = el("div", "srp-actions");
    var scanBtn = el("button", "srp-btn srp-btn-primary", "Сканировать");
    scanBtn.id = "srp-scan";
    scanBtn.type = "button";
    var applyBtn = el("button", "srp-btn srp-btn-go", "Переставить");
    applyBtn.id = "srp-apply";
    applyBtn.type = "button";
    applyBtn.disabled = true;
    var stopBtn = el("button", "srp-btn", "Стоп");
    stopBtn.id = "srp-stop";
    stopBtn.type = "button";
    stopBtn.disabled = true;
    actions.appendChild(scanBtn);
    actions.appendChild(applyBtn);
    actions.appendChild(stopBtn);

    var status = el("div", "srp-status", "Открой страницу маркета, будучи в Steam, и нажми «Сканировать».");
    status.id = "srp-status";

    var rows = el("div", "srp-rows");
    rows.id = "srp-rows";
    rows.appendChild(el("div", "srp-empty", "Нажми «Сканировать» — сверю лоты с минимумом рынка."));

    root.appendChild(head);
    root.appendChild(stats);
    root.appendChild(actions);
    root.appendChild(status);
    root.appendChild(rows);
    document.documentElement.appendChild(root);

    scanBtn.addEventListener("click", scan);
    applyBtn.addEventListener("click", apply);
    stopBtn.addEventListener("click", function () {
      state.abort = true;
      setStatus("Останавливаю…", "warn");
    });

    makeDraggable(root, head);
  }

  function makeDraggable(box, handle) {
    var drag = null;
    handle.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      if (e.target.closest("button")) return;
      var r = box.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      box.style.right = "auto";
      box.style.bottom = "auto";
      box.style.left = r.left + "px";
      box.style.top = r.top + "px";
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!drag) return;
      var x = Math.max(8, Math.min(window.innerWidth - 80, e.clientX - drag.dx));
      var y = Math.max(8, Math.min(window.innerHeight - 40, e.clientY - drag.dy));
      box.style.left = x + "px";
      box.style.top = y + "px";
    });
    window.addEventListener("mouseup", function () {
      drag = null;
    });
  }

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === "srp-scan") scan();
    if (msg.type === "srp-ping") sendResponse({ ok: true, over: countReprices() });
  });

  build();
  loadSettings();
  srpRequestPageInfo();
})();
