import { send } from "../../../core/messaging";
import { el } from "../../ui/panel";
import { register, type FeatureContext } from "../registry";

/**
 * The badges page is not where farming happens - it only hands off. Every card
 * interface (scan, rotation, drop ledger) lives on the /chat page at
 * #stw-farm, beside the CM socket that carries the claim: one window, one tab
 * to keep open, like the factory the user came from.
 *
 * Why the old tab and its ASF/bot mode are gone: the self-hosted holder CT
 * was torn down (2026-08-31) and the chat client was proven to drip cards.
 * A second engine was only more surface to lie about.
 */

async function mount(ctx: FeatureContext): Promise<void> {
  const section = ctx.panel.addSection("cards", "Карточки");

  /**
   * One button and one sentence. This page hands off — everything it could
   * describe about the factory is on the factory's own tab, one click away,
   * and describing it twice is how the two descriptions start disagreeing.
   */
  const row = el("div", "stw-actions stw-actions-main");
  const openBtn = el("button", "stw-btn stw-btn-primary", "Открыть фабрику");
  openBtn.type = "button";
  row.appendChild(openBtn);

  section.body.append(
    el("div", "stw-hint", "Фабрика сама считает бейджи и выбивает всё, за что Steam ещё должен карточки."),
    row
  );

  openBtn.addEventListener("click", () => {
    void (async () => {
      const r = await send("farm/open", {});
      section.setStatus(
        r.ok ? "Фабрика открылась во вкладке чата" : "Не удалось открыть вкладку чата",
        r.ok ? "ok" : "err"
      );
    })();
  });

  section.setStatus("Фабрика живёт во вкладке чата — там же, где заявка в Steam");
}

register({
  id: "cards",
  title: "Карточки",
  matches: (url) => /(^|\/)badges\/?$/.test(url.pathname),
  mount,
});
