// /api/xpl-spread.ts
const HL_INFO = "https://api.hyperliquid.xyz/info";
const BINGX_TICKER = "https://open-api.bingx.com/openApi/spot/v1/ticker/price?symbol=XPLUSDT";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
const CRON_SECRET = process.env.CRON_SECRET; // 외부 크론 호출 보안용 (권장)

// 임계값(%) — 기본값을 네 기준에 맞춰 둠
const UPPER_PCT = Number(process.env.SPREAD_UPPER_PCT ?? "40"); // ≥40%
const LOWER_PCT = Number(process.env.SPREAD_LOWER_PCT ?? "3");  // ≤3%

async function fetchHyperliquidMark(): Promise<number> {
  const r = await fetch(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" })
  });
  if (!r.ok) throw new Error(`Hyperliquid info HTTP ${r.status}`);
  const [meta, ctxs] = await r.json();
  const i = (meta?.universe ?? []).findIndex((u: any) => (u?.name || "").toUpperCase() === "XPL");
  if (i === -1) throw new Error("XPL not found in universe");
  const markPx = Number(ctxs?.[i]?.markPx);
  if (!isFinite(markPx)) throw new Error("Invalid markPx");
  return markPx;
}

async function fetchBingxSpot(): Promise<number> {
  const r = await fetch(BINGX_TICKER);
  if (!r.ok) throw new Error(`BingX HTTP ${r.status}`);
  const j = await r.json();
  const p = Number(j?.price);
  if (!isFinite(p)) throw new Error("Invalid BingX price");
  return p;
}

async function sendTG(text: string) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Telegram sendMessage failed: ${r.status} ${t}`);
  }
}

export default async function handler(req: any, res: any) {
  try {
    // 외부 크론 보안 (헤더 또는 쿼리로 전달)
    const headerToken = req.headers["x-cron-secret"];
    const queryToken = (req.query && (req.query.token as string)) || undefined;
    if (CRON_SECRET && headerToken !== CRON_SECRET && queryToken !== CRON_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const [hl, bx] = await Promise.all([fetchHyperliquidMark(), fetchBingxSpot()]);
    const spreadPct = ((hl / bx) - 1) * 100; // HL 프리미엄 기준

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
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}