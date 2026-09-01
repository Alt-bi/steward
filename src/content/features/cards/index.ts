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

  const openBtn = el("button", "stw-btn", "Открыть фабрику карточек");
  openBtn.type = "button";
  openBtn.title =
    "Фабрика живёт во вкладке чата - там же, где ходит заявка в Steam: " +
    "скан бейджей, ротация, журнал дропов.";

  section.body.append(
    el(
      "p",
      "stw-hint",
      "Фарм карточек живёт на странице чата: там же, где ходит заявка в Steam. Фабрика сама считает бейджи и выбивает всё, за что Steam ещё должен карточки - настраивать нечего."
    ),
    openBtn
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

  section.setStatus("Фабрика карточек - на странице чата");
}

register({
  id: "cards",
  title: "Карточки",
  matches: (url) => /(^|\/)badges\/?$/.test(url.pathname),
  mount,
});
