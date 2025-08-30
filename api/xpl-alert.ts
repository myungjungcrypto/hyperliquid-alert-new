import type { VercelRequest, VercelResponse } from "@vercel/node";

const HL_INFO = "https://api.hyperliquid.xyz/info";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

const THRESHOLD = Number(process.env.XPL_THRESHOLD ?? "1.0");
const DIRECTION = (process.env.XPL_DIRECTION ?? "above").toLowerCase();
const LABEL = process.env.ALERT_LABEL ?? "XPL Alert";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const hlRes = await fetch(HL_INFO, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" })
    });
    if (!hlRes.ok) throw new Error(`Hyperliquid info HTTP ${hlRes.status}`);
    const [meta, ctxs] = await hlRes.json();

    const universe = meta?.universe ?? [];
    const idx = universe.findIndex((u: any) => (u?.name || "").toUpperCase() === "XPL");
    if (idx === -1) throw new Error("XPL not found in Hyperliquid universe");

    const markPx = Number(ctxs?.[idx]?.markPx);
    if (!isFinite(markPx)) throw new Error("Invalid markPx for XPL");

    const isAbove = markPx > THRESHOLD;
    const isBelow = markPx < THRESHOLD;
    const tripped = (DIRECTION === "above" && isAbove) || (DIRECTION === "below" && isBelow);

    if (tripped) {
      const text = `<b>${LABEL}</b>\nCondition: price ${DIRECTION} ${THRESHOLD}\nXPL Mark Price: <b>${markPx}</b>\nTime: ${new Date().toISOString()}`;
      const tgRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true })
      });
      if (!tgRes.ok) {
        const errTxt = await tgRes.text();
        throw new Error(`Telegram sendMessage failed: ${tgRes.status} ${errTxt}`);
      }
    }
    res.status(200).json({ ok: true, markPx, threshold: THRESHOLD, direction: DIRECTION, alerted: !!tripped });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
