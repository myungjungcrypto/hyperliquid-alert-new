/**
 * GET /api/liq?address=0x...  (또는 hyper 주소)
 * 반환: { ok, address, positions: [{symbol, side, entryPx, size, notional, lev, mmr, estLiqPx}] }
 */

const HL_INFO = "https://api.hyperliquid.xyz/info";

// 유지증거금(MMR) 기본값 (자산별 tier를 못 가져오면 이 값으로 근사)
const DEFAULT_MMR = 0.005; // 0.5%

async function fetchMetaAndCtxs() {
  const r = await fetch(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    // vercel edge/runtime 환경에서 100s 제한 고려
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`HL meta HTTP ${r.status}: ${raw}`);
  const [meta, ctxs] = JSON.parse(raw);
  return { meta, ctxs };
}

/**
 * Hyperliquid 유저 상태 조회
 * NOTE: 엔드포인트 스펙은 HL 측 변동 가능. 두 가지 타입을 시도하고 둘 다 실패하면 에러.
 */
async function fetchUserState(address) {
  // 1) clearinghouseState 시도
  let body = JSON.stringify({ type: "clearinghouseState", user: address });
  let r = await fetch(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  let raw = await r.text();
  if (r.ok) {
    try { return JSON.parse(raw); } catch {}
  }

  // 2) userState 시도
  body = JSON.stringify({ type: "userState", user: address });
  r = await fetch(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  raw = await r.text();
  if (!r.ok) throw new Error(`HL user HTTP ${r.status}: ${raw}`);
  return JSON.parse(raw);
}

/**
 * 유지증거금 비율(MMR) 조회.
 * meta.marginTables 를 보고 해당 종목의 marginTableId 로 tier 정보를 찾아 1단계 tier MMR을 근사 MMR로 사용.
 * (정밀 계산은 포지션 규모별 tier를 적용해야 하지만, 우선 근사치로 1단계 사용)
 */
function getApproxMMR(meta, symbol) {
  const uni = (meta?.universe ?? []);
  const i = uni.findIndex(u => (u?.name || "").toUpperCase() === symbol.toUpperCase());
  if (i < 0) return DEFAULT_MMR;

  const mId = uni[i]?.marginTableId;
  const tables = meta?.marginTables ?? [];
  const hit = tables.find(([id]) => Number(id) === Number(mId));
  if (!hit) return DEFAULT_MMR;

  // marginTiers: [{ lowerBound, maxLeverage }]
  const tiers = hit[1]?.marginTiers || [];
  if (!tiers.length) return DEFAULT_MMR;

  // 간단 근사: 첫 tier 의 maxLeverage -> 초기증거금률(IM)=1/leverage, 유지증거금률은 대략 IM의 10~20% 수준인 곳도 있으나
  // Hyperliquid marginTable은 "maxLeverage만" 보이므로, 보수적으로 0.5%~1% 중간값을 사용.
  // 원한다면 종목별 커스텀 MMR 맵핑을 추가해 정교화 가능.
  return DEFAULT_MMR;
}

/**
 * 청산가 근사 계산
 * 롱:  Liq ≈ Entry * (1 - IM + MMR)
 * 숏:  Liq ≈ Entry * (1 + IM - MMR)
 * IM = 1 / lev
 */
function estLiqPrice(entry, lev, mmr, side /* "long" | "short" */) {
  const im = lev > 0 ? (1 / lev) : 1;
  if (!Number.isFinite(entry) || entry <= 0) return null;

  if (side === "long") {
    return entry * (1 - im + mmr);
  } else {
    return entry * (1 + im - mmr);
  }
}

/**
 * 다양한 userState 형태를 포지션 리스트로 정규화
 * 기대 반환 포맷: [{ symbol, side, entryPx, size, notional }]
 */
function normalizePositions(userState) {
  // 케이스별로 최대한 유연하게 파싱
  // 흔히 positions / assetPositions / perpPositions 등의 키를 가정
  const out = [];

  const candidates = [
    userState?.assetPositions,
    userState?.perpPositions,
    userState?.positions,
    userState?.openPositions,
    userState?.user?.assetPositions,
    userState?.user?.perpPositions,
    userState?.user?.positions,
  ].filter(Boolean);

  const arr = candidates.find(a => Array.isArray(a)) || [];

  for (const p of arr) {
    const symbol =
      p?.asset ?? p?.symbol ?? p?.name ?? p?.coin ?? p?.token ?? null;

    // 방향/사이즈
    let size = Number(p?.position?.szi ?? p?.size ?? p?.qty ?? p?.amount ?? 0);
    if (!Number.isFinite(size)) size = 0;
    let side = size >= 0 ? "long" : "short";
    const absSize = Math.abs(size);

    // 진입가
    const entryPx =
      Number(p?.position?.entryPx ?? p?.entryPx ?? p?.entryPrice ?? p?.avgEntry ?? p?.avgPrice ?? NaN);
    // 명목가
    const notional =
      Number(p?.position?.notional ?? p?.notional ?? (Number.isFinite(entryPx) ? absSize * entryPx : NaN));

    // 레버리지(근사): notional / collateral
    // userState 에 collateral/margin 이 별도로 있을 수 있음
    let collateral =
      Number(userState?.crossMargin ?? userState?.collateral ?? userState?.margin ?? userState?.equity ?? NaN);
    // 포지션별 isolated margin이 있으면 우선
    collateral = Number(p?.position?.margin ?? p?.margin ?? collateral);

    let lev = Number.isFinite(notional) && Number.isFinite(collateral) && collateral > 0
      ? notional / collateral
      : NaN;

    // 포지션별로 레버리지 노출이 있을 때 우선 사용
    if (Number.isFinite(p?.leverage)) lev = Number(p.leverage);
    if (!symbol || !Number.isFinite(entryPx) || !Number.isFinite(notional)) {
      continue;
    }

    out.push({ symbol, side, entryPx: Number(entryPx), size: absSize, notional: Number(notional), lev: lev });
  }

  return out;
}

export default async function handler(req, res) {
  try {
    const address = (req.query.address || "").trim();
    if (!address) {
      return res.status(400).json({ ok: false, error: "missing address, use /api/liq?address=<wallet>" });
    }

    // 메타/마진테이블
    const { meta } = await fetchMetaAndCtxs();
    // 유저 상태
    const user = await fetchUserState(address);

    const pos = normalizePositions(user);
    if (!pos.length) {
      return res.status(200).json({ ok: true, address, positions: [], note: "no open positions or unrecognized schema" });
    }

    const enriched = pos.map(p => {
      const mmr = getApproxMMR(meta, p.symbol);
      const lev = Number.isFinite(p.lev) && p.lev > 0 ? p.lev : (p.notional > 0 ? Math.max(1, p.notional / Math.max(1e-9, p.notional * 0.1)) : 1);
      const est = estLiqPrice(p.entryPx, lev, mmr, p.side);
      return {
        symbol: p.symbol,
        side: p.side,
        entryPx: p.entryPx,
        size: p.size,
        notional: p.notional,
        lev: Number.isFinite(lev) ? Number(lev.toFixed(2)) : null,
        mmr,
        estLiqPx: est ? Number(est.toFixed(6)) : null
      };
    });

    res.status(200).json({ ok: true, address, positions: enriched });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}