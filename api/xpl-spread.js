const HL_INFO = "https://api.hyperliquid.xyz/info";
const BX_PRICE = "https://open-api.bingx.com/openApi/spot/v1/ticker/price";
const BX_24HR = "https://open-api.bingx.com/openApi/spot/v1/ticker/24hr";
const BX_SYMBOLS = "https://open-api.bingx.com/openApi/spot/v1/common/symbols";

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

async function discoverBingxSymbol() {
  // 1) 우선 고정 후보들
  const candidates = ["XPLUSDT", "XPLUSDT", "XPL_USDT", "XPL-USDT"];
  // 2) 심볼 목록에서 자동 탐색 (있으면 정확한 표기 반환)
  try {
    const rs = await fetch(BX_SYMBOLS);
    if (rs.ok) {
      const js = await rs.json();
      const arr = Array.isArray(js?.data) ? js.data : Array.isArray(js) ? js : [];
      // data[i].symbol 또는 i.symbol 케이스 모두 대응
      const list = arr.map(x => (x?.symbol || x?.baseAsset && x?.quoteAsset ? `${x.baseAsset}${x.quoteAsset}` : "")).filter(Boolean);
      for (const want of candidates) {
        const hit = list.find(s => s.toUpperCase() === want.toUpperCase());
        if (hit) return hit;
      }
      // XPL/USDT 형태가 있으면 합쳐서 반환
      const slash = arr.find(x => (x?.symbol || "").toUpperCase() === "XPL/USDT");
      if (slash) return "XPLUSDT";
    }
  } catch (_) {}
  // 못 찾으면 기본 후보 1순위
  return candidates[0];
}

async function fetchBingxSpot() {
  const symbol = await discoverBingxSymbol();

  // price 엔드포인트 (단건)
  try {
    const u = new URL(BX_PRICE);
    u.searchParams.set("symbol", symbol);
    const r = await fetch(u.toString());
    if (r.ok) {
      const j = await r.json();
      // {data:{price}}, {price} 모두 대응
      const v = Number(j?.data?.price ?? j?.price);
      if (Number.isFinite(v)) return v;
    }
  } catch (_) {}

  // 24hr 엔드포인트: 배열 또는 {data:[...]} 양쪽 대응
  try {
    const r2 = await fetch(BX_24HR);
    if (r2.ok) {
      const j2 = await r2.json();
      const arr = Array.isArray(j2) ? j2 : Array.isArray(j2?.data) ? j2.data : [];
      const hit = arr.find(x => (x?.symbol || "").toUpperCase() === symbol.toUpperCase());
      const v2 = Number(hit?.lastPrice ?? hit?.close ?? hit?.price);
      if (Number.isFinite(v2)) return v2;
    }
  } catch (_) {}

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