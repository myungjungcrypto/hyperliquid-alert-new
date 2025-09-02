const HL_INFO = "https://api.hyperliquid.xyz/info";
const BX_PRICE = "https://open-api.bingx.com/openApi/spot/v1/ticker/price?symbol=XPLUSDT";
const BX_24HR = "https://open-api.bingx.com/openApi/spot/v1/ticker/24hr";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const UPPER_PCT = Number(process.env.SPREAD_UPPER_PCT ?? "40");
const LOWER_PCT = Number(process.env.SPREAD_LOWER_PCT ?? "3");

async function fetchHyperliquidMark() {
  const r = await fetch(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" })
  });
  if (!r.ok) throw new Error(`Hyperliquid HTTP ${r.status}`);
  const [meta, ctxs] = await r.json();
  const i = (meta?.universe ?? []).findIndex(u => (u?.name || "").toUpperCase() === "XPL");
  if (i < 0) throw new Error("XPL not found");
  const v = Number(ctxs?.[i]?.markPx);
  if (!Number.isFinite(v)) throw new Error("Invalid markPx");
  return v;
}

async function fetchBingxSpot() {
  const r1 = await fetch(BX_PRICE);
  if (r1.ok) {
    const j1 = await r1.json();
    const v1 = Number(j1?.data?.price ?? j1?.price);
    if (Number.isFinite(v1)) return v1;
  }
  const r2 = await fetch(BX_24HR);
  if (r2.ok) {
    const j2 = await r2.json();
    if (Array.isArray(j2)) {
      const hit = j2.find(x => (x?.symbol || "").toUpperCase() === "XPLUSDT");
      const v2 = Number(hit?.lastPrice ?? hit?.close ?? hit?.price);
      if (Number.isFinite(v2)) return v2;
    } else if (j2 && Array.isArray(j2?.data)) {
      const hit = j2.data.find(x => (x?.symbol || "").toUpperCase() === "XPLUSDT");
      const v2 = Number(hit?.lastPrice ?? hit?.close ?? hit?.price);
      if (Number.isFinite(v2)) return v2;
    }
  }
  throw new Error("BingX price not found");
}

async function sendTG(text) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  if (!r.ok) throw new Error(`Telegram HTTP ${r.status}`);
}

module.exports = async (req, res) => {
  try {
    const headerToken = req.headers["x-cron-secret"];
    const queryToken = (req.query && req.query.token) || undefined;
    if (CRON_SECRET && headerToken !== CRON_SECRET && queryToken !== CRON_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const [hl, bx] = await Promise.all([fetchHyperliquidMark(), fetchBingxSpot()]);
    const spreadPct = ((hl / bx) - 1) * 100;

    let alerted = false;
    const now = new Date().toISOString();

    if (spreadPct >= UPPER_PCT) {
      await sendTG(
        `<b>XPL 괴리 상한(≥${UPPER_PCT}%)</b>\nHL(mark): <b>${hl}</b>\nBingX(spot): <b>${bx}</b>\nSpread: <b>${spreadPct.toFixed(3)}%</b>\n${now}`
      );
      alerted = true;
    }

    if (spreadPct <= LOWER_PCT) {
      await sendTG(
        `<b>XPL 괴리 축소(≤${LOWER_PCT}%)</b>\nHL(mark): <b>${hl}</b>\nBingX(spot): <b>${bx}</b>\nSpread: <b>${spreadPct.toFixed(3)}%</b>\n${now}`
      );
      alerted = true;
    }

    res.status(200).json({ ok: true, hl, bx, spreadPct, upper: UPPER_PCT, lower: LOWER_PCT, alerted });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
};