const HL = "https://api.hyperliquid.xyz/info";

function normAddr(a) {
  if (!a) return "";
  return String(a).trim().toLowerCase();
}

async function hl(body) {
  const r = await fetch(HL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`HL ${body.type} ${r.status}: ${txt}`);
  try { return JSON.parse(txt); } catch { return txt; }
}

function pickPositionsFromClearinghouseState(res) {
  // 기대 형태: { assetPositions: [{ coin, szi, entryPx, ... }], crossMarginSummary: {...} }
  const arr = res && res.assetPositions;
  if (!Array.isArray(arr)) return [];
  return arr.filter(p => Number(p?.szi) !== 0);
}

function pickPositionsFromTraderRisk(res) {
  // 기대 형태: { positions: [{ coin, szi, entryPx, liqPx? }], ... }
  const arr = res && res.positions;
  if (!Array.isArray(arr)) return [];
  return arr.filter(p => Number(p?.szi) !== 0);
}

function pickPositionsFromUserState(res) {
  // 기대 형태: { userState: { assetPositions: [...] } } 또는 유사
  const st = res && (res.userState || res.state || res.data);
  const arr = st && (st.assetPositions || st.positions);
  if (!Array.isArray(arr)) return [];
  return arr.filter(p => Number(p?.szi) !== 0);
}

function mapPos(p) {
  const coin = p.coin || p.asset || p.name || p.sym || "?";
  const size = Number(p.szi ?? p.sz ?? 0);
  const entry = Number(p.entryPx ?? p.entry ?? p.netEntry ?? 0);
  const liq   = p.liqPx !== undefined ? Number(p.liqPx) : null;
  return { coin, size, entryPx: entry || null, liqPx: Number.isFinite(liq) ? liq : null, raw: p };
}

module.exports = async (req, res) => {
  try {
    const addr = normAddr(req.query.addr || req.query.address);
    const sub  = req.query.sub ? Number(req.query.sub) : undefined; // 선택
    const debug = req.query.debug === "1" || req.query.debug === "true";

    if (!addr || !addr.startsWith("0x") || addr.length !== 42) {
      return res.status(400).json({ ok: false, error: "addr query required (0x...)" });
    }

    // 1) clearinghouseState
    const tries = [];
    tries.push({ type: "clearinghouseState", user: addr, ...(Number.isFinite(sub) ? { subAccount: sub } : {}) });
    // 2) traderRisk
    tries.push({ type: "traderRisk", user: addr, ...(Number.isFinite(sub) ? { subAccount: sub } : {}) });
    // 3) userState (혹은 비슷한 래핑)
    tries.push({ type: "userState", user: addr, ...(Number.isFinite(sub) ? { subAccount: sub } : {}) });

    let positions = [];
    const raws = [];

    for (const q of tries) {
      const out = await hl(q);
      raws.push({ query: q, out });
      let picked = [];
      if (q.type === "clearinghouseState") picked = pickPositionsFromClearinghouseState(out);
      else if (q.type === "traderRisk")   picked = pickPositionsFromTraderRisk(out);
      else                                picked = pickPositionsFromUserState(out);

      if (picked.length) {
        positions = picked.map(mapPos);
        break;
      }
    }

    const ok = positions.length > 0;
    return res.status(200).json({
      ok: true,
      address: addr,
      subAccount: Number.isFinite(sub) ? sub : null,
      positions,
      note: ok ? undefined : "no positions found via 3 schema attempts",
      ...(debug ? { debug: { rawTries: raws.slice(0, 2), lastTry: raws.at(-1) } } : {})
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
};