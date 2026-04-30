import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";

/* ══════════════════════════════════════════════════════
   IPFS GATEWAY ROTATION
   Tries gateways in order on error. w3s.link and
   nftstorage.link are fastest for NFT content.
══════════════════════════════════════════════════════ */
// Alchemy NFT API — thumbnailUrl works for both images AND videos (first frame).
// Uses a React component with local state to avoid ref/re-render issues.
const ALCHEMY_KEY = "l40Adj6lx9enV3reVqZMr";
const _alchemyCache = {};

// Global NFT metadata reactive store
const _nftMeta = {};
const _nftMetaListeners = new Set();
function _emitNFTMeta(id) { _nftMetaListeners.forEach(cb => cb(id)); }
function useNFTMeta(cardId) {
  const [meta, setMeta] = React.useState(() => (cardId ? _nftMeta[cardId] || null : null));
  React.useEffect(() => {
    if (!cardId) return;
    // Read immediately (pre-fetch may have already populated cache)
    setMeta(_nftMeta[cardId] || null);
    const cb = id => { if (id === cardId) setMeta(_nftMeta[cardId] || null); };
    _nftMetaListeners.add(cb);
    return () => _nftMetaListeners.delete(cb);
  }, [cardId]);
  return meta;
}

const _alchemyPromises = {}; // deduplication: multiple callers share one fetch

// ── Sale price → rarity upgrade ──────────────────────────────────────────
// Fetches historical sale data from Alchemy. Updates rarity if sold above thresholds.
// LR ≥ 1 ETH, UR ≥ 0.1 ETH, R ≥ 0.01 ETH. Runs silently in background.
const _saleFetched = new Set();
async function fetchSaleRarity(card, onRarityUpdate, onSaleLog) {
  if (!card.collection || !card.token_id) return;
  const key = `sale_${card.collection}_${card.token_id}`;
  if (_saleFetched.has(key)) return;
  _saleFetched.add(key);
  try {
    const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}/getNFTSales` +
      `?contractAddress=${card.collection}&tokenId=${card.token_id}&order=desc&limit=5`;
    const r = await fetch(url);
    if (!r.ok) return;
    const data = await r.json();
    const sales = data?.nftSales || [];
    if (!sales.length) return;
    // Find highest sale in ETH (sellerFee is in wei)
    // Alchemy returns sellerFee in wei, or taker/maker price in various formats
    const maxWei = Math.max(...sales.map(s => {
      const raw = s.sellerFee?.amount || s.taker?.price || s.maker?.price ||
                  s.sellerFee?.amount || 0;
      return parseInt(raw) || 0;
    }));
    const maxEth = maxWei / 1e18;
    console.log("Sale found:", maxEth.toFixed(4), "ETH for", card.collection, card.token_id);
    if (onSaleLog) onSaleLog(card.name, maxEth);
    const newRarity =
      maxEth >= 10  ? "LR" :
      maxEth >= 2   ? "UR" :
      maxEth >= 0.5 ? "R"  : null;
    // Note: C = 0–0.49 ETH (no upgrade needed, it's the default)
    if (newRarity && RARITY_ORDER.indexOf(newRarity) < RARITY_ORDER.indexOf(card.rarity)) {
      onRarityUpdate(card.id, newRarity, maxEth);
    }
  } catch {}
}

async function getAlchemyThumb(collection, tokenId) {
  const key = `${collection}_${tokenId}`;
  if (_alchemyCache[key] !== undefined) return _alchemyCache[key];
  if (_alchemyPromises[key]) return _alchemyPromises[key]; // share in-flight fetch
  _alchemyPromises[key] = (async () => {
  try {
    const r = await fetch(
      `https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}/getNFTMetadata` +
      `?contractAddress=${collection}&tokenId=${tokenId}&refreshCache=false`
    );
    if (!r.ok) return null;
    const data = await r.json();
    // thumbnailUrl works for images AND videos (extracts first frame)
    const url = data?.image?.thumbnailUrl || data?.image?.cachedUrl || data?.image?.originalUrl;
    _alchemyCache[key] = url || null;
    // Store real name and collection for card display
    if (data?.name || data?.contract?.name) {
      _nftMeta[key] = {
        name: data?.name || null,
        collection: data?.contract?.name || null,
        symbol: data?.contract?.symbol || null,
      };
      _emitNFTMeta(key);
    }
    if (_alchemyCache[key]) {
      // Warm browser cache immediately
      const img = new Image(); img.src = _alchemyCache[key];
    }
    return _alchemyCache[key];
  } catch { _alchemyCache[key] = null; return null; }
  })();
  return _alchemyPromises[key];
}

const LOADING_PHRASES = ["loading..."];

function CardImage({ card, style }) {
  const [src, setSrc] = React.useState(() => {
    if (!card.image_cid || !card.collection || !card.token_id) return null;
    const key = `${card.collection}_${card.token_id}`;
    return _alchemyCache[key] || null;
  });
  const [imgReady, setImgReady] = React.useState(false);
  const [errStep, setErrStep] = React.useState(0);

  React.useEffect(() => {
    if (!card.image_cid) return;
    let cancelled = false;
    setImgReady(false);
    const tryAlchemy = (attempt) =>
      getAlchemyThumb(card.collection, card.token_id).then(url => {
        if (cancelled) return;
        if (url) { setSrc(url); return; }
        if (attempt < 2) setTimeout(() => { if (!cancelled) tryAlchemy(attempt+1); }, 3000);
        else if (card.image_cid) setSrc(`https://w3s.link/ipfs/${card.image_cid}/nft.png`);
      }).catch(() => { if (!cancelled && card.image_cid) setSrc(`https://w3s.link/ipfs/${card.image_cid}/nft.png`); });
    tryAlchemy(1);
    return () => { cancelled = true; };
  }, [card.id]);

  const fallbacks = card.image_cid ? [
    `https://w3s.link/ipfs/${card.image_cid}`,
    `https://nftstorage.link/ipfs/${card.image_cid}/nft.png`,
    `https://nftstorage.link/ipfs/${card.image_cid}`,
  ] : [];

  // Use a single img — show placeholder via background when not ready
  return (
    <div style={{...style, background: imgReady ? "transparent" : "#0a0a0a",
      display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden",
      position:"relative"}}>
      {!imgReady && (
        <div style={{position:"absolute",fontFamily:"'DM Mono',monospace",fontSize:7,
          color:"#1e1e1e",letterSpacing:1.5,animation:"pulse 1.8s ease-in-out infinite",
          pointerEvents:"none"}}>
          loading...
        </div>
      )}
      {src && (
        <img
          src={src} alt=""
          onLoad={() => setImgReady(true)}
          onError={() => {
            setImgReady(false);
            const next = fallbacks[errStep];
            if (next) { setErrStep(s=>s+1); setSrc(next); }
            else setSrc(null);
          }}
          style={{width:"100%", height:"100%", objectFit:"cover",
            objectPosition: style?.objectPosition || "center 15%",
            display:"block", opacity: imgReady ? 1 : 0}}
        />
      )}
    </div>
  );
}


export default function TheCabal() {
  return <TheCabalApp/>;
}
