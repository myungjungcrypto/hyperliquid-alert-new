const HL_INFO = "https://api.hyperliquid.xyz/info";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

// 임계값(기본 1.0). 매분 크론이 호출될 때 mark >= 임계값이면 텔레그램 알림 보냄
const XPL_THRESHOLD = Number(process.env.XPL_THRESHOLD || "1.0");

async function fetchHL() {
  const r = await fetch(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" })
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`HL HTTP ${r.status}: ${raw}`);
  const parsed = JSON.parse(raw);
  const [meta, ctxs] = parsed;
  const i = (meta?.universe ?? []).findIndex(u => (u?.name || "").toUpperCase() === "XPL");
  if (i < 0) throw new Error("XPL not found");
  const mark = Number(ctxs?.[i]?.markPx);
  if (!Number.isFinite(mark)) throw new Error("Invalid markPx");
  return { mark, raw };
}

async function sendTG(text) {
  if (!TG_TOKEN) throw new Error("Missing env TELEGRAM_BOT_TOKEN");
  if (!TG_CHAT_ID) throw new Error("Missing env TELEGRAM_CHAT_ID");
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`TG HTTP ${r.status}: ${body}`);
}

module.exports = async (req, res) => {
  try {
    const headerToken = req.headers["x-cron-secret"];
    const queryToken = (req.query && req.query.token) || undefined;
    const debug = req.query && (req.query.debug === "1" || req.query.debug === "true");
    if (CRON_SECRET && headerToken !== CRON_SECRET && queryToken !== CRON_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const { mark, raw } = await fetchHL();
    const now = new Date().toISOString();

    let sent = false;
    let reason = "below-threshold";
    if (mark >= XPL_THRESHOLD) {
      reason = "over-threshold";
      if (!debug) {
        const msg = [
          `<b>XPL 가격 알림</b>`,
          `HL(mark): <b>${mark}</b>`,
          `임계값: <b>${XPL_THRESHOLD}</b>`,
          `${now}`
        ].join("\n");
        await sendTG(msg);
      }
      sent = true;
    }

    res.status(200).json({
      ok: true,
      debug: !!debug,
      mark,
      threshold: XPL_THRESHOLD,
      alert: { sent, reason },
      ...(debug ? {
        env: {
          TELEGRAM_BOT_TOKEN_present: Boolean(TG_TOKEN),
          TELEGRAM_CHAT_ID_present: Boolean(TG_CHAT_ID),
          CRON_SECRET_present: Boolean(CRON_SECRET),
        },
        hlRaw: raw
      } : {})
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
};