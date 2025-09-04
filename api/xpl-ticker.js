// api/xpl-ticker.js

const HL_INFO = "https://api.hyperliquid.xyz/info";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const XPL_THRESHOLD = Number(process.env.XPL_THRESHOLD || "1.0");

/** 다중 Chat ID 파싱: 
 * - TELEGRAM_CHAT_ID (쉼표 구분 가능)
 * - TELEGRAM_CHAT_ID_1, TELEGRAM_CHAT_ID_2, ...
 */
function getChatIdsFromEnv() {
  const ids = new Set();

  const main = process.env.TELEGRAM_CHAT_ID;
  if (main) {
    main
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .forEach(v => ids.add(v));
  }

  // 1..10 정도만 스캔 (원하면 늘려도 됨)
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`TELEGRAM_CHAT_ID_${i}`];
    if (k) {
      k
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .forEach(v => ids.add(v));
    }
  }

  return Array.from(ids);
}

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

  const i = (meta?.universe ?? []).findIndex(
    u => (u?.name || "").toUpperCase() === "XPL"
  );
  if (i < 0) throw new Error("XPL not found in universe");

  const mark = Number(ctxs?.[i]?.markPx);
  if (!Number.isFinite(mark)) throw new Error("Invalid markPx");

  return { mark, raw };
}

async function sendTGToMany(text, chatIds) {
  if (!TG_TOKEN) throw new Error("Missing env TELEGRAM_BOT_TOKEN");
  if (!Array.isArray(chatIds) || chatIds.length === 0) {
    throw new Error("No TELEGRAM_CHAT_ID* provided");
  }

  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const results = [];

  for (const chat_id of chatIds) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    const body = await r.text();
    if (!r.ok) {
      results.push({ chat_id, ok: false, error: `TG HTTP ${r.status}: ${body}` });
    } else {
      results.push({ chat_id, ok: true });
    }
  }

  const failed = results.filter(x => !x.ok);
  if (failed.length) {
    const msg = failed.map(f => `[${f.chat_id}] ${f.error}`).join("; ");
    throw new Error(`Some Telegram sends failed: ${msg}`);
  }

  return results;
}

module.exports = async (req, res) => {
  try {
    // 인증: 헤더 x-cron-secret 또는 ?token=
    const headerToken = req.headers["x-cron-secret"];
    const queryToken = (req.query && req.query.token) || undefined;
    if (CRON_SECRET && headerToken !== CRON_SECRET && queryToken !== CRON_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const debug =
      req.query && (req.query.debug === "1" || req.query.debug === "true");

    const { mark, raw } = await fetchHL();
    const now = new Date().toISOString();
    const chatIds = getChatIdsFromEnv();
    const shouldAlert = Number.isFinite(XPL_THRESHOLD) && mark >= XPL_THRESHOLD;

    let sendResult = null;
    let skippedReason = null;

    if (!debug) {
      if (shouldAlert) {
        const msg =
          `<b>XPL 가격 알림</b>\n` +
          `HL(mark): <b>${mark}</b>\n` +
          `임계값: <b>${XPL_THRESHOLD}</b>\n` +
          `${now}`;
        sendResult = await sendTGToMany(msg, chatIds);
      } else {
        skippedReason = `below_threshold (${mark} < ${XPL_THRESHOLD})`;
      }
    }

    const base = {
      ok: true,
      debug: !!debug,
      mark,
      threshold: XPL_THRESHOLD,
      alerted: !debug && shouldAlert,
    };

    if (debug) {
      return res.status(200).json({
        ...base,
        env: {
          TELEGRAM_BOT_TOKEN_present: Boolean(TG_TOKEN),
          TELEGRAM_BOT_TOKEN_len: TG_TOKEN ? TG_TOKEN.length : 0,
          TELEGRAM_CHAT_IDS: chatIds,
          CRON_SECRET_present: Boolean(CRON_SECRET)
        },
        hlRaw: raw
      });
    } else {
      return res.status(200).json({
        ...base,
        sentTo: sendResult ? sendResult.map(r => r.chat_id) : [],
        skippedReason: skippedReason || null
      });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
};