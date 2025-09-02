const HL_INFO = "https://api.hyperliquid.xyz/info";
const BX_PRICE = "https://open-api.bingx.com/openApi/spot/v1/ticker/price";
const BX_24HR = "https://open-api.bingx.com/openApi/spot/v1/ticker/24hr";
const BX_SYMBOLS = "https://open-api.bingx.com/openApi/spot/v1/common/symbols";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const UPPER_PCT = Number(process.env.SPREAD_UPPER_PCT ?? "40");
const LOWER_PCT = Number(process.env.SPREAD_LOWER_PCT ?? "3");

async function fetchHL(debug) {
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

async function discoverBingxSymbol(debug) {
  const out = { symbol: "XPLUSDT", status: null, raw: null, tried: [] };
  out.tried.push("XPLUSDT");
  try {
    const rs = await fetch(BX_SYMBOLS);
    out.status = rs.status;
    out.raw = await rs.text();
    if (rs.ok) {
      const js = JSON.parse(out.raw);
      const arr = Array.isArray(js?.data) ? js.data : Array.isArray(js) ? js : [];
      const list = arr.map(x => x?.symbol || (x?.baseAsset && x?.quoteAsset ? `${x.baseAsset}${x.quoteAsset}` : "")).filter(Boolean);
      const candidates = ["XPLUSDT", "XPLUSDT", "XPL_USDT", "XPL-USDT", "XPL/USDT"];
      for (const want of candidates) {
        const hit = list.find(s => (s || "").toUpperCase() === want.toUpperCase());
        if (hit) {
          out.symbol = (hit.includes("/") ? hit.replace("/", "") : hit.replace("-", "").replace("_",""));
          out.tried = candidates;
          return out;
        }
      }
    }
  } catch (_) {}
  return out;
}

async function fetchBingxSpot(debug) {
  const out = {
    ok: false, price: null, symbol: null,
    priceStatus: null, priceRaw: null,
    hr24Status: null, hr24Raw: null,
    symbolsStatus: null, symbolsRaw: null,
    error: null
  };

  const symInfo = await discoverBingxSymbol(debug);
  out.symbol = symInfo.symbol;
  out.symbolsStatus = symInfo.status;
  out.symbolsRaw = symInfo.raw;

  // 1) ticker/price (단건)
  try {
    const u = new URL(BX_PRICE);
    u.searchParams.set("symbol", out.symbol);
    const r1 = await fetch(u.toString());
    out.priceStatus = r1.status;
    out.priceRaw = await r1.text();
    if (r1.ok) {
      const j1 = JSON.parse(out.priceRaw);
      const v1 = Number(j1?.data?.price ?? j1?.price);
      if (Number.isFinite(v1)) {
        out.ok = true;
        out.price = v1;
        return out;
      }
    }
  } catch (e) {
    out.error = `price endpoint err: ${String(e.message || e)}`;
  }

  // 2) 24hr (배열 또는 data 배열)
  try {
    const r2 = await fetch(BX_24HR);
    out.hr24Status = r2.status;
    out.hr24Raw = await r2.text();
    if (r2.ok) {
      const j2 = JSON.parse(out.hr24Raw);
      const arr = Array.isArray(j2) ? j2 : Array.isArray(j2?.data) ? j2.data : [];
      const hit = arr.find(x => (x?.symbol || "").toUpperCase() === (out.symbol || "").toUpperCase());
      if (hit) {
        const v2 = Number(hit?.lastPrice ?? hit?.close ?? hit?.price);
        if (Number.isFinite(v2)) {
          out.ok = true;
          out.price = v2;
          return out;
        }
      }
    }
  } catch (e) {
    out.error = `${out.error ? out.error + " | " : ""}24hr endpoint err: ${String(e.message || e)}`;
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

    const [hl, bx] = await Promise.all([fetchHL(debug), fetchBingxSpot(debug)]);
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
        symbol: bx.symbol,
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
        bx24hrRaw: bx.hr24Raw,
        bxSymbolsRaw: bx.symbolsRaw
      } : {})
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
};