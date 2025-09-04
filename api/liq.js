// api/liq.js
const HL_INFO = "https://api.hyperliquid.xyz/info";

// 간단한 주소 검증
function isHexAddress(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

// HL에서 계좌 상태 가져오기 (clearinghouseState)
async function fetchClearinghouseState(address) {
  const query = { type: "clearinghouseState", user: address };
  const r = await fetch(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query)
  });
  const rawText = await r.text();
  if (!r.ok) {
    throw new Error(`HL HTTP ${r.status}: ${rawText}`);
  }
  let out;
  try {
    out = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`HL JSON parse error: ${e?.message || e}`);
  }
  return { query, out, rawText };
}

// 하이퍼리퀴드 포지션 맵핑
function mapPos(p) {
  // 응답이 { type: "oneWay", position: {...} } 인 경우 언랩
  const base = p && p.position ? p.position : p;

  const coin = base?.coin || base?.asset || base?.name || base?.sym || "?";
  const size = Number(base?.szi ?? base?.sz ?? 0);
  const entry = Number(base?.entryPx ?? base?.entry ?? base?.netEntry ?? NaN);

  // liquidationPx / liqPx 키 대응
  let liq = null;
  if (base && base.liquidationPx !== undefined) {
    liq = Number(base.liquidationPx);
  } else if (base && base.liqPx !== undefined) {
    liq = Number(base.liqPx);
  }

  return {
    coin,
    size,                                   // 부호 포함 (롱/숏)
    entryPx: Number.isFinite(entry) ? entry : null,
    liqPx: Number.isFinite(liq) ? liq : null,
    raw: p
  };
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const address = (q.addr || q.address || "").toString().trim();
    const debug = q.debug === "1" || q.debug === "true";

    if (!isHexAddress(address)) {
      return res.status(400).json({ ok: false, error: "invalid address" });
    }

    const rawTries = [];
    const first = await fetchClearinghouseState(address);
    rawTries.push(first);

    const ch = first.out;
    const positionsRaw = Array.isArray(ch?.assetPositions) ? ch.assetPositions : [];
    const positions = positionsRaw.map(mapPos).filter(p => p && p.coin !== "?");

    if (!positions.length) {
      return res.status(200).json({
        ok: true,
        address,
        subAccount: null,
        positions: [],
        note: "no open positions or unrecognized schema",
        ...(debug ? { debug: { rawTries, lastTry: first } } : {})
      });
    }

    res.status(200).json({
      ok: true,
      address,
      subAccount: null,
      positions,
      ...(debug ? { debug: { rawTries, lastTry: first } } : {})
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
};