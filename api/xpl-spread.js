const HL_INFO = "https://api.hyperliquid.xyz/info";
const BX_PRICE = "https://open-api.bingx.com/openApi/spot/v1/ticker/price";
const BX_24HR = "https://open-api.bingx.com/openApi/spot/v1/ticker/24hr";
const BX_SYMBOLS = "https://open-api.bingx.com/openApi/spot/v1/common/symbols";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const UPPER_PCT = Number(process.env.SPREAD_UPPER_PCT ?? "40");
const LOWER_PCT = Number(process.env.SPREAD_LOWER_PCT ?? "3");

async function fetchHL() {
  const out = { ok: false, mark: null, status: null, raw: null, error: null };
  try {
    const r = await fetch(HL_INFO, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" })
    });
    out.status = r.status;
    out.raw = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const parsed = JSON.parse(out.raw);
    const [meta, ctxs] = parsed;
    const i = (meta?.universe ?? []).findIndex(u => (u?.name || "").toUpperCase() === "XPL");
    if (i < 0) throw new Error("XPL not found");
    const mark = Number(ctxs?.[i]?.markPx);
    if (!Number.isFinite(mark)) throw new Error("Invalid markPx");
    out.mark = mark;
    out.ok = true;
  } catch (e) {
    out.error = String(e.message || e);
  }
  return out;
}

async function discoverBingxSymbol() {
  const candidates = ["XPL-USDT", "XPL_USDT", "XPLUSDT"];
  try {
    const rs = await fetch(BX_SYMBOLS);
    const raw = await rs.text();
    let js; try { js = JSON.parse(raw); } catch { js = null; }
    const arr = Array.isArray(js?.data?.symbols) ? js.data.symbols : [];
    if (arr.length) {
      const all = arr.map(x => x?.symbol).filter(Boolean);
      const xplLike = all.filter(s => typeof s === "string" && s.toUpperCase().includes("XPL"));
      if (xplLike.length) {
        const s = xplLike[0];
        return { symbolApiForms: [s, s.replace("-", "_"), s.replace("-", "").replace("_","")], seenSymbols: all };
      }
      return { symbolApiForms: candidates, seenSymbols: all };
    }
  } catch {}
  return { symbolApiForms: candidates, seenSymbols: [] };
}

async function fetchBingxSpot() {
  const out = {
    ok: false, price: null, symbolTried: [], priceStatus: null, priceRaw: null,
    hr24Status: null, hr24Raw: null, symbolsSeen: [], error: null
  };
  const { symbolApiForms, seenSymbols } = await discoverBingxSymbol();
  out.symbolsSeen = seenSymbols;

  for (const form of symbolApiForms) {
    try {
      const u = new URL(BX_PRICE);
      u.searchParams.set("symbol", form);
      u.searchParams.set("timestamp", String(Date.now()));
      const r = await fetch(u.toString());
      out.priceStatus = r.status;
      out.priceRaw = await r.text();
      out.symbolTried.push(form);
      if (r.ok) {
        let j; try { j = JSON.parse(out.priceRaw); } catch {}
        const v = Number(j?.data?.price ?? j?.price);
        if (Number.isFinite(v)) { out.ok = true; out.price = v; return out; }
      }
    } catch (e) {
      out.error = `price err(${form}): ${String(e.message || e)}`;
    }
  }

  try {
    const u2 = new URL(BX_24HR);
    u2.searchParams.set("timestamp", String(Date.now()));
    const r2 = await fetch(u2.toString());
    out.hr24Status = r2.status;
    out.hr24Raw = await r2.text();
    if (r2.ok) {
      let j2; try { j2 = JSON.parse(out.hr24Raw); } catch {}
      const arr = Array.isArray(j2) ? j2 : (Array.isArray(j2?.data) ? j2.data : []);
      for (const form of symbolApiForms) {
        const norm = form.replace("_","-").toUpperCase();
        const hit = arr.find(x => (x?.symbol || "").toUpperCase() === norm);
        if (hit) {
          const v2 = Number(hit?.lastPrice ?? hit?.close ?? hit?.price);
          if (Number.isFinite(v2)) { out.ok = true; out.price = v2; return out; }
        }
      }
    }
  } catch (e) {
    out.error = `${out.error ? out.error + " | " : ""}24hr err: ${String(e.message || e)}`;
  }

  if (!out.ok && !out.error) out.error = "not found";
  return out;
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
    const debug = req.query && (req.query.debug === "1" || req.query.debug === "true");

    if (CRON_SECRET && headerToken !== CRON_SECRET && queryToken !== CRON_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const [hl, bx] = await Promise.all([fetchHL(), fetchBingxSpot()]);
    if (!hl.ok) return res.status(500).json({ ok: false, source: "hyperliquid", ...hl });
    if (!bx.ok)   return res.status(500).json({ ok: false, source: "bingx", ...bx });

    const spreadPct = ((hl.mark / bx.price) - 1) * 100;

    let alerted = false;
    const now = new Date().toISOString();

    if (!debug) {
      if (spreadPct >= UPPER_PCT) {
        await sendTG(
          `<b>XPL 괴리 상한(≥${UPPER_PCT}%)</b>\nHL(mark): <b>${hl.mark}</b>\nBingX(spot): <b>${bx.price}</b>\nSpread: <b>${spreadPct.toFixed(3)}%</b>\n${now}`
        );
        alerted = true;
      }
      if (spreadPct <= LOWER_PCT) {
        await sendTG(
          `<b>XPL 괴리 축소(≤${LOWER_PCT}%)</b>\nHL(mark): <b>${hl.mark}</b>\nBingX(spot): <b>${bx.price}</b>\nSpread: <b>${spreadPct.toFixed(3)}%</b>\n${now}`
        );
        alerted = true;
      }
    }

    res.status(200).json({
      ok: true,
      debug: !!debug,
      hl: { mark: hl.mark, status: hl.status },
      bingx: {
        tried: bx.symbolTried,
        seen: bx.symbolsSeen,
        price: bx.price,
        priceStatus: bx.priceStatus,
        hr24Status: bx.hr24Status
      },
      spreadPct,
      upper: UPPER_PCT,
      lower: LOWER_PCT,
      alerted,
      ...(debug ? {
        hlRaw: hl.raw,
        bxPriceRaw: bx.priceRaw,
        bx24hrRaw: bx.hr24Raw
      } : {})
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
};