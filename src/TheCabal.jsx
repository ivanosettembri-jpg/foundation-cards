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
  const [errStep, setErrStep] = React.useState(0);

  React.useEffect(() => {
    if (!card.image_cid) return;
    let cancelled = false;
    const tryAlchemy = (attempt) =>
      getAlchemyThumb(card.collection, card.token_id).then(url => {
        if (cancelled) return;
        if (url) { setSrc(url); return; }
        if (attempt < 2) setTimeout(() => { if (!cancelled) tryAlchemy(attempt+1); }, 3000);
        else { /* no Alchemy image, skip IPFS to avoid cert errors */ }
      }).catch(() => { /* Alchemy fetch failed */ });
    tryAlchemy(1);
    return () => { cancelled = true; };
  }, [card.id]);

  const fallbacks = card.image_cid ? [
    `https://w3s.link/ipfs/${card.image_cid}`,
    `https://nftstorage.link/ipfs/${card.image_cid}/nft.png`,
    `https://nftstorage.link/ipfs/${card.image_cid}`,
  ] : [];

  if (!src) return null;
  return (
    <img src={src} alt=""
      onError={() => {
        const next = fallbacks[errStep];
        if (next) { setErrStep(s=>s+1); setSrc(next); }
        else setSrc(null);
      }}
      style={style}
    />
  );
}


// Keep for backward compat (download function etc)
function ipfsUrl(cid) {
  return cid ? `https://w3s.link/ipfs/${cid}/nft.png` : null;
}
function ipfsOnError(e, cid) {}


/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║                    THE CABAL  —  EDITOR'S GUIDE                         ║
   ╠══════════════════════════════════════════════════════════════════════════╣
   ║                                                                          ║
   ║  ① LOGO                                                                  ║
   ║    LOGO_B64 — replace the base64 string with a new SVG or PNG.          ║
   ║                                                                          ║
   ║  ② PROFILE PICTURES (PFP_DATA)                                           ║
   ║    All pfps are embedded as base64 data URIs in PFP_DATA (below logo).   ║
   ║    Key = Twitter handle in lowercase, without @.                         ║
   ║    To update a pfp: replace the value for that key.                      ║
   ║    To add a new pfp: add a new key/value pair.                           ║
   ║    Convert an image: python3 -c "import base64; print('data:image/jpeg;base64,' + base64.b64encode(open('file.jpg','rb').read()).decode())" ║
   ║                                                                          ║
   ║  ③ PACK VISUALS                                                          ║
   ║    PACK_PITY_IMAGES — array of base64 images for lucky pack rotation.     ║
   ║    To add a custom pack art from a friend:                               ║
   ║      1. Convert image to base64 (see ② above)                            ║
   ║      2. Add to PACK_PITY_IMAGES array (lucky pack)                                    ║
   ║    The pack will randomly cycle through all images in the array.         ║
   ║    PACK_STANDARD_IMAGE — single image for standard packs (or null).      ║
   ║                                                                          ║
   ║  ④ ACCOUNTS (ACCOUNTS array)                                             ║
   ║    Each entry: { id, handle, name, rarity, cat, bio }                   ║
   ║    Rarity: "LR" | "UR" | "R" | "C"                                      ║
   ║    Bio: edit freely — change any bio that doesn't feel right.            ║
   ║    Serial numbers are auto-assigned in rarity order (LR→UR→R→C).        ║
   ║    To reorder serials within a rarity, reorder entries in that group.    ║
   ║                                                                          ║
   ║  ⑤ GAME CONFIG (below styles)                                            ║
   ║    MAX_PACKS, PACK_REGEN, CARDS_PER, LUCKY_EVERY                   ║
   ║                                                                          ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */

/* Logo SVG embedded as base64 — no external file needed */
/* Pack layout SVGs and lucky pack background — embedded for offline use */
const STANDARD_PACK_SVG_B64 = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyOTYuNjggNDMzLjY5Ij48ZGVmcz48c3R5bGU+LmNscy0xLC5jbHMtMntmaWxsOiNmZmY7fS5jbHMtMntmb250LXNpemU6MTJweDtmb250LWZhbWlseTpETU1vbm8tUmVndWxhciwgRE0gTW9ubzt9LmNscy0ze2ZpbGw6bm9uZTtzdHJva2U6IzAwMDtzdHJva2UtbWl0ZXJsaW1pdDoxMDtzdHJva2Utd2lkdGg6MnB4O29wYWNpdHk6MDt9PC9zdHlsZT48L2RlZnM+PGcgaWQ9IkxpdmVsbG9fMiIgZGF0YS1uYW1lPSJMaXZlbGxvIDIiPjxnIGlkPSJMaXZlbGxvXzEtMiIgZGF0YS1uYW1lPSJMaXZlbGxvIDEiPjxwb2x5Z29uIGNsYXNzPSJjbHMtMSIgcG9pbnRzPSI0Mi45IDIwMy4yMSA1MC42MSAyMDMuMjEgNTAuNjEgMjI4Ljc5IDU2LjA1IDIyOC43OSA1Ni4wNSAyMDMuMjEgNjMuNzYgMjAzLjIxIDYzLjc2IDE5OC4wOSA0Mi45IDE5OC4wOSA0Mi45IDIwMy4yMSIvPjxwb2x5Z29uIGNsYXNzPSJjbHMtMSIgcG9pbnRzPSI4My45IDIxMC40OCA3MiAyMTAuNDggNzIgMTk4LjA5IDY2LjU2IDE5OC4wOSA2Ni41NiAyMjguNzkgNzIgMjI4Ljc5IDcyIDIxNS41OSA4My45IDIxNS41OSA4My45IDIyOC43OSA4OS4zNCAyMjguNzkgODkuMzQgMTk4LjA5IDgzLjkgMTk4LjA5IDgzLjkgMjEwLjQ4Ii8+PHBvbHlnb24gY2xhc3M9ImNscy0xIiBwb2ludHM9IjkyLjc2IDIyOC43OSAxMTIuNjcgMjI4Ljc5IDExMi42NyAyMjMuNjggOTguMiAyMjMuNjggOTguMiAyMTUuODggMTExLjQ0IDIxNS44OCAxMTEuNDQgMjEwLjc2IDk4LjIgMjEwLjc2IDk4LjIgMjAzLjIxIDExMi42NyAyMDMuMjEgMTEyLjY3IDE5OC4wOSA5Mi43NiAxOTguMDkgOTIuNzYgMjI4Ljc5Ii8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTU3LjQzLDIxOS4zYTYsNiwwLDAsMS0xLjcxLDMuNDgsNS4wOSw1LjA5LDAsMCwxLTMuODIsMS4yNyw1LjQxLDUuNDEsMCwwLDEtNC43OC0yLjYzYy0xLjI1LTEuODgtMS44OC00LjU2LTEuODgtOHMuNjMtNi4wNywxLjg4LTcuOTVhNS40NSw1LjQ1LDAsMCwxLDQuNzgtMi42Myw1LDUsMCwwLDEsMy43MiwxLjM1LDYuMiw2LjIsMCwwLDEsMS43OCwzLjUybC4xNC44M2g1Ljc3bC0uMTItMS4xMWExMC44NywxMC44NywwLDAsMC0zLjQ4LTcuMTMsMTEuMzEsMTEuMzEsMCwwLDAtNy44MS0yLjcsMTEsMTEsMCwwLDAtNi41OSwyLDEyLjY0LDEyLjY0LDAsMCwwLTQuMTksNS42MiwyNC41MiwyNC41MiwwLDAsMCwwLDE2LjM5LDEyLjUzLDEyLjUzLDAsMCwwLDQuMTksNS42LDEyLjI4LDEyLjI4LDAsMCwwLDE0LjMtLjYyLDExLjU5LDExLjU5LDAsMCwwLDMuNTctN2wuMTktMS4xNmgtNS44M1oiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0yMTAuNTUsMjEyLjg2YTkuMDUsOS4wNSwwLDAsMCwxLjg0LTEuNzEsNy4xOSw3LjE5LDAsMCwwLDEuNTktNC43Niw3Ljc5LDcuNzksMCwwLDAtMi41OC02Yy0xLjY5LTEuNTMtNC4xOC0yLjMxLTcuNC0yLjMxSDE5My40NXYzMC43aDEwLjg4YTExLjg5LDExLjg5LDAsMCwwLDUuNTctMS4xOCw4Ljc1LDguNzUsMCwwLDAsMy41NS0zLjIyLDguNTQsOC41NCwwLDAsMCwxLjIzLTQuNTIsNy40MSw3LjQxLDAsMCwwLTEuNzgtNS4wN0E5LjczLDkuNzMsMCwwLDAsMjEwLjU1LDIxMi44NlptLTExLjY1LTIuMzl2LTcuMjZoNC43NGE1Ljg4LDUuODgsMCwwLDEsMy43MSwxLDMuMTMsMy4xMywwLDAsMSwxLjA3LDIuNTksMy4zMywzLjMzLDAsMCwxLTEuMDksMi43NCw1LjQ4LDUuNDgsMCwwLDEtMy41NywxWm0xMC4yMSw5LjEzYTMuNjQsMy42NCwwLDAsMS0xLjI0LDMsNiw2LDAsMCwxLTMuOTEsMS4xSDE5OC45di04LjIzaDVhNi4yNSw2LjI1LDAsMCwxLDMuOTEsMS4xM0EzLjU0LDMuNTQsMCwwLDEsMjA5LjExLDIxOS42WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTIyNS45LDE5OC4wOWwtOS42MSwzMC43aDUuODhsMi4wOS03LjEzaDguNjdsMi4xLDcuMTNoNS44N2wtOS41Mi0zMC43Wm01LjU4LDE4LjdoLTUuNzZsMi44OC05LjY0WiIvPjxwb2x5Z29uIGNsYXNzPSJjbHMtMSIgcG9pbnRzPSIyNDguOTUgMjIzLjY4IDI0OC45NSAxOTguMDkgMjQzLjUxIDE5OC4wOSAyNDMuNTEgMjI4Ljc5IDI2My41IDIyOC43OSAyNjMuNSAyMjMuNjggMjQ4Ljk1IDIyMy42OCIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE4Mi4xLDIxNGwzLjQxLDMuNDYtNy43Ny0xOS4zOC04LDE5Ljg5LDMuNTctMy44MUMxNzYsMjExLjM2LDE3OS40MywyMTEuMywxODIuMSwyMTRaIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTgyLjY1LDIyMS4yN2MtMi44OSwzLjYtNywzLjY4LTkuOTIuMjFsLTMtMy40OC0uNDksMS4yMi0zLjg0LDkuNTdIMTkwbC00LjQ1LTExLjE5WiIvPjxwb2x5Z29uIGNsYXNzPSJjbHMtMSIgcG9pbnRzPSIxNjkuNzYgMjE3Ljk5IDE2OS43NiAyMTggMTY5Ljc3IDIxNy45OSAxNjkuNzYgMjE3Ljk5Ii8+PHBvbHlnb24gY2xhc3M9ImNscy0xIiBwb2ludHM9IjE4NS42MiAyMTcuNTggMTg1LjUxIDIxNy40NyAxODUuNTcgMjE3LjYzIDE4NS42MiAyMTcuNTgiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xNzguMzQsMjIxLjUxYTMuNTUsMy41NSwwLDEsMC00LjEzLTIuODV2MGEzLjUzLDMuNTMsMCwwLDAsNC4xMywyLjgzWm0tMi02LjE5YS45Mi45MiwwLDEsMS0uOTIuOTJoMGEuOTIuOTIsMCwwLDEsLjktLjkyWiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE3NS44LDkyLjFjLTE2LjQ4LTE2Ljc0LTM3Ljg0LTE2LjM2LTU0LjI2LDFsLTIyLDIzLjUzTDExOCwxMzguMjFjMTgsMjEuNDMsNDMuNCwyMC45Myw2MS4yNC0xLjI5bDE4LTIyLjYtLjMyLS44NlptLTIzLjIxLDQ2LjNoMGEyMS44NiwyMS44NiwwLDAsMS0yNS41LTE3LjQ3bDAtLjEyYTIxLjkyLDIxLjkyLDAsMSwxLDI1LjUyLDE3LjU5WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE0MC4yNCwxMDAuMThoLS4xMmE1Ljc0LDUuNzQsMCwxLDAsLjEyLDBaIi8+PHRleHQgY2xhc3M9ImNscy0yIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMDEuNTQgMjYxLjEzKSI+c3RhbmRhcmQgcGFjayA8dHNwYW4geD0iMTgiIHk9IjE4Ij54NSBjYXJkczwvdHNwYW4+PC90ZXh0Pjx0ZXh0IGNsYXNzPSJjbHMtMiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTEyLjM0IDM3OC41NCkiPnNlYXNvbiBvbmU8L3RleHQ+PGNpcmNsZSBjbGFzcz0iY2xzLTEiIGN4PSIxNDguNjMiIGN5PSIzNDYuODgiIHI9IjIuOTEiLz48Y2lyY2xlIGNsYXNzPSJjbHMtMSIgY3g9IjE4MC42NCIgY3k9IjM0Ni44OCIgcj0iMi45MSIvPjxjaXJjbGUgY2xhc3M9ImNscy0xIiBjeD0iMTY0LjYzIiBjeT0iMzQ2Ljg4IiByPSIyLjkxIi8+PGNpcmNsZSBjbGFzcz0iY2xzLTEiIGN4PSIxMzIuMjkiIGN5PSIzNDYuODgiIHI9IjIuOTEiLz48Y2lyY2xlIGNsYXNzPSJjbHMtMSIgY3g9IjExNi4yOCIgY3k9IjM0Ni44OCIgcj0iMi45MSIvPjxyZWN0IGNsYXNzPSJjbHMtMyIgeD0iMSIgeT0iMSIgd2lkdGg9IjI5NC42OCIgaGVpZ2h0PSI0MzEuNjkiLz48L2c+PC9nPjwvc3ZnPg==";
const LUCKY_PACK_SVG_B64    = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyOTYuNjggNDMzLjY5Ij48ZGVmcz48c3R5bGU+LmNscy0xe2ZvbnQtc2l6ZToxMnB4O2ZvbnQtZmFtaWx5OkRNTW9uby1SZWd1bGFyLCBETSBNb25vO30uY2xzLTEsLmNscy0ye2ZpbGw6I2ZmZjt9LmNscy0ze2ZpbGw6bm9uZTtzdHJva2U6IzAwMDtzdHJva2UtbWl0ZXJsaW1pdDoxMDtzdHJva2Utd2lkdGg6MnB4O29wYWNpdHk6MDt9PC9zdHlsZT48L2RlZnM+PGcgaWQ9IkxpdmVsbG9fMiIgZGF0YS1uYW1lPSJMaXZlbGxvIDIiPjxnIGlkPSJMaXZlbGxvXzEtMiIgZGF0YS1uYW1lPSJMaXZlbGxvIDEiPjx0ZXh0IGNsYXNzPSJjbHMtMSIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTEyLjYzIDM3OC41NCkiPnNlYXNvbiBvbmU8L3RleHQ+PGNpcmNsZSBjbGFzcz0iY2xzLTIiIGN4PSIxNDguOTEiIGN5PSIzNDYuODgiIHI9IjIuOTEiLz48Y2lyY2xlIGNsYXNzPSJjbHMtMiIgY3g9IjE4MC45MyIgY3k9IjM0Ni44OCIgcj0iMi45MSIvPjxjaXJjbGUgY2xhc3M9ImNscy0yIiBjeD0iMTY0LjkyIiBjeT0iMzQ2Ljg4IiByPSIyLjkxIi8+PGNpcmNsZSBjbGFzcz0iY2xzLTIiIGN4PSIxMzIuNTgiIGN5PSIzNDYuODgiIHI9IjIuOTEiLz48Y2lyY2xlIGNsYXNzPSJjbHMtMiIgY3g9IjExNi41NyIgY3k9IjM0Ni44OCIgcj0iMi45MSIvPjxwb2x5Z29uIGNsYXNzPSJjbHMtMiIgcG9pbnRzPSI0Mi45IDIwMy4yMSA1MC42MSAyMDMuMjEgNTAuNjEgMjI4Ljc5IDU2LjA1IDIyOC43OSA1Ni4wNSAyMDMuMjEgNjMuNzYgMjAzLjIxIDYzLjc2IDE5OC4wOSA0Mi45IDE5OC4wOSA0Mi45IDIwMy4yMSIvPjxwb2x5Z29uIGNsYXNzPSJjbHMtMiIgcG9pbnRzPSI4My45IDIxMC40OCA3MiAyMTAuNDggNzIgMTk4LjA5IDY2LjU2IDE5OC4wOSA2Ni41NiAyMjguNzkgNzIgMjI4Ljc5IDcyIDIxNS41OSA4My45IDIxNS41OSA4My45IDIyOC43OSA4OS4zNCAyMjguNzkgODkuMzQgMTk4LjA5IDgzLjkgMTk4LjA5IDgzLjkgMjEwLjQ4Ii8+PHBvbHlnb24gY2xhc3M9ImNscy0yIiBwb2ludHM9IjkyLjc2IDIyOC43OSAxMTIuNjcgMjI4Ljc5IDExMi42NyAyMjMuNjggOTguMiAyMjMuNjggOTguMiAyMTUuODggMTExLjQ0IDIxNS44OCAxMTEuNDQgMjEwLjc2IDk4LjIgMjEwLjc2IDk4LjIgMjAzLjIxIDExMi42NyAyMDMuMjEgMTEyLjY3IDE5OC4wOSA5Mi43NiAxOTguMDkgOTIuNzYgMjI4Ljc5Ii8+PHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMTU3LjQzLDIxOS4zYTYsNiwwLDAsMS0xLjcxLDMuNDgsNS4wOSw1LjA5LDAsMCwxLTMuODIsMS4yNyw1LjQxLDUuNDEsMCwwLDEtNC43OC0yLjYzYy0xLjI1LTEuODgtMS44OC00LjU2LTEuODgtOHMuNjMtNi4wNywxLjg4LTcuOTVhNS40NSw1LjQ1LDAsMCwxLDQuNzgtMi42Myw1LDUsMCwwLDEsMy43MiwxLjM1LDYuMiw2LjIsMCwwLDEsMS43OCwzLjUybC4xNC44M2g1Ljc3bC0uMTItMS4xMWExMC44NywxMC44NywwLDAsMC0zLjQ4LTcuMTMsMTEuMzEsMTEuMzEsMCwwLDAtNy44MS0yLjcsMTEsMTEsMCwwLDAtNi41OSwyLDEyLjY0LDEyLjY0LDAsMCwwLTQuMTksNS42MiwyNC41MiwyNC41MiwwLDAsMCwwLDE2LjM5LDEyLjUzLDEyLjUzLDAsMCwwLDQuMTksNS42LDEyLjI4LDEyLjI4LDAsMCwwLDE0LjMtLjYyLDExLjU5LDExLjU5LDAsMCwwLDMuNTctN2wuMTktMS4xNmgtNS44M1oiLz48cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik0yMTAuNTUsMjEyLjg2YTkuMDUsOS4wNSwwLDAsMCwxLjg0LTEuNzEsNy4xOSw3LjE5LDAsMCwwLDEuNTktNC43Niw3Ljc5LDcuNzksMCwwLDAtMi41OC02Yy0xLjY5LTEuNTMtNC4xOC0yLjMxLTcuNC0yLjMxSDE5My40NXYzMC43aDEwLjg4YTExLjg5LDExLjg5LDAsMCwwLDUuNTctMS4xOCw4Ljc1LDguNzUsMCwwLDAsMy41NS0zLjIyLDguNTQsOC41NCwwLDAsMCwxLjIzLTQuNTIsNy40MSw3LjQxLDAsMCwwLTEuNzgtNS4wN0E5LjczLDkuNzMsMCwwLDAsMjEwLjU1LDIxMi44NlptLTExLjY1LTIuMzl2LTcuMjZoNC43NGE1Ljg4LDUuODgsMCwwLDEsMy43MSwxLDMuMTMsMy4xMywwLDAsMSwxLjA3LDIuNTksMy4zMywzLjMzLDAsMCwxLTEuMDksMi43NCw1LjQ4LDUuNDgsMCwwLDEtMy41NywxWm0xMC4yMSw5LjEzYTMuNjQsMy42NCwwLDAsMS0xLjI0LDMsNiw2LDAsMCwxLTMuOTEsMS4xSDE5OC45di04LjIzaDVhNi4yNSw2LjI1LDAsMCwxLDMuOTEsMS4xM0EzLjU0LDMuNTQsMCwwLDEsMjA5LjExLDIxOS42WiIvPjxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTIyNS45LDE5OC4wOWwtOS42MSwzMC43aDUuODhsMi4wOS03LjEzaDguNjdsMi4xLDcuMTNoNS44N2wtOS41Mi0zMC43Wm01LjU4LDE4LjdoLTUuNzZsMi44OC05LjY0WiIvPjxwb2x5Z29uIGNsYXNzPSJjbHMtMiIgcG9pbnRzPSIyNDguOTUgMjIzLjY4IDI0OC45NSAxOTguMDkgMjQzLjUxIDE5OC4wOSAyNDMuNTEgMjI4Ljc5IDI2My41IDIyOC43OSAyNjMuNSAyMjMuNjggMjQ4Ljk1IDIyMy42OCIvPjxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTE4Mi4xLDIxNGwzLjQxLDMuNDYtNy43Ny0xOS4zOC04LDE5Ljg5LDMuNTctMy44MUMxNzYsMjExLjM2LDE3OS40MywyMTEuMywxODIuMSwyMTRaIi8+PHBhdGggY2xhc3M9ImNscy0yIiBkPSJNMTgyLjY1LDIyMS4yN2MtMi44OSwzLjYtNywzLjY4LTkuOTIuMjFsLTMtMy40OC0uNDksMS4yMi0zLjg0LDkuNTdIMTkwbC00LjQ1LTExLjE5WiIvPjxwb2x5Z29uIGNsYXNzPSJjbHMtMiIgcG9pbnRzPSIxNjkuNzYgMjE3Ljk5IDE2OS43NiAyMTggMTY5Ljc3IDIxNy45OSAxNjkuNzYgMjE3Ljk5Ii8+PHBvbHlnb24gY2xhc3M9ImNscy0yIiBwb2ludHM9IjE4NS42MiAyMTcuNTggMTg1LjUxIDIxNy40NyAxODUuNTcgMjE3LjYzIDE4NS42MiAyMTcuNTgiLz48cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik0xNzguMzQsMjIxLjUxYTMuNTUsMy41NSwwLDEsMC00LjEzLTIuODV2MGEzLjUzLDMuNTMsMCwwLDAsNC4xMywyLjgzWm0tMi02LjE5YS45Mi45MiwwLDEsMS0uOTIuOTJoMGEuOTIuOTIsMCwwLDEsLjktLjkyWiIvPjxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTE3NS44LDkyLjFjLTE2LjQ4LTE2Ljc0LTM3Ljg0LTE2LjM2LTU0LjI2LDFsLTIyLDIzLjUzTDExOCwxMzguMjFjMTgsMjEuNDMsNDMuNCwyMC45Myw2MS4yNC0xLjI5bDE4LTIyLjYtLjMyLS44NlptLTIzLjIxLDQ2LjNoMGEyMS44NiwyMS44NiwwLDAsMS0yNS41LTE3LjQ3bDAtLjEyYTIxLjkyLDIxLjkyLDAsMSwxLDI1LjUyLDE3LjU5WiIvPjxwYXRoIGNsYXNzPSJjbHMtMiIgZD0iTTE0MC4yNCwxMDAuMThoLS4xMmE1Ljc0LDUuNzQsMCwxLDAsLjEyLDBaIi8+PHRleHQgY2xhc3M9ImNscy0xIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMTIuMzQgMjYxLjEzKSI+bHVja3kgcGFjayA8dHNwYW4geD0iLTQzLjIiIHk9IjE4Ij5hcnR3b3JrIGJ5IEBzb3JyaXNvcG5nPC90c3Bhbj48dHNwYW4geD0iNy4yIiB5PSIzNiI+eDUgY2FyZHM8L3RzcGFuPjwvdGV4dD48cmVjdCBjbGFzcz0iY2xzLTMiIHg9IjEiIHk9IjEiIHdpZHRoPSIyOTQuNjgiIGhlaWdodD0iNDMxLjY5Ii8+PC9nPjwvZz48L3N2Zz4=";
const LUCKY_PACK_BG_B64     = "data:image/jpeg;base64,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";
/* Icon-only logo (the eye/lens mark) — used on pack front and card back */
const LOGO_ICON_B64 = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5Ny42OCA3NC4xNCI+PGRlZnM+PHN0eWxlPi5jbHMtMXtmaWxsOiNmZmY7fTwvc3R5bGU+PC9kZWZzPjxnIGlkPSJMaXZlbGxvXzIiIGRhdGEtbmFtZT0iTGl2ZWxsbyAyIj48ZyBpZD0iTGl2ZWxsb18xLTIiIGRhdGEtbmFtZT0iTGl2ZWxsbyAxIj48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik03Ni4zMSwxMi4yOUM1OS44Mi00LjQ0LDM4LjQ2LTQuMDcsMjIsMTMuMjhMMCwzNi44LDE4LjQ2LDU4LjQxYzE4LDIxLjQyLDQzLjQsMjAuOTMsNjEuMjQtMS4zbDE4LTIyLjYtLjMyLS44NlpNNTMuMDksNTguNTloMEEyMS44NiwyMS44NiwwLDAsMSwyNy42LDQxLjEybDAtLjEyQTIxLjkyLDIxLjkyLDAsMSwxLDUzLjA5LDU4LjU5WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTQwLjc1LDIwLjM4aC0uMTNhNS43NSw1Ljc1LDAsMSwwLC4xMywwWiIvPjwvZz48L2c+PC9zdmc+";
// LOGO_B64_OLD = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MzAuMSA2MC4zIj48ZGVmcz48c3R5bGU+LmNscy0xe2ZpbGw6I2ZmZjt9PC9zdHlsZT48L2RlZnM+PGcgaWQ9IkxpdmVsbG9fMiIgZGF0YS1uYW1lPSJMaXZlbGxvIDIiPjxnIGlkPSJMaXZlbGxvXzEtMiIgZGF0YS1uYW1lPSJMaXZlbGxvIDEiPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTI4Mi40LDBoMjYuNzJWNi41NkgzMjIuNlYzMy40N2g2LjYxVjQ2Ljk0aC02LjU1djYuNjlIMzE2djYuNjNIMjgyLjRabTEzLjQ5LDMzLjU2VjQ2LjgzaDE5Ljg1VjMzLjU2Wm0tLjA3LTYuODhoMTMuNFYyMGg2LjU1VjEzLjVIMjk1LjgyWiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTExNC4yNiwxMy4zVjI2LjdIMTQxdjYuNzVIMTE0LjM2VjQ2LjkyaDMzLjM3VjYwLjI2SDEwMC44OFYwSDE0MVYxMy4zWiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTQ3LjEsMEg2MC4zN1YyNi42NUg4MC41Vi4wN0g5My45MVY2MC4yOUg4MC42M1YzMy42Nkg2MC41VjYwLjI1SDQ3LjFaIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMzQ5LjQzLDBoMTMuNDhWNi41N2g2LjY5VjI2LjY5aDYuNzZ2MjAuMkgzODNWNjAuMjhIMzY5Ljc0VjQ3LjExaC0yMC4ydjYuNTNoLTYuNjlWNjAuM0gzMjkuNDlWNTMuNzNIMzM2VjMzLjZoNi43NlYxMy40MWg2LjY5Wm0xMy40MywyNi45MWgtNi41djYuNDZoNi41WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTI0Miw1My43aC02LjY5djYuNTlIMjIxLjg2VjUzLjc0aDYuNjFWMzMuNTVoNi42OVYxMy40Mmg2LjY5VjBoMTMuNDhWMTMuMjdoNi43NlYyNi43NWg2LjY5VjQ2Ljg3aDYuNjN2MTMuNEgyNjIuMThWNDcuMTJIMjQyWk0yNDIsMzMuMzhoMTMuMlYyNi45SDI0MloiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0yMjEuNjksNDAuMzZ2Ni41NmgtNi41N1Y1My42aC02LjY5djYuNjdIMTg4LjE3VjUzLjcySDE3NC43NlYzMy42MWgtNi42M1YyNi44NWg2LjQ5VjYuNzRoMTMuNDdWMGgxMy40OFY2LjU4SDIxNXY2LjY4aDYuNjdWMjBIMjA4LjM2VjEzLjVIMTg4LjIzVjIwaC02LjY3VjQwLjE4aDYuNTN2Ni42NmgyMC4xOVY0MC4zNloiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xMy40MiwxMy4zM0gwVi4wNkg0MC4xMlYxMy4zNEgyNi44N1Y2MC4yNkgxMy40MloiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik00MDMuMzMuMDVWNDYuOTRINDMwLjFWNjAuMjZIMzkwVi4wNVoiLz48L2c+PC9nPjwvc3ZnPg=="; // OLD LOGO BACKUP
const LOGO_B64 = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNTMuMjYgODAuNzQiPjxkZWZzPjxzdHlsZT4uY2xzLTF7ZmlsbDojZmZmO308L3N0eWxlPjwvZGVmcz48ZyBpZD0iTGl2ZWxsb18yIiBkYXRhLW5hbWU9IkxpdmVsbG8gMiI+PGcgaWQ9IkxpdmVsbG9fMS0yIiBkYXRhLW5hbWU9IkxpdmVsbG8gMSI+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTUuOTEsMjcuOTRWNDQuMDVIOC40NFYxNi4yMWg3bC4xMyw3aC0uNDVhMTEuNDIsMTEuNDIsMCwwLDEsMy4zMi01LjM5LDguNTgsOC41OCwwLDAsMSw1Ljc3LTEuOTEsOS44LDkuOCwwLDAsMSw1LDEuMjYsOC40Nyw4LjQ3LDAsMCwxLDMuMzQsMy42MSwxMi4zNiwxMi4zNiwwLDAsMSwxLjE4LDUuNjJ2MTcuN0gyNi4zNFYyNy42NEE1LjgzLDUuODMsMCwwLDAsMjUsMjMuNThhNC43NCw0Ljc0LDAsMCwwLTMuNy0xLjQ3LDUuNjIsNS42MiwwLDAsMC0yLjguNjksNC43MSw0LjcxLDAsMCwwLTEuOTIsMkE2LjY1LDYuNjUsMCwwLDAsMTUuOTEsMjcuOTRaIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtOC40NCAtNi45NSkiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01MS43NCw0NC42YTE0LjcxLDE0LjcxLDAsMCwxLTcuMzQtMS43NCwxMS43OCwxMS43OCwwLDAsMS00Ljc1LTVBMTYuNDcsMTYuNDcsMCwwLDEsMzgsMzAuMjhhMTYuMzYsMTYuMzYsMCwwLDEsMS42NC03LjU0LDEyLjI2LDEyLjI2LDAsMCwxLDQuNjYtNS4wNiwxMy40MywxMy40MywwLDAsMSw3LjA3LTEuODIsMTQuNiwxNC42LDAsMCwxLDUuMS44NywxMS42OSwxMS42OSwwLDAsMSw0LjE2LDIuNjMsMTIsMTIsMCwwLDEsMi44LDQuNCwxNy4yMiwxNy4yMiwwLDAsMSwxLDYuMjJ2Mi4wOUg0MS4wNlYyNy4zOUg2MC43OEw1Ny4zLDI4LjY0YTkuOTQsOS45NCwwLDAsMC0uNjYtMy43OCw1LjQxLDUuNDEsMCwwLDAtMi0yLjQ5LDUuNzEsNS43MSwwLDAsMC0zLjIzLS44OCw1Ljg2LDUuODYsMCwwLDAtMy4zLjksNS42Miw1LjYyLDAsMCwwLTIsMi40Myw4LjM5LDguMzksMCwwLDAtLjcsMy40OXYzLjMyYTkuMTUsOS4xNSwwLDAsMCwuODEsNC4wNiw1LjYsNS42LDAsMCwwLDIuMjcsMi40Niw2Ljc3LDYuNzcsMCwwLDAsMy40LjgyLDcuMjIsNy4yMiwwLDAsMCwyLjM5LS4zNyw1LDUsMCwwLDAsMS44My0xLjExLDQuODIsNC44MiwwLDAsMCwxLjE2LTEuOEw2NCwzN2E5Ljc0LDkuNzQsMCwwLDEtMi4zNCw0LDExLjE4LDExLjE4LDAsMCwxLTQuMTcsMi42N0ExNi4yNywxNi4yNywwLDAsMSw1MS43NCw0NC42WiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTguNDQgLTYuOTUpIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNODIuMzUsMTYuMjF2NS43SDY1Ljg0di01LjdaTTY5LjY3LDkuNTloNy40N1YzNS45MWEyLjc5LDIuNzksMCwwLDAsLjU5LDIsMi41MywyLjUzLDAsMCwwLDIsLjY0LDkuNzMsOS43MywwLDAsMCwxLjItLjExcS43Ny0uMTIsMS4xNy0uMjFsMS4wNyw1LjZhMTQuODEsMTQuODEsMCwwLDEtMi40OC41MiwxOS4zOSwxOS4zOSwwLDAsMS0yLjM1LjE1cS00LjE5LDAtNi40LTJhNy41NSw3LjU1LDAsMCwxLTIuMjItNS44NVoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC04LjQ0IC02Ljk1KSIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTkyLjczLDQ0LjA1LDg0LjUyLDE2LjIxaDcuODRMOTQuNzgsMjYuNXEuNjEsMi43NiwxLjM0LDZ0MS4zMiw3LjE4aC0uODVxLjY2LTMuODIsMS40Mi03LjExdDEuNDUtNi4wOEwxMDIsMTYuMjFoNi44N2wyLjQ5LDEwLjI5Yy40MiwxLjg3Ljg4LDMuODksMS40LDYuMDZzMSw0LjU0LDEuNDQsNy4xM2gtLjg1cS42LTMuODYsMS4yOS03LjExYy40NS0yLjE2LjktNC4xOSwxLjMzLTYuMDhsMi40MS0xMC4yOWg4bC04LjI3LDI3Ljg0aC03LjU5bC0zLjA5LTEwLjczcS0uNDUtMS42Mi0uOS0zLjU3dC0uODctNGMtLjI4LTEuMzUtLjU3LTIuNjItLjg3LTMuOGgxLjMyYy0uMjksMS4xOC0uNTcsMi40NS0uODYsMy44cy0uNTksMi42OS0uODksNC0uNTksMi41LS44OSwzLjU2bC0zLjA5LDEwLjczWiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTguNDQgLTYuOTUpIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTQwLjgsNDQuNmExNCwxNCwwLDAsMS03LjI1LTEuODEsMTIuMTMsMTIuMTMsMCwwLDEtNC43Mi01LDE2LjI1LDE2LjI1LDAsMCwxLTEuNjUtNy41LDE2LjM5LDE2LjM5LDAsMCwxLDEuNjUtNy41NiwxMi4xMywxMi4xMywwLDAsMSw0LjcyLTUsMTUuNDUsMTUuNDUsMCwwLDEsMTQuNTEsMCwxMi4xNCwxMi4xNCwwLDAsMSw0LjcsNSwxNi4yNywxNi4yNywwLDAsMSwxLjY2LDcuNTYsMTYuMTMsMTYuMTMsMCwwLDEtMS42Niw3LjUsMTIuMTQsMTIuMTQsMCwwLDEtNC43LDVBMTQsMTQsMCwwLDEsMTQwLjgsNDQuNlptMC01Ljg4YTUuMDUsNS4wNSwwLDAsMCwzLjMzLTEuMTEsNi42Miw2LjYyLDAsMCwwLDItMywxMy4xNSwxMy4xNSwwLDAsMCwuNjctNC4zNSwxMy4xNywxMy4xNywwLDAsMC0uNjctNC4zOCw2LjU2LDYuNTYsMCwwLDAtMi0zLDUuNTksNS41OSwwLDAsMC02LjY2LDAsNi42LDYuNiwwLDAsMC0yLDMsMTMuMTYsMTMuMTYsMCwwLDAtLjY4LDQuMzgsMTMuMTUsMTMuMTUsMCwwLDAsLjY4LDQuMzUsNi42Nyw2LjY3LDAsMCwwLDIsM0E1LDUsMCwwLDAsMTQwLjgsMzguNzJaIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtOC40NCAtNi45NSkiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xNTguNiw0NC4wNVYxNi4yMWg3LjIydjQuODZoLjNhNy4yNCw3LjI0LDAsMCwxLDIuNTgtMy45MSw2Ljg1LDYuODUsMCwwLDEsNC4xNS0xLjMyYy4zOCwwLC43OSwwLDEuMjQuMDZhNi44MSw2LjgxLDAsMCwxLDEuMTcuMTl2Ni42N2E2LjE1LDYuMTUsMCwwLDAtMS40NC0uMjcsMTYuMjgsMTYuMjgsMCwwLDAtMS44LS4xLDYuNCw2LjQsMCwwLDAtMy4wNi43Myw1LjM2LDUuMzYsMCwwLDAtMi4xMywyLDYuMDUsNi4wNSwwLDAsMC0uNzYsMy4wNVY0NC4wNVoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC04LjQ0IC02Ljk1KSIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE3OS4xNSw0NC4wNVY3aDcuNDd2MzcuMVptNi43Ny04LjE0di05SDE4N2w5LjExLTEwLjcxaDguNjVsLTEyLDE0SDE5MVptMTAuNjEsOC4xNC04LjM3LTEyLjIsNS01LjMsMTIuMTUsMTcuNVoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC04LjQ0IC02Ljk1KSIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTIxOS4xNCw0NC42YTE0LjY4LDE0LjY4LDAsMCwxLTcuMzQtMS43NCwxMS43OCwxMS43OCwwLDAsMS00Ljc1LTUsMTYuNDcsMTYuNDcsMCwwLDEtMS42NS03LjYyQTE2LjM2LDE2LjM2LDAsMCwxLDIwNywyMi43NGExMi4yNiwxMi4yNiwwLDAsMSw0LjY2LTUuMDYsMTMuNDMsMTMuNDMsMCwwLDEsNy4wNy0xLjgyLDE0LjYsMTQuNiwwLDAsMSw1LjEuODdBMTEuNjksMTEuNjksMCwwLDEsMjI4LDE5LjM2YTEyLDEyLDAsMCwxLDIuOCw0LjQsMTcuMjIsMTcuMjIsMCwwLDEsMSw2LjIydjIuMDlIMjA4LjQ2VjI3LjM5aDE5LjcybC0zLjQ4LDEuMjVhMTAuMTMsMTAuMTMsMCwwLDAtLjY2LTMuNzgsNS40MSw1LjQxLDAsMCwwLTItMi40OSw1LjcxLDUuNzEsMCwwLDAtMy4yMy0uODgsNS44Niw1Ljg2LDAsMCwwLTMuMy45LDUuNTUsNS41NSwwLDAsMC0yLDIuNDMsOC4yNCw4LjI0LDAsMCwwLS43LDMuNDl2My4zMmE5LjE1LDkuMTUsMCwwLDAsLjgxLDQuMDYsNS42LDUuNiwwLDAsMCwyLjI3LDIuNDYsNi43Nyw2Ljc3LDAsMCwwLDMuNC44Miw3LjIyLDcuMjIsMCwwLDAsMi4zOS0uMzcsNSw1LDAsMCwwLDEuODMtMS4xMSw1LDUsMCwwLDAsMS4xNi0xLjhMMjMxLjQyLDM3YTkuNzQsOS43NCwwLDAsMS0yLjM0LDQsMTEuMTgsMTEuMTgsMCwwLDEtNC4xNywyLjY3QTE2LjI3LDE2LjI3LDAsMCwxLDIxOS4xNCw0NC42WiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTguNDQgLTYuOTUpIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMjQ2LjA5LDQ0LjUzYTEwLjQ4LDEwLjQ4LDAsMCwxLTUuNzctMS42NkExMS4xOSwxMS4xOSwwLDAsMSwyMzYuMjUsMzhhMTguNTEsMTguNTEsMCwwLDEtMS40OS03LjgzLDE4LjEzLDE4LjEzLDAsMCwxLDEuNTQtNy45NCwxMS4xMywxMS4xMywwLDAsMSw0LjExLTQuNzgsMTAuNDMsMTAuNDMsMCwwLDEsNS42NS0xLjYsOC42OSw4LjY5LDAsMCwxLDMuOTQuOCw4LDgsMCwwLDEsMi41NCwyQTkuNTMsOS41MywwLDAsMSwyNTQsMjAuODloLjI1VjdoNy40N3YzNy4xaC03LjM1VjM5LjU5SDI1NGE5LDksMCwwLDEtMS40OCwyLjI2LDguMSw4LjEsMCwwLDEtMi41NSwxLjlBOC42NSw4LjY1LDAsMCwxLDI0Ni4wOSw0NC41M1ptMi4zMS02YTUuMTEsNS4xMSwwLDAsMCwzLjI0LTEsNi4zNSw2LjM1LDAsMCwwLDItMi45MywxMi40OCwxMi40OCwwLDAsMCwuNy00LjM5LDEyLjYyLDEyLjYyLDAsMCwwLS42OS00LjQsNi4yNSw2LjI1LDAsMCwwLTItMi44OSw1LjIxLDUuMjEsMCwwLDAtMy4yNy0xLDUuMTMsNS4xMywwLDAsMC0zLjMsMS4wNyw2LjUsNi41LDAsMCwwLTIsMi45NCwxMi42MywxMi42MywwLDAsMC0uNjcsNC4zMSwxMi42MiwxMi42MiwwLDAsMCwuNjgsNC4zMyw2LjU1LDYuNTUsMCwwLDAsMiwzQTUsNSwwLDAsMCwyNDguNCwzOC41MloiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC04LjQ0IC02Ljk1KSIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE0OS42OSw4Ny4zMmEyLjY5LDIuNjksMCwwLDEtMS45MS0uNzVBMi40OSwyLjQ5LDAsMCwxLDE0Nyw4NC43YTIuNDQsMi40NCwwLDAsMSwuNzktMS44NCwyLjc4LDIuNzgsMCwwLDEsMy44MiwwLDIuNDQsMi40NCwwLDAsMSwuNzksMS44NCwyLjQ5LDIuNDksMCwwLDEtLjc5LDEuODdBMi42OSwyLjY5LDAsMCwxLDE0OS42OSw4Ny4zMloiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC04LjQ0IC02Ljk1KSIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE3MC44Niw4Ny42OGE4LjMyLDguMzIsMCwwLDEtNC4zLTEuMTEsOCw4LDAsMCwxLTMtMy4yMiwxMS44MywxMS44MywwLDAsMSwwLTEwLDcuODgsNy44OCwwLDAsMSwzLTMuMjJBOC40Myw4LjQzLDAsMCwxLDE3MC44Niw2OWE4LDgsMCwwLDEsNS4yOSwxLjY2LDcuNDEsNy40MSwwLDAsMSwyLjUyLDQuNDNoLTMuMWE0LjI5LDQuMjksMCwwLDAtMS42NS0yLjM2LDUuMTcsNS4xNywwLDAsMC0zLjEtLjg4LDUsNSwwLDAsMC0yLjU5LjcyLDUuMjEsNS4yMSwwLDAsMC0yLDIuMTYsNy44MSw3LjgxLDAsMCwwLS43NiwzLjYzLDcuOTQsNy45NCwwLDAsMCwuNzYsMy42Niw1LjIsNS4yLDAsMCwwLDIsMi4xOEE1LjUsNS41LDAsMCwwLDE3NCw4NGE0LjQ5LDQuNDksMCwwLDAsMS42LTIuMzhoMy4xYTcuNDcsNy40NywwLDAsMS03LjgxLDYuMDhaIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtOC40NCAtNi45NSkiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xODkuOTQsODcuNjhhNy40NCw3LjQ0LDAsMCwxLTMuNTMtLjc1LDUuMDUsNS4wNSwwLDAsMS0yLjA5LTIsNS40OSw1LjQ5LDAsMCwxLS42OC0yLjcyLDQuNzcsNC43NywwLDAsMSwyLTQuMTZBOS4wOCw5LjA4LDAsMCwxLDE5MSw3Ni42M2g0Ljl2LS4zNnEwLTQuNjgtNC4yOS00LjY4YTUuMiw1LjIsMCwwLDAtMi45Ljc2LDMuNDgsMy40OCwwLDAsMC0xLjQ5LDIuMzdoLTMuMWE1LjgsNS44LDAsMCwxLDEuMjEtMy4wOSw2LjQ0LDYuNDQsMCwwLDEsMi42NS0yLDkuMTgsOS4xOCwwLDAsMSwzLjYzLS42OXEzLjgyLDAsNS41NiwyYTcuNzUsNy43NSwwLDAsMSwxLjc1LDUuMzF2MTFoLTIuNTlsLS4yNS0yLjc3aC0uMjVhOCw4LDAsMCwxLTIuMTEsMi4yNUE2LjMxLDYuMzEsMCwwLDEsMTg5Ljk0LDg3LjY4Wm0uNTQtMi42NmE1LjA2LDUuMDYsMCwwLDAsMi45My0uODNBNS4zMiw1LjMyLDAsMCwwLDE5NS4yNSw4MmE3LjA5LDcuMDksMCwwLDAsLjYzLTNoLTQuNjVhNS4zNSw1LjM1LDAsMCwwLTMuNDMuODMsMi42OCwyLjY4LDAsMCwwLTEsMi4xOSwyLjc0LDIuNzQsMCwwLDAsLjkzLDIuMkE0LjEzLDQuMTMsMCwwLDAsMTkwLjQ4LDg1WiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTguNDQgLTYuOTUpIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMjA0LjU1LDg3LjI1Vjg0LjY2aDQuNTdWNzIuODljMC0uNi0uMjgtLjktLjg2LS45SDIwNVY2OS40aDQuMzZhMi43MywyLjczLDAsMCwxLDEuOS42NEEyLjQ1LDIuNDUsMCwwLDEsMjEyLDcydi43NmguMTVhNC44NCw0Ljg0LDAsMCwxLDEuNjQtMi43Nyw1LjE5LDUuMTksMCwwLDEsMy4zNi0xaDMuMjh2My4yMWgtMy43MWE0LjA5LDQuMDksMCwwLDAtMy4zOCwxLjQ2LDUuNjUsNS42NSwwLDAsMC0xLjE5LDMuNzJ2Ny4zMWg1LjYxdjIuNTlaIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtOC40NCAtNi45NSkiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0yMzIuNiw4Ny42OGE3LjYyLDcuNjIsMCwwLDEtNC0xLjA4LDcuMjYsNy4yNiwwLDAsMS0yLjc5LTMuMTgsMTEuNzMsMTEuNzMsMCwwLDEtMS01LjEzLDExLjUxLDExLjUxLDAsMCwxLDEtNS4wOEE3LjI5LDcuMjksMCwwLDEsMjI4LjU1LDcwYTcuNjIsNy42MiwwLDAsMSw0LTEuMDgsNi44LDYuOCwwLDAsMSwzLjUxLjgzQTUuMzYsNS4zNiwwLDAsMSwyMzguMTgsNzJWNjEuMzNoM1Y4Ny4yNWgtMi40OGwtLjMzLTIuNzdoLS4yMWE1LjU5LDUuNTksMCwwLDEtMi4xMywyLjM0QTYuNDIsNi40MiwwLDAsMSwyMzIuNiw4Ny42OFpNMjMzLDg0LjhhNC44OSw0Ljg5LDAsMCwwLDMuNzUtMS42LDcsNywwLDAsMCwxLjQ3LTQuODgsNyw3LDAsMCwwLTEuNDctNC44N0E0Ljg5LDQuODksMCwwLDAsMjMzLDcxLjg0YTQuOCw0LjgsMCwwLDAtMy43MiwxLjYxLDcsNywwLDAsMC0xLjQ2LDQuODcsNyw3LDAsMCwwLDEuNDYsNC44OEE0Ljc5LDQuNzksMCwwLDAsMjMzLDg0LjhaIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtOC40NCAtNi45NSkiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0yNTQuMjcsODcuNjhhOC45LDguOSwwLDAsMS01LjUzLTEuNiw2LDYsMCwwLDEtMi4zNi00LjQxaDMuMTRBMy41NSwzLjU1LDAsMCwwLDI1MSw4NC4wOGE1LjQ0LDUuNDQsMCwwLDAsMy4zNy45NCw0LjUyLDQuNTIsMCwwLDAsMy0uODYsMi41OSwyLjU5LDAsMCwwLDEtMiwyLjA4LDIuMDgsMCwwLDAtMS4xOS0yLjA3LDExLjkzLDExLjkzLDAsMCwwLTMuNTctLjg1LDEwLjc1LDEwLjc1LDAsMCwxLTQuNzEtMS41NUE0LjA4LDQuMDgsMCwwLDEsMjQ3LDc0YTQuNDUsNC40NSwwLDAsMSwxLjgzLTMuNjQsNy45Miw3LjkyLDAsMCwxLDUtMS40NCw3Ljc1LDcuNzUsMCwwLDEsNC45MywxLjQzLDUuNTYsNS41NiwwLDAsMSwyLjA1LDRoLTNhMi42NCwyLjY0LDAsMCwwLTEuMjQtMi4wNyw0Ljg5LDQuODksMCwwLDAtMi44My0uNzgsNC43NSw0Ljc1LDAsMCwwLTIuNzMuNjcsMiwyLDAsMCwwLTEsMS43NCwyLjA4LDIuMDgsMCwwLDAsMS4wOSwxLjc5LDguMTMsOC4xMywwLDAsMCwzLjQ4LjkxLDE4LjQsMTguNCwwLDAsMSwzLjQyLjcyQTUuMzIsNS4zMiwwLDAsMSwyNjAuNTEsNzlhNC40OSw0LjQ5LDAsMCwxLC45MiwzLDQuNjMsNC42MywwLDAsMS0uODgsMi45QTYuMyw2LjMsMCwwLDEsMjU4LDg3LDksOSwwLDAsMSwyNTQuMjcsODcuNjhaIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtOC40NCAtNi45NSkiLz48L2c+PC9nPjwvc3ZnPg==";
const LOGO_FULL_B64 = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNTMuMjYgODAuNzQiPjxkZWZzPjxzdHlsZT4uY2xzLTF7ZmlsbDojZmZmO308L3N0eWxlPjwvZGVmcz48ZyBpZD0iTGl2ZWxsb18yIiBkYXRhLW5hbWU9IkxpdmVsbG8gMiI+PGcgaWQ9IkxpdmVsbG9fMS0yIiBkYXRhLW5hbWU9IkxpdmVsbG8gMSI+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTUuOTEsMjcuOTRWNDQuMDVIOC40NFYxNi4yMWg3bC4xMyw3aC0uNDVhMTEuNDIsMTEuNDIsMCwwLDEsMy4zMi01LjM5LDguNTgsOC41OCwwLDAsMSw1Ljc3LTEuOTEsOS44LDkuOCwwLDAsMSw1LDEuMjYsOC40Nyw4LjQ3LDAsMCwxLDMuMzQsMy42MSwxMi4zNiwxMi4zNiwwLDAsMSwxLjE4LDUuNjJ2MTcuN0gyNi4zNFYyNy42NEE1LjgzLDUuODMsMCwwLDAsMjUsMjMuNThhNC43NCw0Ljc0LDAsMCwwLTMuNy0xLjQ3LDUuNjIsNS42MiwwLDAsMC0yLjguNjksNC43MSw0LjcxLDAsMCwwLTEuOTIsMkE2LjY1LDYuNjUsMCwwLDAsMTUuOTEsMjcuOTRaIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtOC40NCAtNi45NSkiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01MS43NCw0NC42YTE0LjcxLDE0LjcxLDAsMCwxLTcuMzQtMS43NCwxMS43OCwxMS43OCwwLDAsMS00Ljc1LTVBMTYuNDcsMTYuNDcsMCwwLDEsMzgsMzAuMjhhMTYuMzYsMTYuMzYsMCwwLDEsMS42NC03LjU0LDEyLjI2LDEyLjI2LDAsMCwxLDQuNjYtNS4wNiwxMy40MywxMy40MywwLDAsMSw3LjA3LTEuODIsMTQuNiwxNC42LDAsMCwxLDUuMS44NywxMS42OSwxMS42OSwwLDAsMSw0LjE2LDIuNjMsMTIsMTIsMCwwLDEsMi44LDQuNCwxNy4yMiwxNy4yMiwwLDAsMSwxLDYuMjJ2Mi4wOUg0MS4wNlYyNy4zOUg2MC43OEw1Ny4zLDI4LjY0YTkuOTQsOS45NCwwLDAsMC0uNjYtMy43OCw1LjQxLDUuNDEsMCwwLDAtMi0yLjQ5LDUuNzEsNS43MSwwLDAsMC0zLjIzLS44OCw1Ljg2LDUuODYsMCwwLDAtMy4zLjksNS42Miw1LjYyLDAsMCwwLTIsMi40Myw4LjM5LDguMzksMCwwLDAtLjcsMy40OXYzLjMyYTkuMTUsOS4xNSwwLDAsMCwuODEsNC4wNiw1LjYsNS42LDAsMCwwLDIuMjcsMi40Niw2Ljc3LDYuNzcsMCwwLDAsMy40LjgyLDcuMjIsNy4yMiwwLDAsMCwyLjM5LS4zNyw1LDUsMCwwLDAsMS44My0xLjExLDQuODIsNC44MiwwLDAsMCwxLjE2LTEuOEw2NCwzN2E5Ljc0LDkuNzQsMCwwLDEtMi4zNCw0LDExLjE4LDExLjE4LDAsMCwxLTQuMTcsMi42N0ExNi4yNywxNi4yNywwLDAsMSw1MS43NCw0NC42WiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTguNDQgLTYuOTUpIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNODIuMzUsMTYuMjF2NS43SDY1Ljg0di01LjdaTTY5LjY3LDkuNTloNy40N1YzNS45MWEyLjc5LDIuNzksMCwwLDAsLjU5LDIsMi41MywyLjUzLDAsMCwwLDIsLjY0LDkuNzMsOS43MywwLDAsMCwxLjItLjExcS43Ny0uMTIsMS4xNy0uMjFsMS4wNyw1LjZhMTQuODEsMTQuODEsMCwwLDEtMi40OC41MiwxOS4zOSwxOS4zOSwwLDAsMS0yLjM1LjE1cS00LjE5LDAtNi40LTJhNy41NSw3LjU1LDAsMCwxLTIuMjItNS44NVoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC04LjQ0IC02Ljk1KSIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTkyLjczLDQ0LjA1LDg0LjUyLDE2LjIxaDcuODRMOTQuNzgsMjYuNXEuNjEsMi43NiwxLjM0LDZ0MS4zMiw3LjE4aC0uODVxLjY2LTMuODIsMS40Mi03LjExdDEuNDUtNi4wOEwxMDIsMTYuMjFoNi44N2wyLjQ5LDEwLjI5Yy40MiwxLjg3Ljg4LDMuODksMS40LDYuMDZzMSw0LjU0LDEuNDQsNy4xM2gtLjg1cS42LTMuODYsMS4yOS03LjExYy40NS0yLjE2LjktNC4xOSwxLjMzLTYuMDhsMi40MS0xMC4yOWg4bC04LjI3LDI3Ljg0aC03LjU5bC0zLjA5LTEwLjczcS0uNDUtMS42Mi0uOS0zLjU3dC0uODctNGMtLjI4LTEuMzUtLjU3LTIuNjItLjg3LTMuOGgxLjMyYy0uMjksMS4xOC0uNTcsMi40NS0uODYsMy44cy0uNTksMi42OS0uODksNC0uNTksMi41LS44OSwzLjU2bC0zLjA5LDEwLjczWiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTguNDQgLTYuOTUpIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTQwLjgsNDQuNmExNCwxNCwwLDAsMS03LjI1LTEuODEsMTIuMTMsMTIuMTMsMCwwLDEtNC43Mi01LDE2LjI1LDE2LjI1LDAsMCwxLTEuNjUtNy41LDE2LjM5LDE2LjM5LDAsMCwxLDEuNjUtNy41NiwxMi4xMywxMi4xMywwLDAsMSw0LjcyLTUsMTUuNDUsMTUuNDUsMCwwLDEsMTQuNTEsMCwxMi4xNCwxMi4xNCwwLDAsMSw0LjcsNSwxNi4yNywxNi4yNywwLDAsMSwxLjY2LDcuNTYsMTYuMTMsMTYuMTMsMCwwLDEtMS42Niw3LjUsMTIuMTQsMTIuMTQsMCwwLDEtNC43LDVBMTQsMTQsMCwwLDEsMTQwLjgsNDQuNlptMC01Ljg4YTUuMDUsNS4wNSwwLDAsMCwzLjMzLTEuMTEsNi42Miw2LjYyLDAsMCwwLDItMywxMy4xNSwxMy4xNSwwLDAsMCwuNjctNC4zNSwxMy4xNywxMy4xNywwLDAsMC0uNjctNC4zOCw2LjU2LDYuNTYsMCwwLDAtMi0zLDUuNTksNS41OSwwLDAsMC02LjY2LDAsNi42LDYuNiwwLDAsMC0yLDMsMTMuMTYsMTMuMTYsMCwwLDAtLjY4LDQuMzgsMTMuMTUsMTMuMTUsMCwwLDAsLjY4LDQuMzUsNi42Nyw2LjY3LDAsMCwwLDIsM0E1LDUsMCwwLDAsMTQwLjgsMzguNzJaIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtOC40NCAtNi45NSkiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xNTguNiw0NC4wNVYxNi4yMWg3LjIydjQuODZoLjNhNy4yNCw3LjI0LDAsMCwxLDIuNTgtMy45MSw2Ljg1LDYuODUsMCwwLDEsNC4xNS0xLjMyYy4zOCwwLC43OSwwLDEuMjQuMDZhNi44MSw2LjgxLDAsMCwxLDEuMTcuMTl2Ni42N2E2LjE1LDYuMTUsMCwwLDAtMS40NC0uMjcsMTYuMjgsMTYuMjgsMCwwLDAtMS44LS4xLDYuNCw2LjQsMCwwLDAtMy4wNi43Myw1LjM2LDUuMzYsMCwwLDAtMi4xMywyLDYuMDUsNi4wNSwwLDAsMC0uNzYsMy4wNVY0NC4wNVoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC04LjQ0IC02Ljk1KSIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE3OS4xNSw0NC4wNVY3aDcuNDd2MzcuMVptNi43Ny04LjE0di05SDE4N2w5LjExLTEwLjcxaDguNjVsLTEyLDE0SDE5MVptMTAuNjEsOC4xNC04LjM3LTEyLjIsNS01LjMsMTIuMTUsMTcuNVoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC04LjQ0IC02Ljk1KSIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTIxOS4xNCw0NC42YTE0LjY4LDE0LjY4LDAsMCwxLTcuMzQtMS43NCwxMS43OCwxMS43OCwwLDAsMS00Ljc1LTUsMTYuNDcsMTYuNDcsMCwwLDEtMS42NS03LjYyQTE2LjM2LDE2LjM2LDAsMCwxLDIwNywyMi43NGExMi4yNiwxMi4yNiwwLDAsMSw0LjY2LTUuMDYsMTMuNDMsMTMuNDMsMCwwLDEsNy4wNy0xLjgyLDE0LjYsMTQuNiwwLDAsMSw1LjEuODdBMTEuNjksMTEuNjksMCwwLDEsMjI4LDE5LjM2YTEyLDEyLDAsMCwxLDIuOCw0LjQsMTcuMjIsMTcuMjIsMCwwLDEsMSw2LjIydjIuMDlIMjA4LjQ2VjI3LjM5aDE5LjcybC0zLjQ4LDEuMjVhMTAuMTMsMTAuMTMsMCwwLDAtLjY2LTMuNzgsNS40MSw1LjQxLDAsMCwwLTItMi40OSw1LjcxLDUuNzEsMCwwLDAtMy4yMy0uODgsNS44Niw1Ljg2LDAsMCwwLTMuMy45LDUuNTUsNS41NSwwLDAsMC0yLDIuNDMsOC4yNCw4LjI0LDAsMCwwLS43LDMuNDl2My4zMmE5LjE1LDkuMTUsMCwwLDAsLjgxLDQuMDYsNS42LDUuNiwwLDAsMCwyLjI3LDIuNDYsNi43Nyw2Ljc3LDAsMCwwLDMuNC44Miw3LjIyLDcuMjIsMCwwLDAsMi4zOS0uMzcsNSw1LDAsMCwwLDEuODMtMS4xMSw1LDUsMCwwLDAsMS4xNi0xLjhMMjMxLjQyLDM3YTkuNzQsOS43NCwwLDAsMS0yLjM0LDQsMTEuMTgsMTEuMTgsMCwwLDEtNC4xNywyLjY3QTE2LjI3LDE2LjI3LDAsMCwxLDIxOS4xNCw0NC42WiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTguNDQgLTYuOTUpIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMjQ2LjA5LDQ0LjUzYTEwLjQ4LDEwLjQ4LDAsMCwxLTUuNzctMS42NkExMS4xOSwxMS4xOSwwLDAsMSwyMzYuMjUsMzhhMTguNTEsMTguNTEsMCwwLDEtMS40OS03LjgzLDE4LjEzLDE4LjEzLDAsMCwxLDEuNTQtNy45NCwxMS4xMywxMS4xMywwLDAsMSw0LjExLTQuNzgsMTAuNDMsMTAuNDMsMCwwLDEsNS42NS0xLjYsOC42OSw4LjY5LDAsMCwxLDMuOTQuOCw4LDgsMCwwLDEsMi41NCwyQTkuNTMsOS41MywwLDAsMSwyNTQsMjAuODloLjI1VjdoNy40N3YzNy4xaC03LjM1VjM5LjU5SDI1NGE5LDksMCwwLDEtMS40OCwyLjI2LDguMSw4LjEsMCwwLDEtMi41NSwxLjlBOC42NSw4LjY1LDAsMCwxLDI0Ni4wOSw0NC41M1ptMi4zMS02YTUuMTEsNS4xMSwwLDAsMCwzLjI0LTEsNi4zNSw2LjM1LDAsMCwwLDItMi45MywxMi40OCwxMi40OCwwLDAsMCwuNy00LjM5LDEyLjYyLDEyLjYyLDAsMCwwLS42OS00LjQsNi4yNSw2LjI1LDAsMCwwLTItMi44OSw1LjIxLDUuMjEsMCwwLDAtMy4yNy0xLDUuMTMsNS4xMywwLDAsMC0zLjMsMS4wNyw2LjUsNi41LDAsMCwwLTIsMi45NCwxMi42MywxMi42MywwLDAsMC0uNjcsNC4zMSwxMi42MiwxMi42MiwwLDAsMCwuNjgsNC4zMyw2LjU1LDYuNTUsMCwwLDAsMiwzQTUsNSwwLDAsMCwyNDguNCwzOC41MloiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC04LjQ0IC02Ljk1KSIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE0OS42OSw4Ny4zMmEyLjY5LDIuNjksMCwwLDEtMS45MS0uNzVBMi40OSwyLjQ5LDAsMCwxLDE0Nyw4NC43YTIuNDQsMi40NCwwLDAsMSwuNzktMS44NCwyLjc4LDIuNzgsMCwwLDEsMy44MiwwLDIuNDQsMi40NCwwLDAsMSwuNzksMS44NCwyLjQ5LDIuNDksMCwwLDEtLjc5LDEuODdBMi42OSwyLjY5LDAsMCwxLDE0OS42OSw4Ny4zMloiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC04LjQ0IC02Ljk1KSIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE3MC44Niw4Ny42OGE4LjMyLDguMzIsMCwwLDEtNC4zLTEuMTEsOCw4LDAsMCwxLTMtMy4yMiwxMS44MywxMS44MywwLDAsMSwwLTEwLDcuODgsNy44OCwwLDAsMSwzLTMuMjJBOC40Myw4LjQzLDAsMCwxLDE3MC44Niw2OWE4LDgsMCwwLDEsNS4yOSwxLjY2LDcuNDEsNy40MSwwLDAsMSwyLjUyLDQuNDNoLTMuMWE0LjI5LDQuMjksMCwwLDAtMS42NS0yLjM2LDUuMTcsNS4xNywwLDAsMC0zLjEtLjg4LDUsNSwwLDAsMC0yLjU5LjcyLDUuMjEsNS4yMSwwLDAsMC0yLDIuMTYsNy44MSw3LjgxLDAsMCwwLS43NiwzLjYzLDcuOTQsNy45NCwwLDAsMCwuNzYsMy42Niw1LjIsNS4yLDAsMCwwLDIsMi4xOEE1LjUsNS41LDAsMCwwLDE3NCw4NGE0LjQ5LDQuNDksMCwwLDAsMS42LTIuMzhoMy4xYTcuNDcsNy40NywwLDAsMS03LjgxLDYuMDhaIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtOC40NCAtNi45NSkiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xODkuOTQsODcuNjhhNy40NCw3LjQ0LDAsMCwxLTMuNTMtLjc1LDUuMDUsNS4wNSwwLDAsMS0yLjA5LTIsNS40OSw1LjQ5LDAsMCwxLS42OC0yLjcyLDQuNzcsNC43NywwLDAsMSwyLTQuMTZBOS4wOCw5LjA4LDAsMCwxLDE5MSw3Ni42M2g0Ljl2LS4zNnEwLTQuNjgtNC4yOS00LjY4YTUuMiw1LjIsMCwwLDAtMi45Ljc2LDMuNDgsMy40OCwwLDAsMC0xLjQ5LDIuMzdoLTMuMWE1LjgsNS44LDAsMCwxLDEuMjEtMy4wOSw2LjQ0LDYuNDQsMCwwLDEsMi42NS0yLDkuMTgsOS4xOCwwLDAsMSwzLjYzLS42OXEzLjgyLDAsNS41NiwyYTcuNzUsNy43NSwwLDAsMSwxLjc1LDUuMzF2MTFoLTIuNTlsLS4yNS0yLjc3aC0uMjVhOCw4LDAsMCwxLTIuMTEsMi4yNUE2LjMxLDYuMzEsMCwwLDEsMTg5Ljk0LDg3LjY4Wm0uNTQtMi42NmE1LjA2LDUuMDYsMCwwLDAsMi45My0uODNBNS4zMiw1LjMyLDAsMCwwLDE5NS4yNSw4MmE3LjA5LDcuMDksMCwwLDAsLjYzLTNoLTQuNjVhNS4zNSw1LjM1LDAsMCwwLTMuNDMuODMsMi42OCwyLjY4LDAsMCwwLTEsMi4xOSwyLjc0LDIuNzQsMCwwLDAsLjkzLDIuMkE0LjEzLDQuMTMsMCwwLDAsMTkwLjQ4LDg1WiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTguNDQgLTYuOTUpIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMjA0LjU1LDg3LjI1Vjg0LjY2aDQuNTdWNzIuODljMC0uNi0uMjgtLjktLjg2LS45SDIwNVY2OS40aDQuMzZhMi43MywyLjczLDAsMCwxLDEuOS42NEEyLjQ1LDIuNDUsMCwwLDEsMjEyLDcydi43NmguMTVhNC44NCw0Ljg0LDAsMCwxLDEuNjQtMi43Nyw1LjE5LDUuMTksMCwwLDEsMy4zNi0xaDMuMjh2My4yMWgtMy43MWE0LjA5LDQuMDksMCwwLDAtMy4zOCwxLjQ2LDUuNjUsNS42NSwwLDAsMC0xLjE5LDMuNzJ2Ny4zMWg1LjYxdjIuNTlaIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtOC40NCAtNi45NSkiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0yMzIuNiw4Ny42OGE3LjYyLDcuNjIsMCwwLDEtNC0xLjA4LDcuMjYsNy4yNiwwLDAsMS0yLjc5LTMuMTgsMTEuNzMsMTEuNzMsMCwwLDEtMS01LjEzLDExLjUxLDExLjUxLDAsMCwxLDEtNS4wOEE3LjI5LDcuMjksMCwwLDEsMjI4LjU1LDcwYTcuNjIsNy42MiwwLDAsMSw0LTEuMDgsNi44LDYuOCwwLDAsMSwzLjUxLjgzQTUuMzYsNS4zNiwwLDAsMSwyMzguMTgsNzJWNjEuMzNoM1Y4Ny4yNWgtMi40OGwtLjMzLTIuNzdoLS4yMWE1LjU5LDUuNTksMCwwLDEtMi4xMywyLjM0QTYuNDIsNi40MiwwLDAsMSwyMzIuNiw4Ny42OFpNMjMzLDg0LjhhNC44OSw0Ljg5LDAsMCwwLDMuNzUtMS42LDcsNywwLDAsMCwxLjQ3LTQuODgsNyw3LDAsMCwwLTEuNDctNC44N0E0Ljg5LDQuODksMCwwLDAsMjMzLDcxLjg0YTQuOCw0LjgsMCwwLDAtMy43MiwxLjYxLDcsNywwLDAsMC0xLjQ2LDQuODcsNyw3LDAsMCwwLDEuNDYsNC44OEE0Ljc5LDQuNzksMCwwLDAsMjMzLDg0LjhaIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtOC40NCAtNi45NSkiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0yNTQuMjcsODcuNjhhOC45LDguOSwwLDAsMS01LjUzLTEuNiw2LDYsMCwwLDEtMi4zNi00LjQxaDMuMTRBMy41NSwzLjU1LDAsMCwwLDI1MSw4NC4wOGE1LjQ0LDUuNDQsMCwwLDAsMy4zNy45NCw0LjUyLDQuNTIsMCwwLDAsMy0uODYsMi41OSwyLjU5LDAsMCwwLDEtMiwyLjA4LDIuMDgsMCwwLDAtMS4xOS0yLjA3LDExLjkzLDExLjkzLDAsMCwwLTMuNTctLjg1LDEwLjc1LDEwLjc1LDAsMCwxLTQuNzEtMS41NUE0LjA4LDQuMDgsMCwwLDEsMjQ3LDc0YTQuNDUsNC40NSwwLDAsMSwxLjgzLTMuNjQsNy45Miw3LjkyLDAsMCwxLDUtMS40NCw3Ljc1LDcuNzUsMCwwLDEsNC45MywxLjQzLDUuNTYsNS41NiwwLDAsMSwyLjA1LDRoLTNhMi42NCwyLjY0LDAsMCwwLTEuMjQtMi4wNyw0Ljg5LDQuODksMCwwLDAtMi44My0uNzgsNC43NSw0Ljc1LDAsMCwwLTIuNzMuNjcsMiwyLDAsMCwwLTEsMS43NCwyLjA4LDIuMDgsMCwwLDAsMS4wOSwxLjc5LDguMTMsOC4xMywwLDAsMCwzLjQ4LjkxLDE4LjQsMTguNCwwLDAsMSwzLjQyLjcyQTUuMzIsNS4zMiwwLDAsMSwyNjAuNTEsNzlhNC40OSw0LjQ5LDAsMCwxLC45MiwzLDQuNjMsNC42MywwLDAsMS0uODgsMi45QTYuMyw2LjMsMCwwLDEsMjU4LDg3LDksOSwwLDAsMSwyNTQuMjcsODcuNjhaIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtOC40NCAtNi45NSkiLz48L2c+PC9nPjwvc3ZnPg=="; // Full logo with static eye — for header only

// ─────────────────────────────────────────────────────────────────────────────
// PACK VISUALS — edit these to customise pack artwork
// ─────────────────────────────────────────────────────────────────────────────

// Standard pack image — null uses the built-in procedural design.
// To use a custom image: replace null with a base64 data URI string.
// e.g. "data:image/jpeg;base64,/9j/4AAQ..."
const PACK_STANDARD_IMAGE = null;

// Pity pack images — add as many as you like, they rotate randomly each time a pity pack appears.
// null entries are ignored. Add a friend's art by pushing their base64 string to this array.
// e.g. const PACK_PITY_IMAGES = ["data:image/jpeg;base64,...", "data:image/jpeg;base64,..."];
const PACK_PITY_IMAGES = [
  // null, // ← uncomment and replace with a base64 image string to add custom pack art
];

/* ══════════════════════════════════════════════════════
   STYLES
══════════════════════════════════════════════════════ */
(() => {
  const s = document.createElement("style");
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,400&display=swap');
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; -webkit-user-select:none; user-select:none; }
  input, textarea, select { -webkit-user-select:text; user-select:text; }
    html, body, #root { background:#060606; font-family:'DM Mono',monospace; min-height:100vh; }
  @property --holo-x   { syntax: '<percentage>'; inherits: false; initial-value: 50%; }
  @property --holo-y   { syntax: '<percentage>'; inherits: false; initial-value: 50%; }
  @property --holo-hue { syntax: '<angle>';       inherits: false; initial-value: 0deg; }
    ::-webkit-scrollbar { width:2px; }
    ::-webkit-scrollbar-thumb { background:#2a2a2a; }
    @keyframes slideUp    { from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);} }
    @keyframes cardReveal { from{opacity:0;transform:perspective(700px) rotateY(90deg) scale(.88);}to{opacity:1;transform:perspective(700px) rotateY(0) scale(1);} }
    @keyframes packFloat  { 0%,100%{transform:translateY(0) rotate(-.4deg);}50%{transform:translateY(-11px) rotate(.4deg);} }
    @keyframes packShake  { 0%{transform:rotate(0) scale(1);}8%{transform:rotate(-6deg) scale(1.05);}18%{transform:rotate(6deg) scale(1.05);}28%{transform:rotate(-5deg) scale(1.04);}38%{transform:rotate(5deg) scale(1.04);}50%{transform:rotate(-3deg) scale(1.06);}62%{transform:rotate(3deg) scale(1.06);}74%{transform:rotate(-2deg) scale(1.03);}86%{transform:rotate(2deg) scale(1.03);}95%{transform:rotate(-1deg) scale(1.01);}100%{transform:rotate(0) scale(1);} }
    @keyframes packBurst  { 0%{transform:scale(1);opacity:1;filter:brightness(1);}35%{transform:scale(1.5);opacity:.9;filter:brightness(5);}100%{transform:scale(2.2);opacity:0;filter:brightness(1);} }
    @keyframes notifSlide { from{opacity:0;transform:translateX(-50%) translateY(-10px);}to{opacity:1;transform:translateX(-50%) translateY(0);} }
    @keyframes holoShimmerIdle {
      0%   { background-position: 50% 0%,   0% 50%; }
      50%  { background-position: 50% 100%, 100% 50%; }
      100% { background-position: 50% 0%,   0% 50%; }
    }
    @keyframes holoGradient {
      0%   { background-position:0% 50%;   filter:hue-rotate(0deg)   brightness(1.15); }
      50%  { background-position:100% 50%; filter:hue-rotate(180deg) brightness(1.25); }
      100% { background-position:0% 50%;   filter:hue-rotate(360deg) brightness(1.15); }
    }
    @keyframes holoSparkle {
      0%,100% { opacity:0.3; }
      33%     { opacity:0.8; }
      66%     { opacity:0.5; }
    }
    @keyframes holoShine {
      0%   { transform:translateX(-100%) skewX(-20deg); }
      100% { transform:translateX(300%)  skewX(-20deg); }
    }
    @keyframes snapBack   { 0%{transform:translate(var(--sx),var(--sy)) rotate(var(--sr));}100%{transform:translate(0,0) rotate(0);} }
  `;
  document.head.appendChild(s);
})();

/* ══════════════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════════════ */
const MAX_PACKS   = 10;
const PACK_REGEN  = 90;    // seconds (1:30)
const CARDS_PER   = 5;
const LUCKY_CHANCE = 0.05;  // 5% chance per pack
const SAVE_KEY    = "networked_cards_save_v1";

const RARITIES = {
  C:  { name:"Common",     short:"C",  color:"#555",    accent:"#999",    rate:0.7995 },
  R:  { name:"Rare",       short:"R",  color:"#2563eb", accent:"#60a5fa", rate:0.1625 },
  UR: { name:"Ultra Rare", short:"UR", color:"#b45309", accent:"#fbbf24", rate:0.0355 },
  LR: { name:"Legendary",  short:"LR", color:"#9d174d", accent:"#f472b6", rate:0.0025 },
};
const RARITY_ORDER = ["LR","UR","R","C"];

/* ══════════════════════════════════════════════════════
   ASSET PATHS
   card()    → local override (user drops PNG in public/assets/cards/)
   cardPfp() → live Twitter/X profile picture via unavatar.io
   Load order: local override → pfp → placeholder grid
══════════════════════════════════════════════════════ */
const PFP_DATA = {};

const ASSET = {
  packStandard: null,
  packPity:     null,
  card:    () => null,
  cardPfp: (card) => {
    return card && card.image_cid ? ipfsUrl(card.image_cid) : null;
  },
};

/* ══════════════════════════════════════════════════════
   GENERATED AVATAR  — canvas-drawn, always visible.
   Used as the art area background; real pfp overlays it
   via <img> when available. Deterministic + looks great.
══════════════════════════════════════════════════════ */
function drawGeneratedAvatar(canvas, card) {
  // Draw into a small canvas (will be stretched to art area by CSS)
  const S = 200;
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext("2d");
  const r = RARITIES[card.rarity];

  // Hash handle to a hue for variety
  let hash = 0;
  for (let i = 0; i < card.handle.length; i++) hash = (hash * 31 + card.handle.charCodeAt(i)) >>> 0;
  const hue = hash % 360;

  // Background: dark gradient from rarity color
  const bg = ctx.createRadialGradient(S*0.5, S*0.42, S*0.05, S*0.5, S*0.5, S*0.75);
  bg.addColorStop(0, `hsl(${hue},22%,14%)`);
  bg.addColorStop(1, "#080808");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, S, S);

  // Subtle geometric accent — concentric rings
  ctx.strokeStyle = r.color + "28";
  ctx.lineWidth = 1;
  for (let rr = 20; rr < S * 0.7; rr += 18) {
    ctx.beginPath(); ctx.arc(S/2, S/2, rr, 0, Math.PI*2); ctx.stroke();
  }

  // Circle backdrop for initials
  const circR = S * 0.32;
  const grd = ctx.createRadialGradient(S/2, S/2 - circR*0.2, circR*0.1, S/2, S/2, circR);
  grd.addColorStop(0, r.color + "55");
  grd.addColorStop(1, r.color + "18");
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.arc(S/2, S/2, circR, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = r.color + "70"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(S/2, S/2, circR, 0, Math.PI*2); ctx.stroke();

  // Initials (up to 2 chars)
  const raw = card.name.replace(/[^a-zA-Z0-9]/g,"");
  const initials = raw.length >= 2
    ? (raw[0] + raw[1]).toUpperCase()
    : raw[0]?.toUpperCase() || "?";
  const fontSize = initials.length > 1 ? S * 0.29 : S * 0.36;
  ctx.fillStyle = r.accent;
  ctx.font = `500 ${fontSize}px "DM Mono","Courier New",monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials, S/2, S/2 + fontSize*0.05);

  // Handle text at bottom
  ctx.fillStyle = r.color + "80";
  ctx.font = `400 ${S*0.068}px "DM Mono","Courier New",monospace`;
  ctx.textBaseline = "alphabetic";
  const ht = card.handle.replace(/^@/,"");
  ctx.fillText(ht.length > 14 ? ht.slice(0,13)+"…" : ht, S/2, S*0.91);
}

/* ══════════════════════════════════════════════════════
   STORAGE  (localStorage + optional Claude.ai window.storage)
══════════════════════════════════════════════════════ */
const Storage = {
  async get(key) {
    try {
      if (window.storage?.get) return await window.storage.get(key);
      const v = localStorage.getItem(key);
      return v ? { value: v } : null;
    } catch { return null; }
  },
  set(key, value) {
    try {
      if (window.storage?.set) window.storage.set(key, value).catch(()=>{});
      else localStorage.setItem(key, value);
    } catch {}
  },
};

/* ══════════════════════════════════════════════════════
   151 ACCOUNTS  (10 LR · 21 UR · 32 R · 88 C)
   Card art loads live from each account's Twitter pfp
   via unavatar.io — no images to download.
══════════════════════════════════════════════════════ */
let ACCOUNTS = [];


// SERIAL_MAP computed lazily after ACCOUNTS loads
let _serialCache = null;
function getSerialMap() {
  if (_serialCache) return _serialCache;
  if (!ACCOUNTS.length) return {};
  const ordered = [...ACCOUNTS].sort((a, b) => {
    const rd = RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity);
    if (rd !== 0) return rd;
    return a.name.localeCompare(b.name);
  });
  _serialCache = {};
  ordered.forEach((acc, i) => { _serialCache[acc.id] = i + 1; });
  return _serialCache;
}
// Keep SERIAL_MAP as a proxy for backward compat
const SERIAL_MAP = new Proxy({}, { get: (_, k) => getSerialMap()[k] });

// O(1) lookup by id — used to reconstruct card data from compact save format
let ACCOUNTS_BY_ID = {};

/* ══════════════════════════════════════════════════════
   GACHA ENGINE
══════════════════════════════════════════════════════ */
function rollRarity() {
  const r = Math.random();
  if (r < RARITIES.LR.rate) return "LR";
  if (r < RARITIES.LR.rate + RARITIES.UR.rate) return "UR";
  if (r < RARITIES.LR.rate + RARITIES.UR.rate + RARITIES.R.rate) return "R";
  return "C";
}
function pickCard() {
  const rarity = rollRarity();
  const pool = ACCOUNTS.filter(a => a.rarity === rarity);
  const base = pool[Math.floor(Math.random() * pool.length)];
  return { ...base, _uid: `${base.id}_${Date.now()}_${Math.random().toString(36).slice(2,7)}` };
}
function drawPack(lucky = false) {
  const cards = Array.from({ length: CARDS_PER }, () => pickCard());
  if (lucky) {
    // Lucky Pack: guarantee at least 1 UR (or LR) and at least 1 R
    const makeCard = (rarity) => {
      const pool = ACCOUNTS.filter(a => a.rarity === rarity);
      const base = pool[Math.floor(Math.random() * pool.length)];
      return { ...base, _uid: `${base.id}_${Date.now()}_${Math.random().toString(36).slice(2,7)}` };
    };
    const hasUR = cards.some(c => c.rarity === "UR" || c.rarity === "LR");
    const hasR  = cards.some(c => c.rarity === "R");
    // Replace lowest cards if guarantees not met
    const sorted = [...cards].map((c,i) => ({c,i}))
      .sort((a,b) => RARITY_ORDER.indexOf(a.c.rarity) - RARITY_ORDER.indexOf(b.c.rarity));
    let slot = sorted.length - 1;
    if (!hasUR) { cards[sorted[slot].i] = makeCard("UR"); slot--; }
    if (!hasR && slot >= 0 && !cards[sorted[slot].i].rarity.match(/UR|LR/))
      cards[sorted[slot].i] = makeCard("R");
  }
  return cards;
}
function draw10Packs(start = 0) {
  const out = [];
  for (let p = 0; p < 10; p++)
    for (let i = 0; i < CARDS_PER; i++)
      out.push(pickCard(start + p * CARDS_PER + i));
  return out;
}

/* ══════════════════════════════════════════════════════
   ENCRYPTED SAVE
══════════════════════════════════════════════════════ */
const _EK = "thecabal_x9K2mNpQ7r_v1";
async function encryptSave(data) {
  try {
    const enc = new TextEncoder();
    const km = await crypto.subtle.importKey("raw", enc.encode(_EK), "PBKDF2", false, ["deriveKey"]);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.deriveKey(
      { name:"PBKDF2", salt, iterations:120000, hash:"SHA-256" }, km,
      { name:"AES-GCM", length:256 }, false, ["encrypt"]
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name:"AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
    const out = new Uint8Array(16+12+ct.byteLength);
    out.set(salt,0); out.set(iv,16); out.set(new Uint8Array(ct),28);
    return btoa(String.fromCharCode(...out));
  } catch { return null; }
}
async function decryptSave(b64) {
  const enc = new TextEncoder();
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const km = await crypto.subtle.importKey("raw", enc.encode(_EK), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name:"PBKDF2", salt:raw.slice(0,16), iterations:120000, hash:"SHA-256" }, km,
    { name:"AES-GCM", length:256 }, false, ["decrypt"]
  );
  const pt = await crypto.subtle.decrypt({ name:"AES-GCM", iv:raw.slice(16,28) }, key, raw.slice(28));
  return JSON.parse(new TextDecoder().decode(pt));
}

/* ══════════════════════════════════════════════════════
   IMAGE LOADER
══════════════════════════════════════════════════════ */
const _imgCache = {};
function loadImg(src) {
  if (_imgCache[src]) return _imgCache[src];
  const p = new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload  = () => res(img);
    img.onerror = () => rej(null);
    img.src = src;
  });
  _imgCache[src] = p;
  return p;
}

/* ══════════════════════════════════════════════════════
   CANVAS HELPERS
══════════════════════════════════════════════════════ */
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}
function wrapText(ctx, text, x, y, maxW, lh) {
  const words = text.split(" "); let line = "", ly = y;
  for (const w of words) {
    const t = line ? line+" "+w : w;
    if (ctx.measureText(t).width > maxW) { ctx.fillText(line,x,ly); line=w; ly+=lh; }
    else line = t;
  }
  ctx.fillText(line,x,ly); return ly+lh;
}

// uiMode=true  → art area left transparent so the <img> pfp tag behind shows through
// uiMode=false → art area filled (used for PNG download, img contains the pfp)
function drawCardTemplate(canvas, card, img=null, uiMode=false) {
  const SC=2, W=300, H=470;
  canvas.width=W*SC; canvas.height=H*SC;
  const ctx=canvas.getContext("2d"); ctx.scale(SC,SC);
  const r=RARITIES[card.rarity];

  const AX=8, AY=26, AW=W-16, AH=262;

  if (uiMode) {
    // Draw card background but leave the art area transparent.
    // We do this by drawing the full rounded rect then clearing the art slot.
    ctx.fillStyle="#080808"; rrect(ctx,0,0,W,H,10); ctx.fill();
    ctx.clearRect(AX, AY, AW, AH); // punch hole → pfp <img> shows through
  } else {
    ctx.fillStyle="#080808"; rrect(ctx,0,0,W,H,10); ctx.fill();
  }

  ctx.strokeStyle=r.color; ctx.lineWidth=1.5; rrect(ctx,1,1,W-2,H-2,9); ctx.stroke();
  ctx.strokeStyle=r.color+"30"; ctx.lineWidth=0.5; rrect(ctx,5,5,W-10,H-10,7); ctx.stroke();

  ctx.fillStyle=r.color+"22"; ctx.fillRect(8,8,W-16,26);
  ctx.strokeStyle=r.color+"30"; ctx.lineWidth=0.5; ctx.strokeRect(8,8,W-16,26);
  ctx.fillStyle="#d0d0d0"; ctx.font=`500 8px "DM Mono","Courier New",monospace`;
  ctx.textAlign="left"; ctx.fillText("networked.cards",14,24);
  ctx.textAlign="right"; ctx.fillStyle=r.accent;
  ctx.fillText(r.name.toUpperCase(),W-14,24);

  if (!uiMode) {
    // Download mode: draw the actual pfp image (or placeholder if unavailable)
    if (img) {
      try {
        ctx.save();
        ctx.beginPath(); ctx.rect(AX, AY, AW, AH); ctx.clip();
        const iw = img.naturalWidth  || img.width;
        const ih = img.naturalHeight || img.height;
        const scale = Math.max(AW / iw, AH / ih);
        const dw = iw * scale, dh = ih * scale;
        const dx = AX + (AW - dw) / 2;
        const dy = AY + (AH - dh) * 0.2;
        ctx.drawImage(img, dx, dy, dw, dh);
        ctx.restore();
        const g=ctx.createLinearGradient(AX,AY,AX,AY+AH);
        g.addColorStop(0,"rgba(0,0,0,0.12)"); g.addColorStop(1,"rgba(0,0,0,0.38)");
        ctx.fillStyle=g; ctx.fillRect(AX,AY,AW,AH);
      } catch(e) {
        drawArtPlaceholder(ctx, card, AX, AY, AW, AH);
      }
    } else {
      drawArtPlaceholder(ctx, card, AX, AY, AW, AH);
    }
  }

  // Body text — centered in the space below art
  const textTop = AY+AH+12;
  const textMid = textTop + (H-22 - textTop) / 2 - 16;
  ctx.textAlign="left"; ctx.fillStyle=r.accent;
  ctx.font=`400 8px "DM Mono","Courier New",monospace`; ctx.fillText(card.handle,14,textMid); 
  ctx.fillStyle="#e8e8e8"; ctx.font=`500 11px "DM Mono","Courier New",monospace`;
  ctx.fillText(card.name.length>24?card.name.slice(0,23)+"…":card.name,14,textMid+14);
  ctx.fillStyle="#555"; ctx.font=`400 7px "DM Mono","Courier New",monospace`;
  ctx.fillText(card.cat.toUpperCase(),14,textMid+26);

  ctx.fillStyle=r.color+"22"; ctx.fillRect(8,H-22,W-16,16);
  ctx.fillStyle=r.accent; ctx.font=`500 7.5px "DM Mono","Courier New",monospace`;
  ctx.textAlign="center"; ctx.fillText(`◆ ${r.name.toUpperCase()}  ·  networked.cards`,W/2,H-11);
  // Serial number — top-right corner of art area header
  const serial = SERIAL_MAP[card.id];
  if (serial !== undefined) {
    ctx.fillStyle=r.color+"99"; ctx.font=`400 7px "DM Mono","Courier New",monospace`;
    ctx.textAlign="right"; ctx.fillText(`#${String(serial).padStart(3,"0")}`,W-14,24);
  }
}

function drawArtPlaceholder(ctx, card, AX, AY, AW, AH) {
  ctx.fillStyle="#0d0d0d"; ctx.fillRect(AX,AY,AW,AH);
  ctx.strokeStyle="#222"; ctx.lineWidth=1; ctx.strokeRect(AX,AY,AW,AH);
  ctx.strokeStyle="#191919"; ctx.lineWidth=0.5;
  for(let gx=AX+22;gx<AX+AW;gx+=22){ctx.beginPath();ctx.moveTo(gx,AY);ctx.lineTo(gx,AY+AH);ctx.stroke();}
  for(let gy=AY+22;gy<AY+AH;gy+=22){ctx.beginPath();ctx.moveTo(AX,gy);ctx.lineTo(AX+AW,gy);ctx.stroke();}
  const cx=AX+AW/2, cy=AY+AH/2;
  ctx.strokeStyle="#2a2a2a"; ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(cx-18,cy);ctx.lineTo(cx+18,cy);ctx.stroke();
  ctx.beginPath();ctx.moveTo(cx,cy-18);ctx.lineTo(cx,cy+18);ctx.stroke();
  ctx.beginPath();ctx.arc(cx,cy,6,0,Math.PI*2);ctx.stroke();
}

// drawPackTemplate removed — PackVisual is now pure CSS/React (no canvas)

/* Card PNG download */
function downloadCardPNG(card) {
  const dl = (img) => {
    const c=document.createElement("canvas"); drawCardTemplate(c,card,img);
    const a=document.createElement("a"); a.href=c.toDataURL("image/png");
    a.download=`networked_${card.id}.png`; a.click();
  };
  loadImg(ASSET.card(card.id))
    .then(dl)
    .catch(() => loadImg((card.image_cid ? ipfsUrl(card.image_cid) : null)).then(dl).catch(() => dl(null)));
}

/* ══════════════════════════════════════════════════════
   CARD CANVAS COMPONENT
   Canvas draws the frame/text; a plain <img> overlays
   the art area — no CORS/canvas-taint issues with pfps.
   Art area in 300×470 logical px: left=8 top=38 w=284 h=185
══════════════════════════════════════════════════════ */
// Art area as % of card dimensions — used for img overlay positioning
/* ── NEW! Badge — shown on cards pulled for the first time ── */
function NewBadge({ size = "md" }) {
  const s = size === "sm";
  return (
    <div style={{
      position:"absolute",
      bottom: s ? 28 : 32,
      right: s ? 4 : 6,
      zIndex: 20,
      background:"#f472b6",
      color:"#000",
      fontFamily:"'DM Mono',monospace",
      fontSize: s ? 6 : 7.5,
      fontWeight: 500,
      letterSpacing: 1,
      padding: s ? "2px 5px" : "3px 7px",
      borderRadius: 3,
      pointerEvents: "none",
      boxShadow:"0 1px 6px rgba(244,114,182,0.5)",
      lineHeight: 1,
    }}>NEW!</div>
  );
}

const ART_LEFT_PCT   = (8   / 300) * 100;   // 2.667%
const ART_TOP_PCT    = (26  / 470) * 100;   // 5.5%
const ART_WIDTH_PCT  = (284 / 300) * 100;   // 94.667%
const ART_HEIGHT_PCT = (262 / 470) * 100;   // 55.7% — art starts at header bottom

/* CardFace — pure CSS card front, shared by CardCanvas (reveal) and FlippableCard (collection).
   Fonts are relative to dispW so they stay readable at every size. */
function CardFace({ card, dispW, holoPos={x:0.5,y:0.5}, holoActive=false, allowTilt=false }) {
  const r = RARITIES[card.rarity];
  const dispH = Math.round(dispW*(470/300));
  const isLR  = card.rarity === "LR";
  const serial = SERIAL_MAP[card.id];
  const fs = n => Math.round(dispW * n);
  // Real NFT name and collection from Alchemy (replaces FND #XXXXXX)
  const alchemyKey = card.collection && card.token_id ? `${card.collection}_${card.token_id}` : null;
  const nftMeta = useNFTMeta(alchemyKey);
  const displayName = nftMeta?.name || card.name;
  const displayCat  = nftMeta?.collection || nftMeta?.symbol || card.cat;

  // New layout — art fills most of card, no bio section
  // header: 26px | art: 332px | info: 68px | footer: 22px  (total ~448 / 470)
  // Legendary: full-art — art fills entire card, text overlays gradient at bottom
  const isFullArt = isLR;
  const HEADER_H = 26, FOOTER_H = 22;
  const ART_TOP   = isFullArt ? 0 : 26;
  const ART_H_PX  = isFullArt ? 470 : 262;
  const INFO_TOP_PCT = isFullArt ? "auto" : ((ART_TOP + ART_H_PX) / 470 * 100).toFixed(2) + "%";
  const ART_T = (ART_TOP / 470 * 100).toFixed(2) + "%";
  const ART_H_PCT = (ART_H_PX / 470 * 100).toFixed(2) + "%";
  const ART_L = isFullArt ? "0%" : (8/300*100).toFixed(2) + "%";
  const ART_W = isFullArt ? "100%" : (284/300*100).toFixed(2) + "%";

  return (
    <div style={{
      position:"relative", width:dispW, height:dispH, flexShrink:0,
      borderRadius:7, overflow:"hidden",
      background:"#080808",
      border:`1.5px solid ${r.color}`,
      boxShadow: isLR
        ? `0 0 0 0.5px ${r.color}30 inset, 0 4px 24px ${r.color}40`
        : `0 0 0 0.5px ${r.color}20 inset`,
    }}>
      {/* ── HOLOGRAPHIC EFFECTS ──
           LR  → original v30 holo (rainbow foil + sparkles + sweep, always-on animated)
           UR  → screen-blend sheen that follows mouse (invisible at rest)
           R/C → no effect */}
      {isLR && (
        <>
          {/* LR Layer 1: animated rainbow foil gradient */}
          <div style={{
            position:"absolute", inset:0, zIndex:4, pointerEvents:"none",
            borderRadius:7, mixBlendMode:"color-dodge",
            background:`linear-gradient(
              ${holoPos ? 125 + (holoPos.x - 0.5) * 80 : 125}deg,
              rgba(255,0,120,0.18) 0%, rgba(255,180,0,0.18) 18%,
              rgba(50,255,100,0.18) 36%, rgba(0,220,255,0.18) 54%,
              rgba(120,0,255,0.18) 72%, rgba(255,0,120,0.18) 90%)`,
            backgroundSize:"300% 300%",
            animation:"holoGradient 12s ease infinite",
          }}/>
          {/* LR Layer 2: sparkle dots */}
          <div style={{
            position:"absolute", inset:0, zIndex:5, pointerEvents:"none",
            borderRadius:7, mixBlendMode:"screen",
            background:`
              radial-gradient(circle at 18% 22%, rgba(255,255,255,0.28) 0%, transparent 2.5%),
              radial-gradient(circle at 72% 12%, rgba(255,255,255,0.22) 0%, transparent 1.8%),
              radial-gradient(circle at 50% 55%, rgba(255,255,255,0.25) 0%, transparent 2.0%),
              radial-gradient(circle at 28% 72%, rgba(255,255,255,0.18) 0%, transparent 1.5%),
              radial-gradient(circle at 82% 78%, rgba(255,255,255,0.28) 0%, transparent 2.2%)`,
            animation:"holoSparkle 2.4s ease-in-out infinite",
          }}/>
          {/* LR Layer 3: sweep shine */}
          <div style={{position:"absolute",inset:0,zIndex:6,pointerEvents:"none",borderRadius:7,overflow:"hidden"}}>
            <div style={{
              position:"absolute", top:0, bottom:0, width:"15%",
              background:"linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)",
              animation:"holoShine 3.5s ease-in-out infinite",
            }}/>
          </div>
        </>
      )}

      {/* R rarity: subtle metallic sheen on hover — directional stripe only, no point light */}
      {card.rarity === "R" && (
        <div style={{
          position:"absolute", inset:0, zIndex:4, pointerEvents:"none",
          borderRadius:7, overflow:"hidden",
          background:`linear-gradient(${(110 + holoPos.x*40).toFixed(0)}deg, transparent 25%, rgba(255,255,255,0.06) 45%, rgba(255,255,255,${holoActive?0.13:0.07}) 52%, rgba(255,255,255,0.06) 59%, transparent 75%)`,
          mixBlendMode:"screen",
          transition:"background 0.1s ease",
        }}/>
      )}

            {card.rarity === "UR" && (()=>{
        const px    = (holoPos.x * 100).toFixed(1);
        const py    = (holoPos.y * 100).toFixed(1);
        const angle = (110 + holoPos.x * 60 + holoPos.y * 20).toFixed(1);
        const bgX   = (40 + holoPos.x * 20).toFixed(1);
        const bgY   = (40 + holoPos.y * 20).toFixed(1);
        const op    = holoActive ? 1.0 : 0.45;  // visible at idle, brighter on hover
        const V="#c929f1",B="#0dbde9",G="#21e985",Y="#eedf10",R="#f80e35";
        return (
          <>
            {/* UR Layer 1: rainbow sheen */}
            <div style={{
              position:"absolute", inset:0, zIndex:4, pointerEvents:"none",
              borderRadius:7, overflow:"hidden",
              background:`linear-gradient(${angle}deg, ${V} 0%, ${B} 20%, ${G} 40%, ${Y} 60%, ${R} 80%, ${V} 100%)`,
              backgroundSize:"200% 200%",
              backgroundPosition:`${bgX}% ${bgY}%`,
              mixBlendMode:"screen",
              opacity: op * 0.20,
              transition:"opacity 0.35s ease",
            }}/>
            {/* UR Layer 2: glare spot */}
            <div style={{
              position:"absolute", inset:0, zIndex:5, pointerEvents:"none",
              borderRadius:7, overflow:"hidden",
              background:`radial-gradient(ellipse 55% 45% at ${px}% ${py}%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.15) 40%, transparent 75%)`,
              mixBlendMode:"screen",
              opacity: op * 0.32,
              transition:"opacity 0.35s ease, background 0.1s ease",
            }}/>
            {/* UR Layer 3: sparkles */}
            <div style={{
              position:"absolute", inset:0, zIndex:6, pointerEvents:"none",
              borderRadius:7, overflow:"hidden",
              background:`
                radial-gradient(circle at 20% 25%, rgba(255,255,255,0.9) 0%, transparent 1.2%),
                radial-gradient(circle at 75% 15%, rgba(255,255,255,0.7) 0%, transparent 0.9%),
                radial-gradient(circle at 50% 52%, rgba(255,255,255,0.8) 0%, transparent 1.0%),
                radial-gradient(circle at 30% 70%, rgba(255,255,255,0.6) 0%, transparent 0.8%),
                radial-gradient(circle at 80% 75%, rgba(255,255,255,0.85) 0%, transparent 1.1%)`,
              mixBlendMode:"screen",
              opacity: op * 0.35,
              transition:"opacity 0.35s ease",
            }}/>
            {/* UR art area: neutral veil that mutes holo reflectivity on the pfp.
                Normal blend so it just dims, doesn't interact with holo layers above. */}
            <div style={{
              position:"absolute",
              left:ART_L, top:ART_T, width:ART_W, height:ART_H_PCT,
              zIndex:9, pointerEvents:"none",
              background:"rgba(10,10,10,0.38)",
              mixBlendMode:"normal",
              opacity: op,
              transition:"opacity 0.35s ease",
            }}/>
          </>
        );
      })()}

      {/* Inner border */}
      <div style={{position:"absolute",inset:4,borderRadius:5,pointerEvents:"none",border:`0.5px solid ${r.color}30`,zIndex:14}}/>

      {/* LR logo overlay — top-left corner with gradient for readability */}
      {isLR && (<>
        {/* Radial gradient in top-left to darken art behind logo */}
        <div style={{
          position:"absolute", top:0, left:0, zIndex:19, pointerEvents:"none",
          width:"65%", height:"30%",
          background:"radial-gradient(ellipse at 0% 0%, rgba(0,0,0,0.55) 0%, transparent 70%)",
          borderTopLeftRadius:7,
        }}/>
        <div style={{
          position:"absolute", top:fs(.035), left:fs(.035), zIndex:20,
          pointerEvents:"none",
        }}>
          <img
            src={`data:image/svg+xml;base64,${LOGO_FULL_B64}`}
            alt="networked.cards"
            style={{
              height: fs(.115), width:"auto",
              opacity:0.92,
              filter:"brightness(0) invert(1) drop-shadow(0 1px 4px rgba(0,0,0,0.6))",
            }}
          />
        </div>
      </>)}

      {/* Header — hidden for full-art LR */}
      {!isFullArt && <div style={{
        position:"absolute", top:0, left:0, right:0,
        height:(HEADER_H/470*100).toFixed(1)+"%",
        background:r.color+"22", borderBottom:`0.5px solid ${r.color}30`,
        display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:`0 ${fs(.04)}px`, zIndex:15,
      }}>
        <span style={{fontFamily:"'DM Mono',monospace",fontSize:fs(.042),color:r.color+"99"}}>
          {serial ? `#${String(serial).padStart(3,"0")}` : "·"}
        </span>
        <span style={{fontFamily:"'DM Mono',monospace",fontSize:fs(.042),color:r.accent,letterSpacing:.5}}>{r.name.toUpperCase()}</span>
      </div>}

      {/* Art background */}
      <div style={{position:"absolute",left:ART_L,top:ART_T,width:ART_W,height:ART_H_PCT,background:"#0d0d0d",zIndex:0}}/>

      {/* Art */}
      <div style={{position:"absolute",left:ART_L,top:ART_T,width:ART_W,height:ART_H_PCT,overflow:"hidden",zIndex:1}}>
        <CardImage card={card} style={{width:"100%",height:"100%",objectFit:"cover",objectPosition:"center 15%",display:"block"}} />
      </div>
      {/* UR: semi-opaque copy above holo layers */}
      {card.rarity === "UR" && (
        <div style={{position:"absolute",left:ART_L,top:ART_T,width:ART_W,height:ART_H_PCT,overflow:"hidden",zIndex:9,pointerEvents:"none"}}>
          <CardImage card={card} style={{width:"100%",height:"100%",objectFit:"cover",objectPosition:"center 15%",display:"block",opacity:0.72}} />
        </div>
      )}
      {/* Gradient overlay at bottom of art for readability */}
      <div style={{
        position:"absolute", left:ART_L, width:ART_W,
        top: isFullArt ? "40%" : `calc(${ART_T} + ${ART_H_PCT} - 32%)`,
        height: isFullArt ? "60%" : "32%",
        background: isFullArt
          ? "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.45) 35%, rgba(0,0,0,0.82) 65%, rgba(0,0,0,0.93) 100%)"
          : "linear-gradient(to bottom, transparent, rgba(8,8,8,0.85))",
        zIndex:12, pointerEvents:"none",
      }}/>

      {/* Info strip — handle, name, cat — with breathing room */}
      <div style={{
        position:"absolute", left:"5%", right:"5%",
        top: isFullArt ? "auto" : INFO_TOP_PCT,
        bottom: isFullArt ? "4%" : (FOOTER_H/470*100+0.5).toFixed(1)+"%",
        zIndex:13, display:"flex", flexDirection:"column",
        justifyContent: isFullArt ? "flex-end" : "center",
        gap:fs(.022),
        paddingBottom: isFullArt ? fs(.03) : 0,
        paddingTop: isFullArt ? 0 : fs(.03),
      }}>
        {card.handle && <div style={{fontFamily:"'DM Mono',monospace",fontSize:fs(.044),color:r.accent,letterSpacing:.3,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{card.handle}</div>}
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:fs(.068),color:"#e8e8e8",fontWeight:500,lineHeight:1.15,overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>{displayName}</div>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:fs(.036),color:"#555",letterSpacing:.4}}>{displayCat.toUpperCase()}</div>
      </div>

      {/* Footer — hidden for full-art LR */}
      {!isFullArt && <div style={{
        position:"absolute", bottom:0, left:0, right:0,
        height:(FOOTER_H/470*100).toFixed(1)+"%",
        background:r.color+"22", zIndex:15,
        display:"flex", alignItems:"center", justifyContent:"center",
      }}>
        <span style={{fontFamily:"'DM Mono',monospace",fontSize:fs(.044),color:r.accent,letterSpacing:.5}}>◆ {r.name.toUpperCase()}  ·  networked.cards</span>
      </div>}
    </div>
  );
}

/* CardCanvas — used during pack reveal. Wraps CardFace (CSS, scales perfectly). */
function CardCanvas({ card, dispW=148, tilt={x:0,y:0} }) {
  // Animate holoPos during reveal — overridden by tilt when user interacts
  const [holoPos, setHoloPos] = useState({ x:0.5, y:0.5 });
  const animRef = useRef(null);
  const tiltActive = Math.abs(tilt.x) > 0.5 || Math.abs(tilt.y) > 0.5;
  useEffect(() => {
    if (tiltActive) {
      cancelAnimationFrame(animRef.current);
      // Map tilt degrees (-28..28) to 0..1 holoPos
      setHoloPos({
        x: Math.max(0, Math.min(1, 0.5 + tilt.y / 56)),
        y: Math.max(0, Math.min(1, 0.5 + tilt.x / 56)),
      });
      return;
    }
    let t = 0;
    const tick = () => {
      t += 0.018;
      setHoloPos({ x: 0.5 + Math.sin(t) * 0.4, y: 0.5 + Math.cos(t * 0.7) * 0.35 });
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [tiltActive, tilt.x, tilt.y]);
  return <CardFace card={card} dispW={dispW} holoPos={holoPos} holoActive={true}/>;
}

/* ══════════════════════════════════════════════════════
   FLIPPABLE CARD  (Collection view)
══════════════════════════════════════════════════════ */
function FlippableCard({ card, dispW=120, noFlipOnClick=false, allowTilt=false }) {
  const [flipped, setFlipped] = useState(false);
  const [holoPos, setHoloPos] = useState({ x:0.5, y:0.5 });
  const [holoTilt, setHoloTilt] = useState({ rx:0, ry:0 });
  const [holoActive, setHoloActive] = useState(false);  // drives --card-opacity
  const touchX  = useRef(null);
  const touchPos = useRef(null);
  const cardRef = useRef(null);
  const r = RARITIES[card.rarity];
  const dispH = Math.round(dispW*(470/300));
  const isLR = card.rarity === "LR";
  const twitterUrl = `https://etherscan.io/address/${card.creator || card.collection}`;
  const serial = SERIAL_MAP[card.id];

  // Track pointer for ALL cards — holo intensity set in CardFace by rarity
  const onPointerMove = useCallback(e => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height));
    setHoloPos({ x, y });
    setHoloActive(true);
    setHoloTilt({ rx:(y-0.5)*-16, ry:(x-0.5)*16 });
  }, [isLR, allowTilt]);

  const onPointerLeave = useCallback(() => {
    setHoloPos({ x:0.5, y:0.5 });
    setHoloTilt({ rx:0, ry:0 });
    setHoloActive(false);
  }, []);





  const onTouchMoveHolo = useCallback(e => {
    if (!cardRef.current) return;
    const t = e.touches[0];
    const rect = cardRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (t.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (t.clientY - rect.top)  / rect.height));
    setHoloPos({ x, y });
    setHoloTilt({ rx:(y-0.5)*-10, ry:(x-0.5)*10 });
    setHoloActive(true);
  }, []);



  // Card dimensions in %
  const ART_T = (38/470*100).toFixed(2) + "%";
  const ART_H = (250/470*100).toFixed(2) + "%";
  const ART_L = (8/300*100).toFixed(2)  + "%";
  const ART_W = (284/300*100).toFixed(2) + "%";

  const fontSize = n => Math.round(dispW * n);

  return (
    <div
      ref={cardRef}
      onClick={() => { if (!noFlipOnClick) setFlipped(p=>!p); }}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onTouchMove={onTouchMoveHolo}
      onTouchStart={e => {
        touchX.current = e.touches[0].clientX;
        touchPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }}
      onTouchEnd={e => {
        if (touchX.current===null) return;
        if (!noFlipOnClick && Math.abs(e.changedTouches[0].clientX-touchX.current)>24) setFlipped(p=>!p);
        touchX.current=null;
        onPointerLeave();
      }}
      style={{
        width:dispW, height:dispH, perspective:900, cursor:"pointer",
        flexShrink:0, userSelect:"none", WebkitUserSelect:"none",
        willChange: "transform",
      }}
    >
      <div style={{
        width:"100%", height:"100%", position:"relative",
        transformStyle:"preserve-3d",
        transition: flipped
          ? `transform ${holoTilt.rx===0&&holoTilt.ry===0 ? "0.42s cubic-bezier(.4,0,.2,1)" : "0.08s ease"}`
          : `transform ${holoTilt.rx===0&&holoTilt.ry===0 ? "0.4s" : "0.08s"} ease`,
        transform: flipped
          ? `perspective(600px) rotateX(${holoTilt.rx}deg) rotateY(${180 + holoTilt.ry}deg)`
          : `perspective(600px) rotateX(${holoTilt.rx}deg) rotateY(${holoTilt.ry}deg)`,
      }}>

        {/* ── FRONT FACE — CardFace shared component ── */}
        <div style={{
          position:"absolute", top:0, left:0, width:"100%", height:"100%",
          backfaceVisibility:"hidden", WebkitBackfaceVisibility:"hidden",
          transform:"rotateY(0deg)",  // explicit — forces Safari GPU compositing
        }}>
          <CardFace card={card} dispW={dispW} holoPos={holoPos} holoActive={holoActive} allowTilt={allowTilt}/>
        </div>

        {/* ── BACK FACE ── */}
        <div style={{
          position:"absolute", top:0, left:0, width:"100%", height:"100%",
          backfaceVisibility:"hidden", WebkitBackfaceVisibility:"hidden",
          transform:"rotateY(180deg)",
          background: r.color + "cc", border:"3px solid rgba(255,255,255,0.55)", borderRadius:7,
          display:"flex", flexDirection:"column",
          alignItems:"center", justifyContent:"space-between", gap:0, padding:10,
          paddingTop: Math.round(dispW * 0.1),
          paddingBottom: Math.round(dispW * 0.08),
        }}>
          {/* Logo with AnimatedEye overlaid on its eye — same as pack */}
          <img
              src={`data:image/svg+xml;base64,${LOGO_B64}`}
              alt="networked.cards"
              style={{width: Math.round(dispW * 0.72), height:"auto", opacity:0.85, filter:"brightness(0) invert(1)"}}
            />
          <div style={{textAlign:"center",width:"100%",padding:"0 6px"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:fontSize(.065),color:"rgba(255,255,255,0.7)",letterSpacing:.5,marginBottom:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.name.toUpperCase()}</div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:fontSize(.085),color:"rgba(255,255,255,0.92)",fontWeight:500,lineHeight:1.3,wordBreak:"break-word"}}>{card.name}</div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:fontSize(.06),color:"rgba(255,255,255,0.55)",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{card.cat}</div>
          </div>
          <div style={{width:"60%",height:1,background:"rgba(255,255,255,0.2)",flexShrink:0}}/>
          {card.handle ? (
            <a href={twitterUrl} target="_blank" rel="noopener noreferrer"
              onClick={e=>e.stopPropagation()}
              style={{
                fontFamily:"'DM Mono',monospace",fontSize:fontSize(.065),color:"rgba(255,255,255,0.85)",
                letterSpacing:.5,textDecoration:"none",border:"1px solid rgba(255,255,255,0.3)",
                borderRadius:4,padding:"4px 8px",background:"rgba(255,255,255,0.1)",
                textAlign:"center",transition:"background .15s",
                whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:"90%",
              }}
              onMouseEnter={e=>{e.currentTarget.style.background='rgba(255,255,255,0.2)';}}
              onMouseLeave={e=>{e.currentTarget.style.background='rgba(255,255,255,0.1)';}}
            >{card.handle} ↗</a>
          ) : (
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:fontSize(.065),color:"rgba(255,255,255,0.3)",
              letterSpacing:.5,fontStyle:"italic"}}>???</div>
          )}
        </div>
      </div>
    </div>
  );
}


function SwipeableCardStack({ cards, onComplete, cardWidth=200, ownedIds=new Set(), renderCard=null, onSwipe=null, hideHint=false, maxTilt=28 }) {
  const CARD_H     = Math.round(cardWidth*(470/300));
  const DEPTH_SHOW = 3;
  const THROW_PX   = 70;

  const [topIdx,   setTopIdx]   = useState(0);
  const [pos,      setPos]      = useState({ x:0, y:0 });
  const [dragging, setDragging] = useState(false);
  const [flying,   setFlying]   = useState(null);
  const [tilt,     setTilt]     = useState({ x:0, y:0 });

  const startRef   = useRef(null);
  const topRef     = useRef(null);
  const stackRef   = useRef(null);
  const doneRef    = useRef(false);
  const draggingRef = useRef(false);

  // Register non-passive touchmove on the stack so we can preventDefault reliably
  useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const block = e => { if (draggingRef.current) e.preventDefault(); };
    el.addEventListener("touchmove", block, { passive: false });
    return () => el.removeEventListener("touchmove", block);
  }, []); // mirror for use in touch handlers

  const remaining = cards.length - topIdx;

  // ── Desktop tilt — activates only on card entry, stays until DEADZONE exceeded ──
  const tiltActiveRef = useRef(false);
  const DEADZONE = 80; // px outside card before tilt disengages
  useEffect(() => {
    const onMove = e => {
      if (e.pointerType === "touch") return;
      if (draggingRef.current || !stackRef.current) return;
      const r = stackRef.current.getBoundingClientRect();
      const inCard = e.clientX >= r.left && e.clientX <= r.right &&
                     e.clientY >= r.top  && e.clientY <= r.bottom;
      if (inCard) tiltActiveRef.current = true;
      if (!tiltActiveRef.current) return; // never entered card yet
      const cx = r.left + r.width  / 2;
      const cy = r.top  + r.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const outsideX = Math.max(0, Math.abs(dx) - r.width  / 2);
      const outsideY = Math.max(0, Math.abs(dy) - r.height / 2);
      if (outsideX > DEADZONE || outsideY > DEADZONE) {
        tiltActiveRef.current = false;
        setTilt({ x:0, y:0 });
        return;
      }
      const nx = Math.max(-1, Math.min(1, dx / (r.width  / 2)));
      const ny = Math.max(-1, Math.min(1, dy / (r.height / 2)));
      setTilt({ x: ny * -maxTilt, y: nx * maxTilt });
    };
    document.addEventListener("pointermove", onMove);
    return () => document.removeEventListener("pointermove", onMove);
  }, [flying]);

  // ── Swipe handlers (pointer events for both desktop + mobile) ──
  const downClientX = useRef(0);
  const onDown = useCallback(e => {
    if (flying || remaining === 0) return;
    e.preventDefault();
    if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId);
    startRef.current = { x: e.clientX, y: e.clientY };
    downClientX.current = e.clientX;
    draggingRef.current = true;
    setDragging(true);
    setTilt({ x:0, y:0 });
    setPos({ x:0, y:0 });
  }, [flying, remaining]);

  const onMove = useCallback(e => {
    if (!draggingRef.current || !startRef.current) return;
    e.preventDefault();
    setPos({ x: e.clientX - startRef.current.x, y: e.clientY - startRef.current.y });
  }, []);

  const onUp = useCallback(e => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    const { x, y } = pos;
    const dist = Math.sqrt(x*x + y*y);
    if (dist >= THROW_PX) {
      // Full swipe — throw in direction of gesture
      const factor = Math.max(900, dist * 4.5) / dist;
      setFlying({ x: x * factor, y: y * factor });
    } else if (dist < 8) {
      // Tap — direction based on which half of card was tapped
      const goRight = downClientX.current >= (stackRef.current?.getBoundingClientRect().left || 0) + cardWidth/2;
      const dx = goRight ? 60 : -60;
      setPos({ x: dx, y: -12 });
      setTimeout(() => setFlying({ x: goRight ? 1000 : -1000, y: -80 }), 110);
    } else {
      // Partial drag — snap back
      setPos({ x:0, y:0 });
    }
  }, [pos]);

  // ── Mobile gyroscope tilt — direct listener ──
  const gyroBaseRef = useRef(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    if (!getGyroEnabled()) return;
    gyroBaseRef.current = null; // recalibrate on mount
    const onGyro = e => {
      try { if (localStorage.getItem(GYRO_OFF_KEY)==="1") return; } catch {}
      if (draggingRef.current) return;
      const b = e.beta ?? 0, g = e.gamma ?? 0;
      if (!gyroBaseRef.current) gyroBaseRef.current = { b, g };
      const db = b - gyroBaseRef.current.b, dg = g - gyroBaseRef.current.g;
      const MAX = maxTilt;
      setTilt({ x: Math.max(-MAX,Math.min(MAX,db))*-0.9, y: Math.max(-MAX,Math.min(MAX,dg))*0.9 });
    };
    window.addEventListener("deviceorientation", onGyro);
    return () => window.removeEventListener("deviceorientation", onGyro);
  }, [maxTilt]);

  const onTransitionEnd = useCallback(e => {
    if (!flying || e.propertyName !== "transform") return;
    const swipeDir = flying.x > 0 ? "right" : "left";
    if (onSwipe) onSwipe(cards[topIdx], swipeDir);
    const next = topIdx + 1;
    setTopIdx(next);
    setFlying(null);
    setPos({ x:0, y:0 });
    if (next >= cards.length && !doneRef.current) {
      doneRef.current = true;
      onComplete(cards);
    }
  }, [flying, topIdx, cards, onComplete, onSwipe]);

  /* Build visible card list: depth 0 = top, 1..DEPTH_SHOW = behind.
     Render back-to-front so z-index stacking is correct. */
  const slots = [];
  for (let d = Math.min(DEPTH_SHOW, remaining - 1); d >= 0; d--) {
    const idx = topIdx + d;
    if (idx < cards.length) slots.push({ card: cards[idx], depth: d });
  }

  const tiltResting = tilt.x === 0 && tilt.y === 0;

  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:12 }}>

      {/* Stack wrapper: handles tilt on desktop+mobile, blocks page scroll */}
      <div
        ref={stackRef}
        style={{
          perspective: 440,
          width: cardWidth, height: CARD_H + DEPTH_SHOW*8,
          WebkitUserSelect:"none", userSelect:"none",
          touchAction: "none",  // block ALL browser touch gestures on stack
        }}
      >
        {/* Tilt wrapper — applies 3D tilt to the whole stack */}
        <div style={{
          width:"100%", height:"100%",
          position:"relative",
          transform: dragging || flying
            ? "none"
            : `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
          transition: tiltResting
            ? "transform 0.9s cubic-bezier(.25,.46,.45,.94)"
            : "transform 0.07s linear",
          transformStyle: "preserve-3d",
          willChange: "transform",
        }}>
        {slots.map(({ card, depth }) => {
          const isTop = depth === 0;
          // Behind cards sit behind in Z — perspective + tilt reveals their edges naturally.
          const leftOff = 0;
          const topOff  = 0;

          return (
            <div
              key={card._uid || card.id}
              ref={isTop ? topRef : null}
              onPointerDown={isTop ? onDown  : undefined}
              onPointerMove={isTop ? onMove  : undefined}
              onPointerUp={isTop   ? onUp    : undefined}
              onPointerCancel={isTop ? onUp  : undefined}
              onTransitionEnd={isTop ? onTransitionEnd : undefined}
              style={{
                position:"absolute", left: isTop ? 0 : leftOff, top: isTop ? 0 : topOff,
                width:cardWidth, height:CARD_H,
                zIndex: DEPTH_SHOW + 2 - depth,
                cursor: isTop ? (dragging ? "grabbing" : "grab") : "default",
                touchAction: "none",  // always none — wrapper also blocks
                userSelect: "none",
                pointerEvents: isTop ? "auto" : "none",
                willChange: "transform",
                transformOrigin: "50% 50%",
                transform: isTop
                  ? flying
                    ? `translateZ(0px) translate(${flying.x}px,${flying.y}px) rotate(${flying.x*0.042}deg)`
                    : `translateZ(0px) translate(${pos.x}px,${pos.y}px) rotate(${pos.x*0.07}deg)`
                  : `translateZ(${-depth * 30}px)`,
                transition: isTop
                  ? flying
                    ? "transform 0.42s cubic-bezier(.18,.68,.32,1.04), opacity 0.34s ease"
                    : dragging ? "none" : "transform 0.2s ease"
                  : "transform 0.4s cubic-bezier(.2,.8,.3,1), left 0.12s ease, top 0.12s ease, opacity 0.34s ease",
                opacity: isTop ? (flying ? 0 : 1) : 1,
                boxShadow: isTop
                  ? dragging
                    ? `0 ${20+Math.abs(pos.y*0.07)}px 44px rgba(0,0,0,0.75), 0 0 0 1px #222`
                    : "0 8px 26px rgba(0,0,0,0.5), 0 0 0 1px #1a1a1a"
                  : `0 ${2+depth}px ${4+depth*2}px rgba(0,0,0,0.5)`,
              }}
            >
              {renderCard ? renderCard(card) : <CardCanvas card={card} dispW={cardWidth} tilt={isTop ? tilt : {x:0,y:0}}/>}
              {isTop && !ownedIds.has(card.id) && card._uid && (
                <NewBadge size="md"/>
              )}
            </div>
          );
        })}
        </div>
      </div>

      {/* Counter + hint */}
      {!hideHint && (
        <div style={{ textAlign:"center" }}>
          <div style={{ fontSize:8, color:"#333", letterSpacing:2 }}>
            {remaining > 0 && cards.length > 1 ? `${topIdx + 1} / ${cards.length}` : ""}
          </div>
          {remaining > 0 && cards.length > 1 && (
            <div style={{ fontSize:7, color:"#252525", letterSpacing:1, marginTop:2 }}>
              swipe left · right · up
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* Pack visual */

/* ══════════════════════════════════════════════════════════════════
   PACK VISUAL — Pure CSS 3D booster pack
   Same aspect ratio as cards (300:470). No canvas needed.

   TO ADD CUSTOM PACK GRAPHICS:
   ─ PACK_STANDARD_IMAGE  : set to a base64 data URI string (null = procedural)
   ─ PACK_PITY_IMAGES     : push base64 strings into the array (random rotation)
   The image fills the pack face behind all overlays.
══════════════════════════════════════════════════════════════════ */
/* ── AnimatedEye — interactive eye that follows mouse/touch and blinks ──
   Draws the same lens shape as LOGO_ICON_B64 but with a movable iris + blinking lids.
   cx/cy: normalized 0-1 pointer position (passed from PackVisual tilt state) */
function AnimatedEye({ opacity=0.55, size=52, special=false, bgColor=null }) {
  const [pos, setPos]           = useState({ x:0.5, y:0.5 });
  const [lidScale, setLidScale] = useState(1);
  const timerRef = useRef(null);

  useEffect(() => {
    const isMobile = window.matchMedia("(pointer: coarse)").matches;
    if (isMobile) {
      // On mobile use gyroscope — maps tilt to eye position
      let base = null;
      const onGyro = e => {
        try { if (localStorage.getItem(GYRO_OFF_KEY)==="1") return; } catch {}
        const b = e.beta ?? 0, g = e.gamma ?? 0;
        if (!base) base = { b, g };
        const db = Math.max(-20, Math.min(20, b - base.b));
        const dg = Math.max(-20, Math.min(20, g - base.g));
        setPos({ x: Math.max(0,Math.min(1, 0.5 - dg/56)), y: Math.max(0,Math.min(1, 0.5 - db/56)) });
      };
      window.addEventListener("deviceorientation", onGyro);
      return () => window.removeEventListener("deviceorientation", onGyro);
    } else {
      const onMove = e => {
        const cx = e.clientX / window.innerWidth;
        const cy = e.clientY / window.innerHeight;
        setPos({ x: Math.max(0,Math.min(1,cx)), y: Math.max(0,Math.min(1,cy)) });
      };
      window.addEventListener("mousemove", onMove, { passive:true });
      return () => window.removeEventListener("mousemove", onMove);
    }
  }, []);

  useEffect(() => {
    const blink = cb => { setLidScale(0.04); setTimeout(() => { setLidScale(1); cb?.(); }, 150); };
    const schedule = () => {
      timerRef.current = setTimeout(() => {
        Math.random() < 0.25 ? blink(() => setTimeout(() => blink(schedule), 220)) : blink(schedule);
      }, 2800 + Math.random() * 4800);
    };
    schedule();
    return () => clearTimeout(timerRef.current);
  }, []);

  // viewBox 97.68 × 74.14
  // Iris hole center: 49.11, 37.06  r ≈ 21.92
  // White dot original position: 40.69, 26.13  r = 5.75
  const VW = 97.68, VH = 74.14;
  const IC_X = 49.11, IC_Y = 37.06, IC_R = 21.92;
  const holeR = IC_R; // dark circle same size as the inner circle

  // Dark circle moves, constrained to stay mostly inside the almond
  const maxT = 8;
  const rawDX = (pos.x - 0.5) * maxT * 2;
  const rawDY = (pos.y - 0.5) * maxT * 1.3;
  const n = Math.sqrt((rawDX/maxT)**2 + (rawDY/(maxT*0.65))**2);
  const sc = n > 1 ? 1/n : 1;
  const holeX = IC_X + rawDX * sc;
  const holeY = IC_Y + rawDY * sc;

  // White dot: original position, tiny drift
  const dotX = 40.69 + (pos.x - 0.5) * 1.5;
  const dotY = 26.13 + (pos.y - 0.5) * 1.0;

  const eyeBg = bgColor || (special ? "#0e0900" : "#0b0b0b");
  const isCutout = bgColor === "cutout";
  // Unique mask ID per instance to avoid SVG conflicts
  const maskId = useRef(`em_${Math.random().toString(36).slice(2,7)}`).current;

  return (
    <svg width={size} height={Math.round(size*VH/VW)} viewBox={`0 0 ${VW} ${VH}`}
      xmlns="http://www.w3.org/2000/svg" style={{ display:"block", overflow:"visible", opacity }}>

      {isCutout && (
        <defs>
          {/* Mask: white = show, black = transparent (punches hole at iris position) */}
          <mask id={maskId}>
            <rect width={VW} height={VH} fill="white"/>
            <circle cx={holeX} cy={holeY} r={holeR} fill="black"
              style={{ transition:"cx 0.13s ease, cy 0.13s ease" }}/>
          </mask>
        </defs>
      )}

      <g transform={`translate(0,${VH/2}) scale(1,${lidScale}) translate(0,${-VH/2})`}
         style={{ transition: lidScale<1 ? "transform 0.07s ease-in" : "transform 0.13s ease-out" }}>

        {/* 1. WHITE ALMOND — masked to punch iris hole when cutout mode */}
        <path fill="#ffffff"
          mask={isCutout ? `url(#${maskId})` : undefined}
          d="M76.31,12.29C59.82-4.44,38.46-4.07,22,13.28L0,36.8,18.46,58.41c18,21.42,43.4,20.93,61.24-1.3l18-22.6-.32-.86Z"/>

        {/* 2. DARK CIRCLE — only when not cutout */}
        {!isCutout && (
          <circle
            cx={holeX} cy={holeY} r={holeR}
            fill={eyeBg}
            style={{ transition:"cx 0.13s ease, cy 0.13s ease" }}
          />
        )}

        {/* 3. WHITE DOT */}
        <circle
          cx={holeX - 8.42} cy={holeY - 10.93} r={5.75}
          fill="#ffffff"
          style={{ transition:"cx 0.13s ease, cy 0.13s ease" }}
        />
      </g>
    </svg>
  );
}




function PackVisual({ special, phase, onAnimEnd, colorIdx=0 }) {
  // Same ratio as cards: 300:470
  const PACK_W = 203;
  const PACK_H = Math.round(PACK_W * (470 / 300));

  const [tilt, setTilt] = useState({ x:0, y:0 });
  const hitRef  = useRef(null);
  const animRef = useRef(null);
  // Normalized 0-1 position for holo sheen
  const packHoloX = 0.5 + tilt.y / 36;
  const packHoloY = 0.5 + tilt.x / -36;

  const handleMove = useCallback((clientX, clientY) => {
    if (phase !== "idle" || !hitRef.current) return;
    const r = hitRef.current.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const ny = Math.max(0, Math.min(1, (clientY - r.top)  / r.height));
    setTilt({ x: (ny - 0.5) * -18, y: (nx - 0.5) * 18 });
  }, [phase]);

  const onPointerMove  = useCallback(e => handleMove(e.clientX, e.clientY), [handleMove]);
  const onPointerLeave = useCallback(() => { setTilt({ x:0, y:0 }); }, []);
  const onTouchMove    = useCallback(e => { e.preventDefault(); handleMove(e.touches[0].clientX, e.touches[0].clientY); }, [handleMove]);
  const onTouchEnd     = useCallback(() => { setTilt({ x:0, y:0 }); }, []);

  // Mobile gyroscope tilt for pack
  useEffect(() => {
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    if (!getGyroEnabled()) return;
    let base = null;
    const onGyro = e => {
      const b = e.beta ?? 0, g = e.gamma ?? 0;
      if (!base) base = { b, g };
      const db = Math.max(-22, Math.min(22, b - base.b));
      const dg = Math.max(-22, Math.min(22, g - base.g));
      setTilt({ x: db * -0.5, y: dg * 0.5 });
    };
    window.addEventListener("deviceorientation", onGyro);
    return () => window.removeEventListener("deviceorientation", onGyro);
  }, []);

  const resting = tilt.x === 0 && tilt.y === 0;
  // Specular position derived from surface normal (light fixed above-center)
  const specX = 50 - tilt.y * 1.6;
  const specY = 28 + tilt.x * 1.6;

  const c  = special ? "#b45309" : "#ffffff";
  const ac = special ? "#fbbf24" : "#aaa";
  // 4 rotating solid colors for standard pack — bold, stylish
  const PACK_PALETTE = ['#2a3daa','#aa2a2a','#1a6b35','#6b1a8a'];
  const bg = special ? "#0e0900" : PACK_PALETTE[colorIdx];

  const anim = {
    idle:    "packFloat 3s ease-in-out infinite",
    shaking: "packShake 0.6s ease",
    burst:   "packBurst 0.4s ease forwards",
  }[phase] || "none";

  return (
    <div
      ref={hitRef}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      style={{ perspective: 700, width: PACK_W, height: PACK_H, cursor: "pointer" }}
    >
      {/* Tilt wrapper — transform only, no animation */}
      <div style={{
        width: "100%", height: "100%",
        transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
        transition: resting ? "transform 0.5s cubic-bezier(.2,.8,.3,1)" : "transform 0.06s linear",
        willChange: "transform",
      }}>
        {/* Animation wrapper — animation only, no transform */}
        <div
          ref={animRef}
          onAnimationEnd={() => onAnimEnd(phase)}
          style={{
            position: "relative", width: "100%", height: "100%",
            animation: anim,
            borderRadius: 10,
            boxShadow: special
              ? `0 0 0 1.5px ${ac}70, 0 14px 40px rgba(180,83,9,0.4), 0 3px 8px rgba(0,0,0,0.8)`
              : `0 0 0 1.5px #ffffff44, 0 14px 40px rgba(0,0,0,0.55), 0 3px 8px rgba(0,0,0,0.6)`,
          }}
        >
          {/* ── BASE LAYER: background colour or lucky image ── */}
          <div style={{
            position: "absolute", inset: 0, borderRadius: 10,
            overflow: "hidden", background: bg,
          }}>
            {/* Lucky pack: custom illustration fills the whole face */}
            {special && LUCKY_PACK_BG_B64 && (
              <img
                src={LUCKY_PACK_BG_B64}
                alt=""
                style={{
                  position: "absolute", inset: 0,
                  width: "100%", height: "100%",
                  objectFit: "cover", objectPosition: "center",
                }}
              />
            )}
          </div>

          {/* ── BORDER ── */}
          <div style={{
            position: "absolute", inset: 1, borderRadius: 9,
            border: `1.5px solid ${c}`,
            pointerEvents: "none",
          }}/>
          <div style={{
            position: "absolute", inset: 5, borderRadius: 6,
            border: `0.5px solid ${c}28`,
            pointerEvents: "none",
          }}/>

          {/* Holo sheen — follows pointer */}
          <div style={{
            position:"absolute", inset:0, zIndex:18, pointerEvents:"none", borderRadius:6,
            background:`linear-gradient(${Math.round(125 + (packHoloX-0.5)*80)}deg, transparent 25%, rgba(255,255,255,0.05) 45%, rgba(255,255,255,0.10) 52%, rgba(255,255,255,0.05) 59%, transparent 75%)`,
            mixBlendMode:"screen",
          }}/>
          <div style={{
            position:"absolute", inset:0, zIndex:17, pointerEvents:"none", borderRadius:6,
            background:`radial-gradient(ellipse 55% 45% at ${Math.round(packHoloX*100)}% ${Math.round(packHoloY*100)}%, rgba(255,255,255,0.09) 0%, transparent 70%)`,
          }}/>
          {/* Lucky pack: gradient — bright art top, dark for text bottom */}
          {special && (
            <div style={{
              position: "absolute", inset: 0, borderRadius: 10,
              background: "linear-gradient(to bottom, transparent 0%, transparent 40%, rgba(0,0,0,0.65) 62%, rgba(0,0,0,0.88) 78%, rgba(0,0,0,0.97) 100%)",
              pointerEvents: "none",
            }}/>
          )}

          {/* ── PACK CONTENT — mirrors SVG layout ── */}
          <div style={{ position:"absolute", inset:0 }}>

            {/* Logo + AnimatedEye — standard: large top center; lucky: no logo/eye, clean artwork */}
            {special ? null : (
              <>
                {/* Standard: logo centered vertically */}
                <div style={{
                  position:"absolute", top:0, left:0, right:0, bottom:0,
                  display:"flex", flexDirection:"column",
                  alignItems:"center", justifyContent:"center", gap:0,
                }}>
                  <img
                    src={`data:image/svg+xml;base64,${LOGO_B64}`}
                    alt="networked.cards"
                    style={{
                      width: Math.round(PACK_W * 0.72),
                      height: "auto",
                      opacity: 0.9,
                    }}
                  />
                </div>
              </>
            )}

            {/* Pack label — standard: centered, lucky: bottom */}
            {special ? (
              <div style={{
                position:"absolute", bottom:"16%", left:0, right:0,
                textAlign:"center", fontFamily:"'DM Mono',monospace",
                lineHeight: 1.9,
              }}>
                <div style={{
                  fontSize: Math.round(PACK_W * 0.062),
                  letterSpacing: 2,
                  color: "rgba(255,255,255,0.95)",
                  textShadow: "0 1px 10px rgba(0,0,0,1)",
                }}>lucky pack</div>
                <div style={{
                  fontSize: Math.round(PACK_W * 0.042),
                  color:"rgba(255,255,255,0.80)",
                  letterSpacing: 0.5,
                  textShadow:"0 1px 6px rgba(0,0,0,1)",
                }}>artwork by @sorrisopng</div>
              </div>
            ) : (
              <div style={{
                position:"absolute", bottom:"8%", left:0, right:0,
                textAlign:"center", fontFamily:"'DM Mono',monospace",
                lineHeight: 1.75,
              }}>
                <div style={{
                  fontSize: Math.round(PACK_W * 0.052),
                  letterSpacing: 1,
                  color: "rgba(255,255,255,0.28)",
                }}>standard pack</div>
                <div style={{
                  fontSize: Math.round(PACK_W * 0.040),
                  color: "rgba(255,255,255,0.16)",
                  letterSpacing: 0.5,
                }}>x5 cards</div>
              </div>
            )}

            
          </div>

          {/* ── LIGHTING — physics-based specular + ambient ── */}
          <div style={{
            position: "absolute", inset: 0, borderRadius: 10, pointerEvents: "none",
            background: `radial-gradient(ellipse 55% 38% at ${specX}% ${specY}%,
              rgba(255,255,255,0.022) 0%,
              rgba(255,255,255,0.005) 55%,
              transparent 80%)`,
            transition: resting ? "background 0.5s ease" : "background 0.06s linear",
            mixBlendMode: "screen",
          }}/>
          <div style={{
            position: "absolute", inset: 0, borderRadius: 10, pointerEvents: "none",
            background: `linear-gradient(175deg,
              rgba(255,255,255,${0.014 - tilt.x * 0.0005}) 0%,
              transparent 45%,
              rgba(0,0,0,0.06) 100%)`,
            transition: resting ? "background 0.5s ease" : "background 0.06s linear",
          }}/>
          {special && (
            <div style={{
              position: "absolute", inset: 0, borderRadius: 10, pointerEvents: "none",
              background: `linear-gradient(${108 + tilt.y * 3}deg,
                transparent 15%,
                rgba(251,191,36,0.035) 44%,
                rgba(251,191,36,0.06) 56%,
                transparent 85%)`,
              transition: resting ? "background 0.5s ease" : "background 0.06s linear",
              mixBlendMode: "screen",
            }}/>
          )}
        </div>
      </div>
    </div>
  );
}

function Logo() {
  return (
    <img
      src={`data:image/svg+xml;base64,${LOGO_FULL_B64}`}
      alt="networked.cards"
      style={{ height:28, width:"auto", display:"block", objectFit:"contain" }}
    />
  );
}

/* ══════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════
   IOS GYRO PERMISSION — one-time prompt on first mobile launch
   Stored in localStorage. SwipeableCardStack handles its own listener.
══════════════════════════════════════════════════════ */
const GYRO_PERM_KEY = "thecabal_gyro_perm";

function needsGyroPermission() {
  return typeof DeviceOrientationEvent?.requestPermission === "function";
}


const GYRO_OFF_KEY = "thecabal_gyro_off";
function getGyroEnabled() {
  try { return localStorage.getItem(GYRO_OFF_KEY) !== "1"; } catch { return true; }
}

function GyroPermissionPrompt({ onDone }) {
  const mono = { fontFamily:"'DM Mono',monospace" };

  const grant = () => {
    DeviceOrientationEvent.requestPermission()
      .then(r => { try { localStorage.setItem(GYRO_PERM_KEY, r); } catch {} onDone(); })
      .catch(() => { try { localStorage.setItem(GYRO_PERM_KEY,"denied"); } catch {} onDone(); });
  };
  const skip = () => {
    try { localStorage.setItem(GYRO_PERM_KEY,"skipped"); } catch {}
    onDone();
  };

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:9999,
      background:"rgba(0,0,0,0.88)", backdropFilter:"blur(6px)",
      display:"flex", alignItems:"center", justifyContent:"center", padding:24,
    }}>
      <div style={{
        background:"#0f0f0f", border:"1px solid #2a2a2a", borderRadius:12,
        padding:"28px 22px", maxWidth:300, width:"100%",
        textAlign:"center", display:"flex", flexDirection:"column", gap:14,
      }}>
        <div style={{fontSize:28}}>⟳</div>
        <div style={{...mono, fontSize:12, color:"#d0d0d0", letterSpacing:1}}>ENABLE TILT?</div>
        <div style={{...mono, fontSize:9, color:"#555", lineHeight:1.7}}>
          Tilt your device to reveal card edges and trigger holo effects. Works during pack openings.
        </div>
        <div style={{...mono, fontSize:8, color:"#333", lineHeight:1.6}}>
          Optional — the game works fine without it.
        </div>
        <button onClick={grant} style={{
          ...mono, fontSize:10, letterSpacing:2, padding:"11px 0",
          background:"#d0d0d0", color:"#0a0a0a", border:"none", borderRadius:6, cursor:"pointer",
        }}>ENABLE TILT</button>
        <button onClick={skip} style={{
          ...mono, fontSize:9, color:"#444", background:"none",
          border:"none", cursor:"pointer", letterSpacing:1,
        }}>skip for now</button>
      </div>
    </div>
  );
}

function today() { return new Date().toISOString().slice(0,10); }
const INIT = {
  packs:3, lastRegen:Date.now(), pullCount:0, totalOpened:0,
  collection:[], favorites:[], day:today(),
  missions:{packsOpened:0,urPulled:false,claimed:false,burned:false,allRarities:false},
  weekly:{packsOpened:0,urPulled:0,newUnique:0,forgeUsed:0,gotLucky:false,claimed:false,week:""},
  ic:{best:0,neverTut:false},
  achievements:{firstPull:false,firstRare:false,firstUR:false,firstLR:false,
    coll10:false,coll25:false,coll50:false,coll100:false,packs10:false,packs50:false,allLR:false,camp10:false,camp25:false,camp50:false,camp100:false,campBankrupt:false},
};

/* ══════════════════════════════════════════════════════
   MAIN APP
══════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════
   FOUNDATION CSV LOADER
   Fetches all 343k token CIDs from Google Sheets at
   startup. Assigns rarity by creator token count:
   LR ≥100 | UR ≥30 | R ≥8 | C <8
══════════════════════════════════════════════════════ */
const FOUNDATION_CSV_URL =
  "https://raw.githubusercontent.com/networked-art/foundation-ipfs-cids/master/token_cids.csv";

function parseFoundationCSV(text) {
  // Columns: collection(0), creator(1), token_id(2), metadata_cid(3), image_cid(4), animation_cid(5)
  const lines = text.split("\n");
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const p = line.split(",");
    if (p.length < 5 || !p[4] || p[4].length < 10) continue;
    out.push({ collection:p[0], creator:p[1], token_id:p[2], image_cid:p[4] });
  }
  return out;
}

async function loadFoundationPool(onProgress) {
  const resp = await fetch(FOUNDATION_CSV_URL);
  if (!resp.ok) throw new Error("CSV fetch failed: " + resp.status);

  // Stream with progress
  const total = parseInt(resp.headers.get("Content-Length") || "0");
  const reader = resp.body.getReader();
  let received = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress(Math.min(0.69, 0.1 + 0.6 * (received / total)));
  }
  onProgress(0.7);

  // Decode
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  const text = new TextDecoder().decode(merged);
  onProgress(0.75);

  const rows = parseFoundationCSV(text);
  onProgress(0.85);

  // Creator frequency → rarity
  const freq = {};
  rows.forEach(r => { if (r.creator) freq[r.creator] = (freq[r.creator] || 0) + 1; });
  onProgress(0.92);

  const cards = rows.map((r, idx) => {
    const n = freq[r.creator] || 1;
    return {
      id:       r.collection.slice(-8) + "_" + r.token_id,
      handle:   r.creator ? r.creator.slice(0,6) + "..." + r.creator.slice(-4) : (r.collection ? r.collection.slice(0,6) + "..." + r.collection.slice(-4) : ""),
      name:     "FND #" + String(idx+1).padStart(6,"0"),
      rarity:   n >= 100 ? "LR" : n >= 30 ? "UR" : n >= 8 ? "R" : "C",
      cat:      "Foundation",
      bio:      "Foundation artist. " + n + " work" + (n>1?"s":"") + " on-chain.",
      image_cid: r.image_cid,
      creator:  r.creator,
      collection: r.collection,
      token_id: r.token_id,
    };
  });

  // Deduplicate ids
  const seen = new Set();
  const deduped = cards.filter(c => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  onProgress(1.0);
  return deduped;
}


/* ══════════════════════════════════════════════════════
   LOADING SCREEN — shows progress or file-input fallback
══════════════════════════════════════════════════════ */
function LoadingScreen({ progress, error, onFile }) {
  const mono = { fontFamily:"'DM Mono',monospace" };
  const inputRef = React.useRef(null);

  if (error === "network") return (
    <div style={{height:"100vh",display:"flex",flexDirection:"column",alignItems:"center",
      justifyContent:"center",background:"#080808",padding:32, gap:20}}>
      <div style={{...mono,fontSize:9,color:"#555",letterSpacing:3}}>networked.cards</div>
      <div style={{...mono,fontSize:7,color:"#444",letterSpacing:1,textAlign:"center",maxWidth:260,lineHeight:1.8}}>
        Could not fetch cards automatically.<br/>
        Upload the Foundation CSV to continue.
      </div>
      <div
        onClick={() => inputRef.current?.click()}
        style={{...mono,fontSize:7,letterSpacing:2,color:"#333",border:"1px solid #1e1e1e",
          padding:"10px 20px",cursor:"pointer",marginTop:4,
          transition:"border-color .2s,color .2s"}}
        onMouseEnter={e=>{e.currentTarget.style.borderColor="#333";e.currentTarget.style.color="#888";}}
        onMouseLeave={e=>{e.currentTarget.style.borderColor="#1e1e1e";e.currentTarget.style.color="#333";}}
      >
        SELECT CSV FILE
      </div>
      <div style={{...mono,fontSize:6,color:"#222",letterSpacing:1}}>
        Foundation_IPFS_CIDs_-_token_cids.csv
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        style={{display:"none"}}
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }}
      />
    </div>
  );

  return (
    <div style={{height:"100vh",display:"flex",flexDirection:"column",alignItems:"center",
      justifyContent:"center",background:"#080808",padding:24,gap:12}}>
      <div style={{...mono,fontSize:9,color:"#555",letterSpacing:3}}>networked.cards</div>
      <div style={{...mono,fontSize:7,color:"#333",letterSpacing:2}}>
        LOADING {progress}%
      </div>
      <div style={{width:200,height:1,background:"#1a1a1a",borderRadius:1,overflow:"hidden"}}>
        <div style={{width:progress+"%",height:"100%",background:"#2a2a2a",transition:"width .4s ease"}}/>
      </div>
      <div style={{...mono,fontSize:6,color:"#222",letterSpacing:1}}>
        {progress < 70 ? "loading..." : progress < 90 ? "almost ready..." : "done"}
      </div>
    </div>
  );
}


/* ══════════════════════════════════════════════════════
   GOOGLE AUTH — uses Firebase CDN loaded in index.html
══════════════════════════════════════════════════════ */
function AuthButton({ user, onLogin, onLogout }) {
  const [fbReady, setFbReady] = React.useState(!!window._fbAuth);
  const [debug, setDebug] = React.useState("checking...");
  React.useEffect(() => {
    if (window._fbAuth) { setFbReady(true); setDebug("ready"); return; }
    setDebug("waiting for firebase cdn...");
    const t = setInterval(() => {
      if (window._fbAuth) { setFbReady(true); setDebug("ready"); clearInterval(t); }
    }, 200);
    setTimeout(() => { clearInterval(t); setDebug("timeout — firebase not loaded"); }, 5000);
    return () => clearInterval(t);
  }, []);
  // Always show debug text so we can see what's happening
  return (
    <div style={{fontFamily:"'DM Mono',monospace",fontSize:7,color:"#444"}}>
      {!fbReady ? debug : user ? (
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {user.photoURL && <img src={user.photoURL} style={{width:22,height:22,borderRadius:"50%",opacity:.7}} alt=""/>}
          <button onClick={onLogout} style={{fontFamily:"'DM Mono',monospace",background:"transparent",
            border:"1px solid #1e1e1e",borderRadius:3,padding:"4px 8px",color:"#444",
            fontSize:7,letterSpacing:1,cursor:"pointer"}}>sign out</button>
        </div>
      ) : (
        <button onClick={onLogin} style={{fontFamily:"'DM Mono',monospace",background:"transparent",
          border:"1px solid #2a2a2a",borderRadius:3,padding:"5px 12px",color:"#666",
          fontSize:8,letterSpacing:1,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}
          onMouseEnter={e=>e.currentTarget.style.color="#aaa"}
          onMouseLeave={e=>e.currentTarget.style.color="#666"}>
          <svg width="10" height="10" viewBox="0 0 18 18" fill="none">
            <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
            <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
            <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
            <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
          </svg>
          sign in
        </button>
      )}
    </div>
  );
  // unreachable below, kept for structure

}

async function cloudSave(uid, data) {
  if (!window._fbDb || !window.firestoreDoc) return;
  try {
    const ref = window.firestoreDoc(window._fbDb, "saves", uid);
    await window.firestoreSetDoc(ref, { save: JSON.stringify(data), updatedAt: Date.now() });
  } catch(e) { console.warn("Cloud save failed:", e); }
}

async function cloudLoad(uid) {
  if (!window._fbDb || !window.firestoreDoc) return null;
  try {
    const ref = window.firestoreDoc(window._fbDb, "saves", uid);
    const snap = await window.firestoreGetDoc(ref);
    if (snap.exists()) return JSON.parse(snap.data().save);
  } catch(e) { console.warn("Cloud load failed:", e); }
  return null;
}

function TheCabalApp() {
  const [st,setSt]           = useState(INIT);
  const [loaded,setLoaded]   = useState(false);
  const [authUser,setAuthUser] = useState(null);
  const [loadProgress,setLP] = useState(0);
  const [loadErr,setLoadErr] = useState(null);

  const handleCSVFile = React.useCallback(async (file) => {
    setLoadErr(null);
    setLP(5);
    try {
      const text = await file.text();
      setLP(70);
      const rows = parseFoundationCSV(text);
      setLP(85);
      const freq = {};
      rows.forEach(r => { if (r.creator) freq[r.creator] = (freq[r.creator]||0)+1; });
      const cards = rows.map((r, idx) => {
        const n = freq[r.creator]||1;
        return {
          id:       r.collection.slice(-8)+"_"+r.token_id,
          handle:   r.creator ? r.creator.slice(0,6)+"..."+r.creator.slice(-4) : (r.collection ? r.collection.slice(0,6)+"..."+r.collection.slice(-4) : ""),
          name:     "FND #"+String(idx+1).padStart(6,"0"),
          rarity:   n>=100?"LR":n>=30?"UR":n>=8?"R":"C",
          cat:      "Foundation",
          bio:      "Foundation artist. "+n+" work"+(n>1?"s":"")+" on-chain.",
          image_cid: r.image_cid,
          creator:  r.creator,
          collection: r.collection,
          token_id: r.token_id,
        };
      });
      const seen = new Set();
      ACCOUNTS = cards.filter(c=>{ if(seen.has(c.id))return false; seen.add(c.id); return true; });
      ACCOUNTS_BY_ID = Object.fromEntries(ACCOUNTS.map(a=>[a.id,a]));
      setLP(100);
      setLoaded(true);
    } catch(err) {
      console.error("CSV file error:", err);
      setLoadErr("network");
    }
  }, []);

  const [tab,setTab]         = useState("gacha");
  // phase: "idle" | "shaking" | "burst" | "revealing" | "bulk"
  const [phase,setPhase]     = useState("idle");
  const [loadMsg,setLoadMsg]   = useState("");
  const [rarityUpgrades,setRarityUpgrades] = useState({}); // cardId → {rarity, priceEth}
  const packColorIdx = (st.totalOpened ?? 0) % 4;
  const [revealCards,setRC]  = useState([]);
  const [revealDone,setRD]   = useState(false);
  const [nextPackCards,setNextPackCards] = useState(null); // pre-drawn for instant open
  const [bulkModal,setBulkModal] = useState(null);
  const [isBulk,setIsBulk]   = useState(false);
  const isBulkRef = useRef(false);
  useEffect(() => { isBulkRef.current = isBulk; }, [isBulk]);
  const pendingCardsRef = useRef(null); // sync bridge between shaking and burst
  const [notif,setNotif]     = useState(null);
  const [regenS,setRegenS]   = useState(PACK_REGEN);
  const [importing,setImp]   = useState(false);
  const [luckyOpen,setLuckyOpen]= useState(false);
  const luckyRef = useRef(false);  // mirrors luckyOpen as ref — readable in callbacks
  const [ownedIds,setOwnedIds]= useState(new Set()); // ids owned BEFORE current reveal
  const importRef = useRef(null);
  const [showGyroPrompt, setShowGyroPrompt] = useState(false);

  /* storage */
  const persist = useCallback((data) => { Storage.set(SAVE_KEY, JSON.stringify(data)); }, []);

  const save = useCallback((patch) => {
    setSt(prev => { const next={...prev,...patch}; persist(next); return next; });
  }, [persist]);

  useEffect(() => {
    (async () => {
      try {
        const res = await Storage.get(SAVE_KEY);
        if (res?.value) {
          const s = JSON.parse(res.value);
          if (s.day !== today()) { s.day=today(); s.missions={packsOpened:0,urPulled:false,claimed:false,burned:false,allRarities:false}; }
          // Weekly reset: Monday-based week
          const wk = ()=>{ const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-d.getDay()+1); return d.toISOString().slice(0,10); };
          if (!s.weekly || s.weekly.week !== wk()) { s.weekly={packsOpened:0,urPulled:0,newUnique:0,forgeUsed:0,gotLucky:false,claimed:false,week:wk()}; }
          // Migrate old saves: collection used to store full card objects,
          // now we store only {id, _uid} to keep saves small.
          if (Array.isArray(s.collection) && s.collection.length > 0 && s.collection[0].rarity !== undefined) {
            s.collection = s.collection.map(c => ({ id: c.id, _uid: c._uid || `${c.id}_migrated_${Math.random().toString(36).slice(2)}` }));
          }
          setSt(p => ({ ...p, ...s }));
        }
      } catch {}
      // Load Foundation card pool from Google Sheets
      setLP(5);
      try {
        const cards = await loadFoundationPool(p => setLP(Math.round(p * 100)));
        ACCOUNTS = cards;
        ACCOUNTS_BY_ID = Object.fromEntries(cards.map(a => [a.id, a]));
      } catch (err) {
        console.error("Foundation load error:", err);
        setLoadErr("network");
        return;
      }
      setLoaded(true);
      // prepareNextPack called via useEffect below
      // iOS gyro: request permission each session (required by iOS)
      if (needsGyroPermission()) {
        const stored = (() => { try { return localStorage.getItem(GYRO_PERM_KEY); } catch { return null; } })();
        if (!stored) {
          // First time: show prompt
          setTimeout(() => setShowGyroPrompt(true), 1200);
        } else if (stored === "granted") {
          // Previously granted: silently re-request each session (iOS requires this)
          DeviceOrientationEvent.requestPermission()
            .then(r => { if (r !== "granted") try { localStorage.setItem(GYRO_PERM_KEY, r); } catch {} })
            .catch(() => {});
        }
      }
    })();
  }, []);

  /* regen timer */
  useEffect(() => {
    if (!loaded) return;
    const id = setInterval(() => {
      setSt(prev => {
        if (prev.packs >= MAX_PACKS) { setRegenS(PACK_REGEN); return prev; }
        const elapsed = Math.floor((Date.now()-prev.lastRegen)/1000);
        setRegenS(PACK_REGEN - (elapsed % PACK_REGEN));
        if (elapsed >= PACK_REGEN) {
          const next = { ...prev, packs:Math.min(MAX_PACKS,prev.packs+Math.floor(elapsed/PACK_REGEN)), lastRegen:Date.now() };
          persist(next); return next;
        }
        return prev;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [loaded, persist]);

  const toggleFav = useCallback((cardId) => {
    setSt(prev => {
      const arr = Array.isArray(prev.favorites) ? [...prev.favorites] : [];
      const i = arr.indexOf(cardId);
      if (i > -1) arr.splice(i, 1); else arr.push(cardId);
      const next = {...prev, favorites: arr};
      persist(next);
      return next;
    });
  }, [persist]);

  const handleGoogleLogin = useCallback(async () => {
    if (!window._fbAuth || !window.GoogleAuthProvider) return;
    try {
      const provider = new window.GoogleAuthProvider();
      const result = await window.signInWithPopup(window._fbAuth, provider);
      const user = result.user;
      setAuthUser(user);
      const cloud = await cloudLoad(user.uid);
      if (cloud && (cloud.collection?.length||0) > st.collection.length) {
        setSt(prev => { const m={...prev,...cloud}; persist(m); return m; });
        setNotif("☁ cloud save loaded"); setTimeout(()=>setNotif(null),2600);
      } else {
        await cloudSave(user.uid, st);
        setNotif("☁ synced to cloud"); setTimeout(()=>setNotif(null),2600);
      }
    } catch(e) { if(e.code!=="auth/popup-closed-by-user") console.warn(e); }
  }, [st, persist]);

  const handleGoogleLogout = useCallback(async () => {
    if (window._fbAuth && window.firebaseSignOut) await window.firebaseSignOut(window._fbAuth);
    setAuthUser(null);
  }, []);

  useEffect(() => {
    if (!window._fbAuth || !window.onAuthStateChanged) return;
    return window.onAuthStateChanged(window._fbAuth, u => setAuthUser(u||null));
  }, []);

  const notify = useCallback((msg) => {
    setNotif(msg); setTimeout(()=>setNotif(null), 2600);
  }, []);

  // Pre-draw next pack and prefetch all 5 images immediately
  const _preloadImgs = React.useRef([]);
  const _preloadDone = React.useRef(Promise.resolve());

  const prepareNextPack = useCallback(() => {
    if (!ACCOUNTS.length) return;
    const cards = drawPack(false);
    setNextPackCards(cards);
    // Fetch URLs then download actual image bytes — store completion promise
    const imgPromises = cards.filter(c => c.collection && c.token_id).map(c =>
      getAlchemyThumb(c.collection, c.token_id).then(url => {
        if (!url) return;
        return new Promise(resolve => {
          const img = new window.Image();
          img.onload = resolve;
          img.onerror = resolve;
          img.src = url;
          _preloadImgs.current = [..._preloadImgs.current.slice(-20), img];
        });
      }).catch(()=>{})
    );
    // Resolve after all images decoded or 6s max
    _preloadDone.current = Promise.race([
      Promise.all(imgPromises),
      new Promise(res => setTimeout(res, 6000)),
    ]);
    _wasPreloaded.current = true;
    console.log("[prep] decode started for", cards.length, "cards");
  }, []);

  const checkAchi = useCallback((coll,total,prev,burnTotal) => {
    const a={...prev}, u=new Set(coll.map(c=>c.id));
    const rar = id => ACCOUNTS_BY_ID[id]?.rarity;
    if(coll.length) a.firstPull=true;
    if(coll.some(c=>rar(c.id)==="R"))  a.firstRare=true;
    if(coll.some(c=>rar(c.id)==="UR"||rar(c.id)==="LR")) a.firstUR=true;
    if(coll.some(c=>rar(c.id)==="LR")) a.firstLR=true;
    if(u.size>=10)  a.coll10=true;  if(u.size>=25)  a.coll25=true;
    if(u.size>=50)  a.coll50=true;  if(u.size>=100) a.coll100=true;
    if(total>=10)   a.packs10=true; if(total>=50)   a.packs50=true; if(total>=100) a.packs100=true;
    if(ACCOUNTS.filter(x=>x.rarity==="LR").every(x=>u.has(x.id))) a.allLR=true;
    if(ACCOUNTS.filter(x=>x.rarity==="C").every(x=>u.has(x.id)))  a.allC=true;
    if(ACCOUNTS.filter(x=>x.rarity==="R").every(x=>u.has(x.id)))  a.allR=true;
    if(ACCOUNTS.filter(x=>x.rarity==="UR").every(x=>u.has(x.id))) a.allUR=true;
    if(ACCOUNTS.every(x=>u.has(x.id))) a.fullSet=true;
    const bt = burnTotal ?? (prev._burnTotal||0);
    a._burnTotal = bt;
    if(bt>=50)  a.burn50=true;
    if(bt>=100) a.burn100=true;
    return a;
  }, []);

  // Lucky pack: 1.5% random chance each time a pack is opened
  const [nextIsLucky, setNextIsLucky] = useState(() => Math.random() < LUCKY_CHANCE);
  const curIsLucky = nextIsLucky;

  /* open single pack */
  const handleOpenPack = useCallback(() => {
    if (st.packs<1||phase!=="idle") return;
    setOwnedIds(new Set(st.collection.map(c=>c.id)));
    const lucky = nextIsLucky;
    luckyRef.current = lucky;
    // Roll next lucky chance after opening
    setNextIsLucky(Math.random() < LUCKY_CHANCE);
    setLuckyOpen(lucky);
    save({ packs:st.packs-1 });
    setPhase("shaking");
  }, [st.packs,st.pullCount,st.collection,phase,save,nextIsLucky]);

  const handleAnimEnd = useCallback(p => {
    if (p==="shaking") {
      if (!isBulkRef.current) {
        const cards = nextPackCards || drawPack(luckyRef.current);
        pendingCardsRef.current = cards; // sync — available immediately in burst
        setRC(cards); // async — for UI
        const wasPreloaded = _wasPreloaded.current;
        setNextPackCards(null);
        _wasPreloaded.current = false;
        pendingCardsRef._wasPreloaded = wasPreloaded; // pass to burst
        if (!nextPackCards) {
          // Not pre-fetched yet — start now
          cards.filter(c => c.collection && c.token_id)
            .forEach(c => getAlchemyThumb(c.collection, c.token_id).catch(()=>{}));
        }
      }
      setPhase("burst");
      return;
    }
    if (p==="burst") {
      // Cards already drawn during shaking phase for x1; x10 drawn earlier
      const drawnCards = null; // already set in shaking handler
      setRD(false);
      const toLoad = pendingCardsRef.current || revealCards; // use ref for sync access

      // Use pre-decoded images from prepareNextPack, OR fetch+decode now
      const wasPreloaded = pendingCardsRef._wasPreloaded;
      console.log("[burst] wasPreloaded:", wasPreloaded);
      const waitForImages = wasPreloaded
        ? (_preloadDone.current || Promise.resolve()) // pre-decoded — instant
        : Promise.race([                              // fetch+decode now
            Promise.all(toLoad.filter(c=>c.collection&&c.token_id)
              .map(c=>getAlchemyThumb(c.collection,c.token_id).catch(()=>null))),
            new Promise(res=>setTimeout(res,5000))
          ]);
      Promise.race([waitForImages, new Promise(res=>setTimeout(res,5000))])
        .then(() => { setLoadMsg(""); setPhase("revealing"); });
    }
  }, []);

  /* open x10 */
  const handleOpen10 = useCallback(() => {
    if (st.packs<10||phase!=="idle") return;
    setOwnedIds(new Set(st.collection.map(c=>c.id)));
    setRC(draw10Packs());
    setRD(false);
    setIsBulk(true);
    setNextIsLucky(Math.random() < LUCKY_CHANCE); // reset lucky state after x10
    setLuckyOpen(false); // x10 ignores lucky
    save({ packs:st.packs-10 });
    setPhase("shaking"); // show shaking+burst animation like x1
  }, [st.packs,st.pullCount,st.collection,phase,save]);

  /* called when stack is fully swiped */
  const handleStackComplete = useCallback(() => setRD(true), []);

  /* notify best card */
  const notifyBest = useCallback(cards => {
    const best = [...cards].sort((a,b)=>RARITY_ORDER.indexOf(a.rarity)-RARITY_ORDER.indexOf(b.rarity))[0];
    if (best.rarity==="LR") notify(`✦ LEGENDARY! ${best.name}`);
    else if (best.rarity==="UR") notify(`◆ ULTRA RARE: ${best.name}`);
  }, [notify]);

  // Start prefetching as soon as app is loaded and when returning to idle
  useEffect(() => {
    if (!loaded || !ACCOUNTS.length) return;
    console.log("[idle] loaded, ACCOUNTS:", ACCOUNTS.length, "— prefetching next pack");
    prepareNextPack();
  }, [loaded]);

  useEffect(() => {
    if (phase !== "idle" || !loaded || !ACCOUNTS.length) return;
    console.log("[idle] back to idle — prefetching next pack");
    prepareNextPack();
  }, [phase]);



  /* take all after reveal */
  const handleTakeAll = useCallback(() => {
    prepareNextPack(); // pre-draw & pre-fetch next pack NOW
    setIsBulk(false);
    const cards = revealCards;
    // Store only {id, _uid} — full card data is always reconstructed from ACCOUNTS_BY_ID
    const newColl  = [...st.collection, ...cards.map(c => ({ id: c.id, _uid: c._uid }))];
    const packsN   = isBulk ? 10 : 1;
    const newTotal = st.totalOpened + packsN;
    const newPull  = st.pullCount + cards.length;
    const newAch   = checkAchi(newColl, newTotal, st.achievements);
    const ms = {
      ...st.missions,
      packsOpened:(st.missions.packsOpened||0)+packsN,
      urPulled:st.missions.urPulled||cards.some(c=>c.rarity==="UR"||c.rarity==="LR"),
      burned:st.missions.burned,
      allRarities:st.missions.allRarities,
    };
    // Count new unique cards for weekly mission
    const existingIds = new Set(st.collection.map(c=>c.id));
    const newUniqueCount = cards.filter(c=>!existingIds.has(c.id)).length;
    const urCount = cards.filter(c=>c.rarity==="UR"||c.rarity==="LR").length;
    const wk = st.weekly || {};
    const weekly = {
      ...wk,
      packsOpened:(wk.packsOpened||0)+packsN,
      urPulled:(wk.urPulled||0)+urCount,
      newUnique:(wk.newUnique||0)+newUniqueCount,
      gotLucky:wk.gotLucky||luckyRef.current,
    };
    notifyBest(cards);
    // Check for newly completed missions and notify
    const nextSt = { ...st, collection:newColl, missions:ms, weekly };
    checkNewlyCompleted(st, nextSt).forEach(label => {
      setTimeout(() => notify(`✓ Mission complete: ${label}`), 800);
    });
    save({ collection:newColl, totalOpened:newTotal, pullCount:newPull, achievements:newAch, missions:ms, weekly });
    setPhase("idle"); setRC([]); setRD(false);
  }, [st, revealCards, isBulk, checkAchi, notifyBest, save]);

  /* export / import */
  const handleExport = useCallback(async () => {
    const enc = await encryptSave(st);
    if (!enc) { notify("Export failed"); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([enc],{type:"text/plain"}));
    a.download = `thecabal_save_${today()}.txt`; a.click();
    URL.revokeObjectURL(a.href); notify("Save exported!");
  }, [st,notify]);

  const handleImport = useCallback(async e => {
    const file = e.target.files?.[0]; if (!file) return;
    setImp(true);
    try {
      const data = await decryptSave((await file.text()).trim());
      if (!data?.collection) throw new Error();
      if (data.day!==today()) { data.day=today(); data.missions={packsOpened:0,urPulled:false,claimed:false}; }
      setSt(p=>({...p,...data})); persist(JSON.stringify(data)); notify("Save imported!");
    } catch { notify("Invalid or corrupted save file"); }
    setImp(false); e.target.value="";
  }, [notify, persist]);

  const uniqueCards = useMemo(() => {
    // collection is compact [{id, _uid}] — reconstruct full card data from ACCOUNTS_BY_ID
    const m = {};
    st.collection.forEach(c => {
      const acc = ACCOUNTS_BY_ID[c.id];
      if (!acc) return; // skip unknown ids (e.g. old accounts that were removed)
      if (!m[c.id]) m[c.id] = { ...acc, count: 0 };
      m[c.id].count++;
    });
    return Object.values(m).sort((a,b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity));
  }, [st.collection, loaded]); // loaded ensures recompute after CSV loads

  if (!loaded) return (
    <LoadingScreen
      progress={loadProgress}
      error={loadErr}
      onFile={handleCSVFile}
    />
  );

  const mins=Math.floor(regenS/60), secs=regenS%60;
  const timerStr=`${mins}:${String(secs).padStart(2,"0")}`;
  const timerPct=((PACK_REGEN-regenS)/PACK_REGEN)*100;
  const navItems=[{k:"gacha",l:"GACHA"},{k:"collection",l:"COLLECTION"},{k:"missions",l:"MISSIONS"}];

  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",background:"#060606",
      fontFamily:"'DM Mono',monospace",color:"#e0e0e0"}}>

      {/* Notification */}
      {showGyroPrompt && (
        <GyroPermissionPrompt onDone={() => setShowGyroPrompt(false)}/>
      )}
      {notif && (
        <div style={{position:"fixed",top:14,left:"50%",zIndex:9999,transform:"translateX(-50%)",
          background:"#141414",border:"1px solid #333",borderRadius:5,padding:"8px 18px",
          fontSize:9,color:"#d0d0d0",letterSpacing:2,animation:"notifSlide .3s ease",
          whiteSpace:"nowrap",pointerEvents:"none"}}>{notif}</div>
      )}

      {/* Header */}
      <header style={{padding:"18px 20px 0",borderBottom:"1px solid #111",maxWidth:680,margin:"0 auto",width:"100%"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <AuthButton user={authUser} onLogin={handleGoogleLogin} onLogout={handleGoogleLogout}/>
          <div style={{flex:1}}/>{/* push logo right */}
          <Logo/>
        </div>
        <nav style={{display:"flex",gap:0}}>
          {navItems.map(({k,l})=>(
            <button key={k} onClick={()=>{
              // If currently revealing, claim cards before switching tab
              if (phase==="revealing" && revealCards.length>0) handleTakeAll();
              setTab(k);
            }} style={{fontFamily:"'DM Mono',monospace",
              background:"transparent",border:"none",
              borderBottom:`1px solid ${tab===k?"#d0d0d0":"transparent"}`,
              color:tab===k?"#d0d0d0":"#555",fontSize:8,padding:"8px 12px 10px",
              cursor:"pointer",letterSpacing:1.5,transition:"color .15s"}}>{l}</button>
          ))}
        </nav>
      </header>

      <main style={{flex:1,maxWidth:680,margin:"0 auto",width:"100%",padding:"22px 20px 60px"}}>

        {/* ══ GACHA ══ */}
        {tab==="gacha" && (
          <div style={{animation:"slideUp .3s ease"}}>
            {/* Stats */}
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:24}}>
              <div>
                <div style={{fontSize:8,color:"#555",letterSpacing:2,marginBottom:2}}>PACKS</div>
                <div style={{fontSize:32,fontWeight:500,lineHeight:1}}>
                  {st.packs}<span style={{fontSize:10,color:"#444",marginLeft:4}}>/{MAX_PACKS}{st.packs>MAX_PACKS&&<span style={{color:"#fbbf24",fontSize:9}}> ✦</span>}</span>
                </div>
                {st.packs<MAX_PACKS && (
                  <div style={{fontSize:7.5,color:"#555",marginTop:3}}>
                    next in {timerStr}
                    <div style={{width:60,height:1.5,background:"#161616",marginTop:3,borderRadius:1,overflow:"hidden"}}>
                      <div style={{width:`${timerPct}%`,height:"100%",background:"#2a2a2a",transition:"width 1s linear"}}/>
                    </div>
                  </div>
                )}
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:8,color:"#555",letterSpacing:2,marginBottom:2}}>TOTAL PULLS</div>
                <div style={{fontSize:24,color:"#666"}}>{st.pullCount}</div>
                <div style={{fontSize:7.5,marginTop:3,color:curIsLucky?RARITIES.UR.accent:"#333"}}>
                  {curIsLucky ? "✦ LUCKY PACK NEXT" : "5% lucky pack chance"}
                </div>
              </div>
            </div>

            {/* ── Idle ── */}
            {phase==="idle" && (
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:18}}>
                {/* Spacer matching "SWIPE TO REVEAL" label height so pack aligns with card stack */}
                <div style={{height:24}}/>
                {/* Pack — click/tap opens it directly */}
                <div onClick={st.packs>0?handleOpenPack:undefined} style={{cursor:st.packs>0?"pointer":"default"}}>
                  <PackVisual special={curIsLucky} phase="idle" onAnimEnd={()=>{}} colorIdx={packColorIdx}/>
                </div>

                {/* "click / tap to open" hint */}
                {st.packs>0 && (
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#444",letterSpacing:2,textAlign:"center"}}>
                    {window.matchMedia?.("(pointer: coarse)").matches ? "tap to open" : "click to open"}
                  </div>
                )}

                {/* OPEN x10 — only visible when player has ≥10 packs */}
                {st.packs>=10 && (
                  <button onClick={handleOpen10} style={{
                    fontFamily:"'DM Mono',monospace",background:"transparent",
                    border:"1px solid #333",borderRadius:5,padding:"10px 32px",
                    letterSpacing:2,fontSize:10,color:"#bbb",cursor:"pointer",transition:"all .2s"}}
                    onMouseEnter={e=>e.target.style.borderColor="#666"}
                    onMouseLeave={e=>e.target.style.borderColor="#333"}>
                    OPEN x10
                  </button>
                )}
                </div>
            )}

            {/* ── Shaking / burst ── */}
            {(phase==="shaking"||phase==="burst") && (
              <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
                <div style={{height:24}}/>
                <PackVisual special={luckyOpen} phase={phase} onAnimEnd={handleAnimEnd} colorIdx={packColorIdx}/>

              </div>
            )}

            {/* ── Swipe stack reveal ── */}
            {phase==="revealing" && revealCards.length>0 && (
              <div style={{animation:"slideUp .3s ease"}} onTouchMove={e=>e.preventDefault()} onTouchStart={e=>e.stopPropagation()}>
                <div style={{fontSize:8,color:"#555",textAlign:"center",marginBottom:16,letterSpacing:2}}>
                  {luckyOpen&&!isBulk ? "✦ LUCKY PACK — " : ""}
                  {isBulk ? `x10 OPENING · ${revealCards.length} CARDS` : "SWIPE TO REVEAL"}
                </div>

                {!revealDone ? (
                  /* ── Swipe stack — Take All BELOW ── */
                  <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:0}}>
                    <div style={{position:"relative",display:"inline-block"}}>
                      <SwipeableCardStack
                        cards={revealCards.map(c => rarityUpgrades[c.id] ? {...c, rarity: rarityUpgrades[c.id].rarity} : c)}
                        onComplete={handleStackComplete}
                        cardWidth={200}
                        ownedIds={ownedIds}
                      />

                    </div>
                    <div style={{height:16}}/>
                    <button onClick={()=>setRD(true)} style={{
                      fontFamily:"'DM Mono',monospace",background:"transparent",
                      border:"1px solid #1a1a1a",borderRadius:5,padding:"6px 20px",
                      color:"#333",fontSize:8,letterSpacing:1,cursor:"pointer",transition:"all .2s"}}
                      onMouseEnter={e=>{e.target.style.borderColor="#2a2a2a";e.target.style.color="#555";}}
                      onMouseLeave={e=>{e.target.style.borderColor="#1a1a1a";e.target.style.color="#333";}}>
                      skip opening
                    </button>
                  </div>
                ) : (
                  /* All swiped — grid with Take All on TOP */
                  <div style={{animation:"slideUp .3s ease"}}>
                    <div style={{textAlign:"center",marginBottom:16}}>
                      <button onClick={handleTakeAll} style={{
                        fontFamily:"'DM Mono',monospace",background:"#0d0d0d",
                        border:"1px solid #333",borderRadius:5,padding:"10px 30px",
                        color:"#d0d0d0",fontSize:10,letterSpacing:2,cursor:"pointer"
                      }}>
                        TAKE ALL ({revealCards.length})
                      </button>
                    </div>
                    <div style={{
                      display:"grid",
                      gridTemplateColumns:`repeat(auto-fill,minmax(${isBulk?100:140}px,1fr))`,
                      gap:8,
                    }}>
                      {revealCards.map((card,i) => (
                        <div key={card._uid} style={{
                          animation:`cardReveal 0.3s ease ${Math.min(i*0.03,0.5)}s both`,
                          display:"flex", justifyContent:"center",
                          position:"relative", cursor:"pointer",
                        }}
                          onClick={()=>setBulkModal(card)}
                        >
                          <CardCanvas card={card} dispW={isBulk?100:138}/>
                          {!ownedIds.has(card.id) && (
                            <NewBadge size={isBulk?"sm":"md"}/>
                          )}
                        </div>
                      ))}
                      {bulkModal && (
                        <CardModal
                          card={bulkModal}
                          onClose={()=>setBulkModal(null)}
                          isFav={(st.favorites||[]).includes(bulkModal.id)}
                          onToggleFav={toggleFav}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab==="collection" && <CollectionView unique={uniqueCards} notify={notify} favoritesArr={Array.isArray(st.favorites) ? st.favorites : []} onToggleFav={toggleFav}/>}
        {tab==="forge"      && <ForgeView uniqueCards={uniqueCards} st={st} save={save} notify={notify}/>}
        {tab==="missions"   && <MissionsView st={st} save={save} notify={notify} uniqueCards={uniqueCards}/>}
      </main>

      <footer style={{textAlign:"center",padding:"14px 0 18px",fontSize:8,color:"#333",
        letterSpacing:1.5,borderTop:"1px solid #0d0d0d"}}>
        <span style={{color:"#333"}}>a CC0 experiment by{" "}
        <a href="https://x.com/itsfredi1" target="_blank" rel="noopener noreferrer"
          style={{color:"#555",textDecoration:"none"}}
          onMouseEnter={e=>e.target.style.color="#999"}
          onMouseLeave={e=>e.target.style.color="#555"}>manfredi</a>
        {". made possible by "}
        <a href="https://github.com/jwahdatehagh" target="_blank" rel="noopener noreferrer"
          style={{color:"#555",textDecoration:"none"}}
          onMouseEnter={e=>e.target.style.color="#999"}
          onMouseLeave={e=>e.target.style.color="#555"}>jalil.eth</a>
        {", "}
        <a href="https://visualizevalue.com" target="_blank" rel="noopener noreferrer"
          style={{color:"#555",textDecoration:"none"}}
          onMouseEnter={e=>e.target.style.color="#999"}
          onMouseLeave={e=>e.target.style.color="#555"}>vv</a>
        {" and "}
        <a href="https://x.com/yougogirl_eth" target="_blank" rel="noopener noreferrer"
          style={{color:"#555",textDecoration:"none"}}
          onMouseEnter={e=>e.target.style.color="#999"}
          onMouseLeave={e=>e.target.style.color="#555"}>ygg</a>
        </span>
      </footer>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   COLLECTION VIEW
══════════════════════════════════════════════════════ */

/* ── CardModal — full-screen card viewer, opened by clicking a card in collection ── */
function CardModal({ card, onClose, isFav, onToggleFav }) {
  const MODAL_W = Math.min(320, window.innerWidth - 40);

  // Lock scroll on body while modal is open; close on Escape
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";
    const onKey = e => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.body.style.touchAction = "";
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const twitterUrl = `https://etherscan.io/address/${card.creator || card.collection}`;

  return (
    <div
      onClick={onClose}
      style={{
        position:"fixed", inset:0, zIndex:9999,
        background:"rgba(0,0,0,0.88)",
        display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
        gap:18,
        animation:"slideUp 0.22s ease",
        backdropFilter:"blur(6px)",
        WebkitBackdropFilter:"blur(6px)",
      }}
    >
      {/* Card */}
      <div onClick={e=>e.stopPropagation()} style={{ position:"relative" }}>
        <FlippableCard card={card} dispW={MODAL_W} allowTilt/>
        <button
          onClick={onClose}
          style={{
            position:"absolute", top:-14, right:-14,
            width:28, height:28, borderRadius:"50%",
            background:"#1a1a1a", border:"1px solid #333",
            color:"#888", fontSize:14, cursor:"pointer",
            display:"flex", alignItems:"center", justifyContent:"center",
            fontFamily:"'DM Mono',monospace", lineHeight:1,
          }}
        >×</button>

      </div>

      {/* Hint row — below the card */}
      <div
        onClick={e=>e.stopPropagation()}
        style={{
          display:"flex", gap:20, alignItems:"center",
          fontFamily:"'DM Mono',monospace", fontSize:10,
          letterSpacing:1,
        }}
      >
        <span style={{color:"#555"}}>click to flip</span>
        {onToggleFav && <>
          <span style={{color:"#2a2a2a"}}>·</span>
          <button
            onClick={()=>onToggleFav(card.id)}
            style={{
              background:"transparent", border:"none", cursor:"pointer",
              fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:1,
              color:isFav?"#e74c3c":"#555", transition:"color .15s", padding:0,
            }}
            onMouseEnter={e=>e.currentTarget.style.color=isFav?"#ff6b6b":"#aaa"}
            onMouseLeave={e=>e.currentTarget.style.color=isFav?"#e74c3c":"#555"}
          >{isFav ? "♥ saved" : "♥ save"}</button>
        </>}
      </div>
    </div>
  );
}

/* ── LazyCard — defers mounting FlippableCard until near viewport. ── */
function LazyCard({ card, dispW, notify, count, onCardClick, isFav, onToggleFav }) {
  const wrapRef  = useRef(null);
  const [visible, setVisible] = useState(false);
  const CARD_H = Math.round(dispW * (470/300));
  const r = RARITIES[card.rarity];

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Bidirectional: mount when within 600px of viewport, UNMOUNT when 800px away.
    // Two observers with different margins handle the hysteresis gap — prevents
    // rapid mount/unmount as user scrolls slowly past the boundary.
    const mountObs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { rootMargin: "600px" }
    );
    const unmountObs = new IntersectionObserver(
      ([entry]) => { if (!entry.isIntersecting) setVisible(false); },
      { rootMargin: "800px" }
    );
    mountObs.observe(el);
    unmountObs.observe(el);
    return () => { mountObs.disconnect(); unmountObs.disconnect(); };
  }, []);

  return (
    <div ref={wrapRef} style={{
      position:"relative", display:"flex", justifyContent:"center",
      // Always reserve the correct height so the grid doesn't reflow
      minHeight: CARD_H, minWidth: dispW,
    }}>
      {visible ? (
        <>
          <div
            style={{cursor:"pointer"}}
            onClick={()=>{ if(onCardClick) onCardClick(card); }}
          >
            <FlippableCard card={card} dispW={dispW} noFlipOnClick/>
          </div>
          {count>1 && (
            <div style={{position:"absolute",top:-5,left:"calc(50% - 60px - 4px)",
              background:"#111",border:"1px solid #333",borderRadius:"50%",
              width:18,height:18,display:"flex",alignItems:"center",justifyContent:"center",
              fontSize:7,color:"#888",pointerEvents:"none",zIndex:2}}>×{count}</div>
          )}
          {/* Heart / favorite button */}
          {onToggleFav && (
            <div
              onClick={e=>{e.stopPropagation();onToggleFav(card.id);}}
              style={{position:"absolute",top:4,right:"calc(50% - 60px)",
                zIndex:10,cursor:"pointer",fontSize:12,
                color:isFav?"#e74c3c":"#333",
                transition:"color .15s, transform .1s",
                lineHeight:1,
              }}
              onMouseEnter={e=>e.currentTarget.style.transform="scale(1.2)"}
              onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}
            >♥</div>
          )}

        </>
      ) : (
        /* Skeleton — same size as real card to avoid grid reflow */
        <div style={{
          width:dispW, height:CARD_H, borderRadius:7,
          background:"#0a0a0a", border:`1px solid ${r.color}18`,
        }}/>
      )}
    </div>
  );
}

function CollectionView({ unique, notify, favoritesArr, onToggleFav }) {
  const [showFavOnly,setShowFavOnly] = useState(false);
  const [modalCard, setModalCard] = useState(null);
  const [search,setSearch] = useState("");
  const favorites = useMemo(() => new Set(favoritesArr || []), [favoritesArr]);

  // With 343k cards we never render placeholders — collection shows only owned cards

  // When search or favorites active, show only matching collected cards
  const isFiltering = search.trim() !== "" || showFavOnly;

  const filteredCollected = useMemo(() => {
    let arr = unique;
    if (showFavOnly) arr = arr.filter(c => favorites.has(c.id));
    if (search) {
      const q = search.toLowerCase();
      arr = arr.filter(c => {
        const key = c.collection && c.token_id ? `${c.collection}_${c.token_id}` : null;
        const meta = key ? _nftMeta[key] : null;
        const realName = (meta?.name || c.name || "").toLowerCase();
        const collName = (meta?.collection || meta?.symbol || c.cat || "").toLowerCase();
        return c.handle.toLowerCase().includes(q) || realName.includes(q) || collName.includes(q) || c.collection?.toLowerCase().includes(q);
      });
    }
    return [...arr].sort((a,b) => {
      const rd = RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity);
      if (rd!==0) return rd;
      return a.name.localeCompare(b.name);
    });
  }, [unique, search, showFavOnly, favoritesArr]);

  const inp = {fontFamily:"'DM Mono',monospace",background:"#0a0a0a",border:"1px solid #1e1e1e",
    borderRadius:4,color:"#aaa",fontSize:11,padding:"5px 9px",outline:"none"};

  const CARD_W = 120;
  const CARD_H = Math.round(CARD_W * (470/300));

  return (
    <div style={{animation:"slideUp .3s ease"}}>
      {modalCard && <CardModal card={modalCard} onClose={()=>setModalCard(null)} isFav={favorites.has(modalCard?.id)} onToggleFav={onToggleFav}/>}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <div style={{fontSize:8,color:"#555",letterSpacing:2}}>COLLECTION</div>
          <div style={{fontSize:22,marginTop:2}}>
            {unique.length}<span style={{fontSize:9,color:"#444",marginLeft:5}}>/ {ACCOUNTS.length.toLocaleString()} total</span>
          </div>
        </div>
      </div>

      {/* ── Filter row ── */}
      <div style={{display:"flex",gap:6,marginBottom:12}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search..."
          style={{...inp,flex:1,minWidth:90}}/>
        <button onClick={()=>setShowFavOnly(f=>!f)} style={{
          fontFamily:"'DM Mono',monospace",cursor:"pointer",fontSize:11,
          padding:"4px 10px",borderRadius:3,transition:"all .15s",
          background:showFavOnly?"#1a0a0a":"transparent",
          border:`1px solid ${showFavOnly?"#c0392b40":"#1e1e1e"}`,
          color:showFavOnly?"#e74c3c":"#444",
        }}>♥</button>
      </div>

      {!isFiltering && unique.length>0 && (
        <div style={{fontSize:7,color:"#2a2a2a",marginBottom:10,letterSpacing:.5}}>
          click or tap a card to expand
        </div>
      )}

      {/* ── Full grid: owned cards only (343k pool — no placeholders) ── */}
      {!isFiltering && (
        unique.length === 0
          ? <div style={{textAlign:"center",color:"#2a2a2a",fontSize:9,padding:60,letterSpacing:1,fontFamily:"'DM Mono',monospace"}}>
              no cards yet — open some packs
            </div>
          : <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(120px,1fr))",gap:10}}>
              {[...unique].sort((a,b) => {
                const rd = RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity);
                if (rd !== 0) return rd;
                return a.name.localeCompare(b.name);
              }).map(card => (
                <LazyCard key={card._uid || card.id} card={card} dispW={CARD_W} notify={notify} count={card.count} onCardClick={setModalCard} isFav={(favoritesArr||[]).includes(card.id)} onToggleFav={onToggleFav}/>
              ))}
            </div>
      )}

      {/* ── Filtered view: only matching collected cards ── */}
      {isFiltering && (
        filteredCollected.length===0
          ? <div style={{textAlign:"center",color:"#2a2a2a",fontSize:9,padding:40,letterSpacing:1}}>nothing matches</div>
          : <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(120px,1fr))",gap:10}}>
              {filteredCollected.map(card=>(
                <LazyCard key={card.id} card={card} dispW={CARD_W} notify={notify} count={card.count} onCardClick={setModalCard}/>
              ))}
            </div>
      )}

    </div>
  );
}

/* ══════════════════════════════════════════════════════
   MISSIONS VIEW
══════════════════════════════════════════════════════ */
const DAILY_MISSIONS = [
  { id:"m_packs",   label:"Open 3 packs",                     check:st=>(st.missions.packsOpened||0)>=3,      reward:2 },
  { id:"m_ur",      label:"Pull an Ultra Rare or Legendary",  check:st=>st.missions.urPulled,                 reward:3 },
  { id:"m_burn",    label:"Burn at least 1 duplicate",        check:st=>st.missions.burned||false,            reward:1 },
  { id:"m_collect", label:"Have 5+ different rarities in collection", check:st=>st.missions.allRarities||false, reward:2 },
];
const WEEKLY_MISSIONS = [
  { id:"w_packs20",  label:"Open 20 packs this week",          check:st=>(st.weekly?.packsOpened||0)>=20,     reward:5 },
  { id:"w_ur3",      label:"Pull 3 Ultra Rare cards this week",check:st=>(st.weekly?.urPulled||0)>=3,         reward:6 },
  { id:"w_unique",   label:"Collect 10 new unique cards",      check:st=>(st.weekly?.newUnique||0)>=10,       reward:4 },
  { id:"w_forge",    label:"Use the Forge 3 times this week",  check:st=>(st.weekly?.forgeUsed||0)>=3,        reward:5 },
  { id:"w_lucky",    label:"Open a Lucky Pack",                check:st=>st.weekly?.gotLucky||false,          reward:8 },
];
const MISSIONS_DEF = DAILY_MISSIONS; // keep compat

// Returns list of mission labels that just crossed the completion threshold
function checkNewlyCompleted(prevSt, nextSt) {
  const completed = [];
  const allMissions = [...DAILY_MISSIONS, ...WEEKLY_MISSIONS];
  for (const m of allMissions) {
    const wasDone = m.check(prevSt);
    const isDone  = m.check(nextSt);
    const claimed = nextSt.missions?.[`claimed_${m.id}`] || nextSt.weekly?.[`claimed_${m.id}`];
    if (!wasDone && isDone && !claimed) completed.push(m.label);
  }
  return completed;
}
const ACHI_DEF = [
  // ── GACHA ──
  { id:"firstPull",   s:"GACHA", label:"First Pull",      desc:"Open your first pack",               reward:1 },
  { id:"firstRare",   s:"GACHA", label:"Rare Find",        desc:"Pull your first Rare card",           reward:1 },
  { id:"firstUR",     s:"GACHA", label:"Ultra Instinct",   desc:"Pull an Ultra Rare or higher",         reward:2 },
  { id:"firstLR",     s:"GACHA", label:"Legendary",        desc:"Pull a Legendary card",               reward:3 },
  { id:"packs10",     s:"GACHA", label:"Pack Addict",      desc:"Open 10 packs total",                 reward:1 },
  { id:"packs50",     s:"GACHA", label:"Pack Maniac",      desc:"Open 50 packs total",                 reward:3 },
  { id:"packs100",    s:"GACHA", label:"Pack Obsession",   desc:"Open 100 packs total",                reward:5 },
  { id:"coll10",      s:"GACHA", label:"Collector I",      desc:"Collect 10 unique cards",             reward:1 },
  { id:"coll25",      s:"GACHA", label:"Collector II",     desc:"Collect 25 unique cards",             reward:2 },
  { id:"coll50",      s:"GACHA", label:"Collector III",    desc:"Collect 50 unique cards",             reward:3 },
  { id:"coll100",     s:"GACHA", label:"Collector IV",     desc:"Collect 100 unique cards",            reward:5 },
  { id:"allC",        s:"GACHA", label:"Common Ground",    desc:"Collect every Common card",           reward:3 },
  { id:"allR",        s:"GACHA", label:"Rare Breed",       desc:"Collect every Rare card",             reward:4 },
  { id:"allUR",       s:"GACHA", label:"Ultra Roster",     desc:"Collect every Ultra Rare card",       reward:6 },
  { id:"allLR",       s:"GACHA", label:"Legendary Row",    desc:"Collect all Legendary cards",         reward:10 },
  { id:"fullSet",     s:"GACHA", label:"networked.cards",        desc:"Collect every card in Season One",    reward:15 },
  // ── FORGE ──
  { id:"burn50",      s:"FORGE", label:"Melt Down",        desc:"Burn 50 duplicate cards in the Forge",reward:2 },
  { id:"burn100",     s:"FORGE", label:"The Furnace",      desc:"Burn 100 duplicate cards in the Forge",reward:4 },
  { id:"burnLR",      s:"FORGE", label:"Sacrilege",        desc:"Burn a Legendary card",               reward:5 },
  // ── CAMPAIGN ──




];


/* ══════════════════════════════════════════════════════
   FORGE VIEW — burn duplicates for packs
   Shard system: C=1, R=3, UR=6, LR=12 shards per dupe
   10 shards = 1 pack (max 5 packs per burn)
══════════════════════════════════════════════════════ */
const SHARD_VALUE = { LR:12, UR:6, R:3, C:1 };
const SHARDS_PER_PACK = 10;

function ForgeView({ uniqueCards, st, save, notify }) {
  const [forgeSort, setForgeSort] = useState("dupes");   // "rarity" | "dupes"

  const dupes = useMemo(() => {
    const filtered = uniqueCards.filter(c => c.count > 1);
    if (forgeSort === "dupes") return filtered.sort((a,b) => (b.count-1)-(a.count-1));
    return filtered.sort((a,b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity));
  }, [uniqueCards, forgeSort]);

  const [selected, setSelected] = useState({});  // id → qty to burn

  // left click = add 1 dupe to burn queue; right click = remove 1
  const toggle = useCallback((card, remove=false) => {
    setSelected(prev => {
      const maxBurnable = card.count - 1;
      const cur = prev[card.id] || 0;
      if (remove) {
        if (cur <= 1) { const n={...prev}; delete n[card.id]; return n; }
        return { ...prev, [card.id]: cur - 1 };
      }
      if (cur >= maxBurnable) return prev; // already at max, ignore
      return { ...prev, [card.id]: cur + 1 };
    });
  }, []);

  const totalShards = useMemo(() =>
    Object.entries(selected).reduce((sum, [id, qty]) => {
      const card = uniqueCards.find(c => c.id === id);
      return sum + (card ? SHARD_VALUE[card.rarity] * qty : 0);
    }, 0)
  , [selected, uniqueCards]);

  const packsEarned    = Math.floor(totalShards / SHARDS_PER_PACK);
  const shardRemainder = totalShards % SHARDS_PER_PACK;
  // Burn is allowed when we'd earn ≥1 pack.
  // We consume only what's needed (packsEarned * SHARDS_PER_PACK worth of cards),
  // leftover shards stay in the burn tally below.
  const canBurn = packsEarned > 0;
  const shardsToConsume = packsEarned * SHARDS_PER_PACK;
  const newPackTotal = st.packs + packsEarned;  // no cap — forge can overflow above MAX_PACKS

  // Which cards / how many will actually be burned (only up to shardsToConsume)
  const burnPlan = useMemo(() => {
    if (!canBurn) return {};
    let budget = shardsToConsume;
    const plan = {};
    // Process in rarity order (lowest first to preserve valuable cards)
    const entries = Object.entries(selected)
      .map(([id, qty]) => ({ id, qty, card: uniqueCards.find(c=>c.id===id) }))
      .filter(e => e.card)
      .sort((a,b) => RARITY_ORDER.indexOf(b.card.rarity) - RARITY_ORDER.indexOf(a.card.rarity)); // C first
    for (const { id, qty, card } of entries) {
      if (budget <= 0) break;
      const sv = SHARD_VALUE[card.rarity];
      // Use at least 1 card even if sv > remaining budget — card is being consumed
      const canUse = Math.min(qty, Math.max(1, Math.floor(budget / sv)));
      if (canUse > 0) { plan[id] = canUse; budget -= canUse * sv; }
    }
    return plan;
  }, [canBurn, shardsToConsume, selected, uniqueCards]);

  const handleBurn = useCallback(() => {
    // Recompute everything fresh — avoids stale closure bugs with large selections
    const currentShards = Object.entries(selected).reduce((sum, [id, qty]) => {
      const card = uniqueCards.find(c => c.id === id);
      return sum + (card ? SHARD_VALUE[card.rarity] * qty : 0);
    }, 0);
    const earned = Math.floor(currentShards / SHARDS_PER_PACK);
    if (earned < 1) return;

    // Compute burn plan inline
    let budget = earned * SHARDS_PER_PACK;
    const plan = {};
    const entries = Object.entries(selected)
      .map(([id, qty]) => ({ id, qty, card: uniqueCards.find(c=>c.id===id) }))
      .filter(e => e.card)
      .sort((a,b) => RARITY_ORDER.indexOf(b.card.rarity) - RARITY_ORDER.indexOf(a.card.rarity));
    for (const { id, qty, card } of entries) {
      if (budget <= 0) break;
      const sv = SHARD_VALUE[card.rarity];
      const use = Math.min(qty, Math.max(1, Math.floor(budget / sv)));
      if (use > 0) { plan[id] = use; budget -= use * sv; }
    }

    // Apply burn
    let coll = [...st.collection];
    Object.entries(plan).forEach(([id, qty]) => {
      let removed = 0;
      coll = coll.filter(c => { if (c.id===id && removed<qty) { removed++; return false; } return true; });
    });
    const burnCount = Object.values(plan).reduce((a,b)=>a+b, 0);
    const newBurnTotal = (st.achievements?._burnTotal||0) + burnCount;
    // Inline achievement check for burn milestones (checkAchi is not in scope here)
    const newAch = { ...st.achievements, _burnTotal: newBurnTotal };
    if (newBurnTotal >= 50)  newAch.burn50  = true;
    if (newBurnTotal >= 100) newAch.burn100 = true;
    save({
      collection: coll,
      packs: st.packs + earned,
      achievements: newAch,
      missions: { ...st.missions, burned: true },
      weekly: { ...(st.weekly||{}), forgeUsed: ((st.weekly?.forgeUsed)||0)+1 }
    });
    notify(`+${earned} pack${earned>1?"s":""}`);
    setSelected({});
    // Check forge-related missions
    const nextStForge = { ...st, weekly: { ...(st.weekly||{}), forgeUsed: ((st.weekly?.forgeUsed)||0)+1 }, missions: { ...st.missions, burned: true } };
    checkNewlyCompleted(st, nextStForge).forEach(label => {
      setTimeout(() => notify(`✓ Mission complete: ${label}`), 600);
    });
  }, [selected, uniqueCards, st, save, notify]);

  const mono = { fontFamily:"'DM Mono',monospace" };
  const anySelected = Object.keys(selected).length > 0;

  return (
    <div style={{ animation:"slideUp .3s ease" }}>
      <p style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#555",letterSpacing:.5,marginBottom:20,lineHeight:1.6}}>Burn duplicate cards to earn new packs — select your dupes below and redeem them.</p>

      {/* Sticky header */}
      <div style={{
        position:"sticky", top:0, zIndex:20,
        background:"#0a0a0a", borderBottom:"1px solid #161616",
        padding:"10px 12px 12px",
      }}>
        {/* Top row: rate legend + sort */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
          <div style={{ ...mono, fontSize:7.5, color:"#333", letterSpacing:.3 }}>
            <span style={{color:"#555"}}>C</span>=1 · <span style={{color:RARITIES.R.accent+"88"}}>R</span>=3 · <span style={{color:RARITIES.UR.accent+"88"}}>UR</span>=6 · <span style={{color:RARITIES.LR.accent+"88"}}>LR</span>=12 · 10pts = 1 pack
          </div>
          <div style={{ display:"flex", gap:4 }}>
            {[["rarity","RARITY"],["dupes","DUPES"]].map(([v,l])=>(
              <button key={v} onClick={()=>setForgeSort(v)} style={{
                ...mono, fontSize:7, letterSpacing:.8, padding:"2px 8px",
                borderRadius:3, cursor:"pointer", transition:"all .12s",
                background: forgeSort===v ? "#1e1e1e" : "transparent",
                border:`1px solid ${forgeSort===v?"#333":"#191919"}`,
                color: forgeSort===v ? "#888" : "#333",
              }}>{l}</button>
            ))}
          </div>
        </div>

        {/* Progress + burn row */}
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ flex:1 }}>
            <div style={{ height:2, background:"#181818", borderRadius:1, marginBottom:7, overflow:"hidden" }}>
              <div style={{
                height:"100%", borderRadius:1, transition:"width .25s ease",
                width: totalShards===0 ? "0%" : `${Math.min(100, ((totalShards%SHARDS_PER_PACK)||(shardRemainder===0&&packsEarned>0?10:0))/SHARDS_PER_PACK*100).toFixed(1)}%`,
                background: canBurn ? "#e8a020" : "#2a2a2a",
              }}/>
            </div>
            <div style={{ ...mono, lineHeight:1 }}>
              {!anySelected ? (
                <span style={{ fontSize:8, color:"#2a2a2a" }}>tap a card to add duplicates</span>
              ) : (
                <>
                  <span style={{ fontSize:12, color:"#c8c8c8", fontWeight:500 }}>{totalShards}</span>
                  <span style={{ fontSize:7.5, color:"#444", marginLeft:5 }}>pts</span>
                  {packsEarned > 0 && <span style={{ fontSize:9, color:"#e8a020", marginLeft:8 }}>→ {packsEarned} pack{packsEarned!==1?"s":""}</span>}
                  {packsEarned===0 && <span style={{ fontSize:7.5, color:"#383838", marginLeft:8 }}>{SHARDS_PER_PACK-totalShards} more needed</span>}
                </>
              )}
            </div>
          </div>
          <button onClick={handleBurn} disabled={!canBurn} style={{
            ...mono, flexShrink:0,
            background: canBurn ? "#e8a020" : "#111",
            border:"none",
            color: canBurn ? "#000" : "#222",
            borderRadius:5, padding:"9px 20px", fontSize:9, letterSpacing:2,
            cursor: canBurn ? "pointer" : "not-allowed",
            fontWeight: canBurn ? 600 : 400, transition:"all .2s",
          }}>BURN{packsEarned>0?` ×${packsEarned}`:""}</button>
        </div>
      </div>

      {/* Card grid */}
      <div style={{ padding:"10px 10px" }}>
        {dupes.length === 0 ? (
          <div style={{ ...mono, fontSize:10, color:"#252525", textAlign:"center", padding:"40px 0" }}>
            no duplicates yet
          </div>
        ) : (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(86px,1fr))", gap:7 }}>
            {dupes.map(card => {
              const r = RARITIES[card.rarity];
              const qty = selected[card.id] || 0;
              const maxBurn = card.count - 1;
              const isSelected = qty > 0;
              return (
                <div key={card.id} onClick={() => toggle(card)}
                  style={{
                    cursor:"pointer", borderRadius:5, overflow:"hidden",
                    border:`1.5px solid ${isSelected ? r.color : r.color+"44"}`,
                    background: isSelected ? r.color+"12" : "#0c0c0c",
                    transition:"border-color .12s, background .12s",
                    position:"relative",
                  }}>
                  {/* Photo */}
                  <div style={{ aspectRatio:"1/1", background:"#0d0d0d", overflow:"hidden" }}>
                    <CardImage card={card} style={{ width:"100%", height:"100%", objectFit:"cover",
                        filter: isSelected ? "none" : "grayscale(0.35) brightness(0.6)",
                        transition:"filter .15s" }} />
                  </div>
                  {/* Info */}
                  <div style={{ padding:"4px 5px 5px", ...mono }}>
                    <div style={{ fontSize:7, color: isSelected ? r.accent : r.accent+"88",
                      whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{card.name}</div>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:1 }}>
                      <span style={{ fontSize:6, color: r.color, letterSpacing:.3 }}>{r.short}</span>
                      <span style={{ fontSize:6.5, color:"#383838" }}>×{maxBurn}</span>
                    </div>
                  </div>
                  {/* Selected badge: −  qty  +  MAX */}
                  {isSelected ? (
                    <div style={{
                      position:"absolute", top:4, right:4,
                      background:r.color, color:"#000",
                      borderRadius:3, padding:"1px 4px",
                      ...mono, fontSize:7, fontWeight:700, lineHeight:1.5,
                      display:"flex", alignItems:"center", gap:2,
                    }}>
                      <span onClick={e=>{e.stopPropagation();toggle(card,true);}} style={{opacity:.65,padding:"0 1px"}}>−</span>
                      <span>{qty}</span>
                      <span onClick={e=>{e.stopPropagation();toggle(card);}} style={{opacity: qty>=maxBurn?.25:.65,padding:"0 1px"}}>+</span>
                    </div>
                  ) : null}
                  {/* MAX button — always visible */}
                  <div onClick={e=>{e.stopPropagation();setSelected(p=>({...p,[card.id]:maxBurn}));}}
                    style={{
                      position:"absolute", top:4, left:4,
                      background:"rgba(0,0,0,0.7)", color: r.accent,
                      borderRadius:3, padding:"1px 5px",
                      ...mono, fontSize:6.5, fontWeight:600, letterSpacing:.5,
                      cursor:"pointer", opacity: qty===maxBurn ? .3 : .85,
                      border:`1px solid ${r.color}44`,
                    }}>MAX</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}



/* ══════════════════════════════════════════════════════
   INNER CIRCLE — Reigns-style survival
   Navigate the NFT/crypto space as one card.
   4 meters: CASH · HEAT · NETWORK · CLOUT
   Any meter at 0 or 100 = game over.
   Swipe RIGHT = yes, LEFT = no.
══════════════════════════════════════════════════════ */

const IC_METERS = {
  ETH:     { label:"ETH",     lo:"bankrupt",        hi:"paper trail",      color:"#5aba5a" },
  HEAT:    { label:"HEAT",    lo:"disappeared",     hi:"arrested",         color:"#c06060" },
  NETWORK: { label:"NETWORK", lo:"isolated",        hi:"overexposed",      color:"#4a9fd4" },
  CLOUT:   { label:"CLOUT",   lo:"forgotten",       hi:"too visible",      color:"#e8c96e" },
};
const IC_KEYS = ["ETH","HEAT","NETWORK","CLOUT"];

const IC_TYPE_BONUS = {
  Artist:    { ETH:-5, HEAT:-5,  NETWORK:+5,  CLOUT:+10 },
  Collector: { ETH:+8, HEAT:-5,  NETWORK:+5,  CLOUT:0   },
  Builder:   { ETH:0,  HEAT:-10, NETWORK:+5,  CLOUT:0   },
  Founder:   { ETH:+5, HEAT:+5,  NETWORK:+5,  CLOUT:+5  },
  Platform:  { ETH:+5, HEAT:0,   NETWORK:+10, CLOUT:0   },
};

const IC_TYPE_COLOR = {
  Artist:"#c06090", Collector:"#4a9fd4", Builder:"#4aad6a",
  Founder:"#d4914a", Platform:"#9b6dd4",
};

function icType(card) { return (card?.cat||"").split("/")[0].trim(); }
function icStartMeters(card) {
  const b = IC_TYPE_BONUS[icType(card)] || {};
  return {
    ETH:     Math.min(92,Math.max(8, 50+(b.ETH||0))),
    HEAT:    Math.min(92,Math.max(8, 30+(b.HEAT||0))),
    NETWORK: Math.min(92,Math.max(8, 45+(b.NETWORK||0))),
    CLOUT:   Math.min(92,Math.max(8, 40+(b.CLOUT||0))),
  };
}

function icApply(m, fx, vr, syn, mods) {
  const out = {...m};
  for (const k of IC_KEYS) {
    const base = (fx[k]||0)+(syn?.[k]||0);
    const roll = base + (Math.random()*2-1)*(vr[k]||0);
    // Apply active modifier multipliers
    const mult = (mods||[]).reduce((acc,mod) => acc*(mod[k+"_m"]||1), 1);
    out[k] = Math.max(0, Math.min(100, out[k]+(roll*mult)));
  }
  return out;
}

function icDeath(m) {
  for (const k of IC_KEYS) {
    if (m[k]<=0)  return `${IC_METERS[k].label.toUpperCase()} DRAINED — ${IC_METERS[k].lo}`;
    if (m[k]>=100) return `${IC_METERS[k].label.toUpperCase()} MAXED — ${IC_METERS[k].hi}`;
  }
  return null;
}

// ══ MARKET EVENTS — rare, appear ~8% of deals, affect mechanics for N rounds ══
const IC_MARKET_EVENTS = [
  { id:"ev_crash",   isEvent:true, name:"MARKET CRASH",
    text:"The floor is collapsing across the board. For the next 5 rounds, all ETH gains are halved. But chaos draws attention — NETWORK gains double.",
    acc:"Ride it out",  aFx:{ETH:-5,HEAT:0,NETWORK:+8,CLOUT:-5},  aVr:{ETH:4,HEAT:3,NETWORK:4,CLOUT:4},
    rej:"Cash out now", rFx:{ETH:+8,HEAT:+5,NETWORK:-10,CLOUT:-8}, rVr:{ETH:5,HEAT:4,NETWORK:5,CLOUT:5},
    mod_acc:{ id:"crash", label:"CRASH", rounds:5, ETH_m:0.5, NETWORK_m:2.0 },
    mod_rej:null, cat:"Event" },
  { id:"ev_bull",    isEvent:true, name:"BULL MARKET",
    text:"Everything is pumping. For 5 rounds, ETH gains double. But HEAT and CLOUT are harder to control — they also swing harder.",
    acc:"Ride the wave", aFx:{ETH:+10,HEAT:+8,NETWORK:0,CLOUT:+5}, aVr:{ETH:6,HEAT:5,NETWORK:3,CLOUT:5},
    rej:"Stay cautious", rFx:{ETH:-3,HEAT:-5,NETWORK:+5,CLOUT:-3}, rVr:{ETH:3,HEAT:3,NETWORK:3,CLOUT:3},
    mod_acc:{ id:"bull", label:"BULL", rounds:5, ETH_m:2.0, HEAT_m:1.5, CLOUT_m:1.5 },
    mod_rej:null, cat:"Event" },
  { id:"ev_irl",     isEvent:true, name:"IRL CONFERENCE",
    text:"A major art + web3 conference is happening. For 4 rounds: no ETH activity, but NETWORK and CLOUT gains are doubled.",
    acc:"Attend in person",aFx:{ETH:-5,HEAT:-3,NETWORK:+15,CLOUT:+12},aVr:{ETH:3,HEAT:3,NETWORK:6,CLOUT:6},
    rej:"Skip it",         rFx:{ETH:0,HEAT:0,NETWORK:-8,CLOUT:-8},    rVr:{ETH:2,HEAT:2,NETWORK:4,CLOUT:4},
    mod_acc:{ id:"irl", label:"IRL", rounds:4, ETH_m:0.0, NETWORK_m:2.0, CLOUT_m:2.0 },
    mod_rej:null, cat:"Event" },
  { id:"ev_lowkey",  isEvent:true, name:"LAY LOW",
    text:"Someone in your circles just got arrested. For 4 rounds, stay quiet — HEAT drops faster but everything else slows down.",
    acc:"Go dark",      aFx:{ETH:-3,HEAT:-15,NETWORK:-5,CLOUT:-5},  aVr:{ETH:2,HEAT:5,NETWORK:3,CLOUT:3},
    rej:"Business as usual",rFx:{ETH:+3,HEAT:+12,NETWORK:+5,CLOUT:+3},rVr:{ETH:3,HEAT:6,NETWORK:3,CLOUT:3},
    mod_acc:{ id:"lowkey", label:"DARK", rounds:4, HEAT_m:0.4, ETH_m:0.7, NETWORK_m:0.6, CLOUT_m:0.6 },
    mod_rej:null, cat:"Event" },
  { id:"ev_viral",   isEvent:true, name:"VIRAL MOMENT",
    text:"Something you touched is going viral. For 3 rounds, CLOUT swings are massive in both directions. Fame or infamy — coin toss.",
    acc:"Lean into it",  aFx:{ETH:+5,HEAT:+10,NETWORK:+8,CLOUT:+20},aVr:{ETH:6,HEAT:8,NETWORK:5,CLOUT:18},
    rej:"Deflect it",    rFx:{ETH:0,HEAT:-5,NETWORK:-5,CLOUT:-10},   rVr:{ETH:3,HEAT:4,NETWORK:4,CLOUT:8},
    mod_acc:{ id:"viral", label:"VIRAL", rounds:3, CLOUT_m:2.5, HEAT_m:1.8 },
    mod_rej:null, cat:"Event" },
];

// ══ REGULAR DEALS — ~140 total, 90% art-focused ══
const IC_DEALS = [
  // ── ARTIST (45) ──
  { cat:"Artist", id:"collab_1on1",
    text:"{c} wants to do a surprise 1/1 collab. Your name on their work, theirs on yours.",
    acc:"Co-sign it",      aFx:{ETH:+5,HEAT:+8,NETWORK:+10,CLOUT:+18},aVr:{ETH:8,HEAT:6,NETWORK:5,CLOUT:10},
    rej:"Not right now",   rFx:{ETH:0,HEAT:-3,NETWORK:-8,CLOUT:-10},  rVr:{ETH:3,HEAT:3,NETWORK:4,CLOUT:6},   syn:"Artist",sFx:{CLOUT:+8}},
  { cat:"Artist", id:"residency_iceland",
    text:"{c} is curating a residency in Iceland. Six weeks, full stipend, total isolation. Good for the work, bad for the timeline.",
    acc:"Pack your bags",  aFx:{ETH:+8,HEAT:-8,NETWORK:-5,CLOUT:+12}, aVr:{ETH:6,HEAT:5,NETWORK:4,CLOUT:8},
    rej:"Not now",         rFx:{ETH:0,HEAT:+3,NETWORK:+3,CLOUT:-5},   rVr:{ETH:2,HEAT:3,NETWORK:3,CLOUT:4},   syn:"Artist",sFx:{CLOUT:+5}},
  { cat:"Artist", id:"residency_obscure",
    text:"{c} got you an artist residency in rural Romania. No internet, no collectors, just a studio and some goats.",
    acc:"Embrace the silence",aFx:{ETH:+5,HEAT:-12,NETWORK:-10,CLOUT:+8},aVr:{ETH:5,HEAT:5,NETWORK:5,CLOUT:7},
    rej:"Hard no",         rFx:{ETH:0,HEAT:+4,NETWORK:+3,CLOUT:-4},   rVr:{ETH:2,HEAT:3,NETWORK:3,CLOUT:3},   syn:"Artist",sFx:{ETH:+3}},
  { cat:"Artist", id:"shady_gallery",
    text:"{c} knows a Mayfair gallery that'll take your work. 70% commission. Prestigious but brutal.",
    acc:"Sign with them",  aFx:{ETH:+6,HEAT:+5,NETWORK:+8,CLOUT:+15}, aVr:{ETH:8,HEAT:4,NETWORK:5,CLOUT:8},
    rej:"Keep your cut",   rFx:{ETH:+3,HEAT:-3,NETWORK:-5,CLOUT:-6},  rVr:{ETH:3,HEAT:2,NETWORK:3,CLOUT:4},   syn:"Artist",sFx:{CLOUT:+6}},
  { cat:"Artist", id:"open_edition",
    text:"{c} is minting an open edition together. Low value, high reach.",
    acc:"Let it run",      aFx:{ETH:+8,HEAT:+6,NETWORK:+12,CLOUT:+8}, aVr:{ETH:8,HEAT:5,NETWORK:5,CLOUT:6},
    rej:"Pass",            rFx:{ETH:-3,HEAT:-3,NETWORK:-8,CLOUT:-5},  rVr:{ETH:3,HEAT:3,NETWORK:4,CLOUT:4},   syn:"Artist",sFx:{NETWORK:+5}},
  { cat:"Artist", id:"cringe_meme_card",
    text:"{c} wants you to mint a limited cringe meme card. Degen bait. Embarrassing upside.",
    acc:"Mint the meme",   aFx:{ETH:+15,HEAT:+12,NETWORK:+8,CLOUT:-5},aVr:{ETH:12,HEAT:8,NETWORK:6,CLOUT:8},
    rej:"Dignity intact",  rFx:{ETH:-3,HEAT:-3,NETWORK:-5,CLOUT:+5},  rVr:{ETH:3,HEAT:3,NETWORK:4,CLOUT:4},   syn:"Artist",sFx:{ETH:+5}},
  { cat:"Artist", id:"zero_reserve",
    text:"{c} is suggesting a 0 ETH reserve auction. High risk, could blow up or bomb completely.",
    acc:"No reserve",      aFx:{ETH:+18,HEAT:+8,NETWORK:+10,CLOUT:+10},aVr:{ETH:20,HEAT:6,NETWORK:6,CLOUT:8},
    rej:"Set a floor",     rFx:{ETH:+3,HEAT:-3,NETWORK:-3,CLOUT:-3},  rVr:{ETH:4,HEAT:3,NETWORK:3,CLOUT:3},   syn:"Artist",sFx:{ETH:+8}},
  { cat:"Artist", id:"negative_tweet",
    text:"{c} is writing a thread calling out exploitative gallery practices. They want you to co-sign it.",
    acc:"Sign the thread",  aFx:{ETH:0,HEAT:+18,NETWORK:+8,CLOUT:+12},aVr:{ETH:3,HEAT:10,NETWORK:5,CLOUT:8},
    rej:"Stay quiet",       rFx:{ETH:0,HEAT:-5,NETWORK:-6,CLOUT:-8},  rVr:{ETH:2,HEAT:4,NETWORK:4,CLOUT:5},   syn:"Artist",sFx:{CLOUT:+5}},
  { cat:"Artist", id:"shill_thread",
    text:"{c} wants you to write a shill thread for a project they're in. Your audience would bite.",
    acc:"Write the thread", aFx:{ETH:+10,HEAT:+10,NETWORK:+5,CLOUT:+8},aVr:{ETH:8,HEAT:7,NETWORK:4,CLOUT:6},
    rej:"Not my style",     rFx:{ETH:-3,HEAT:-4,NETWORK:-5,CLOUT:-4}, rVr:{ETH:2,HEAT:3,NETWORK:3,CLOUT:3},   syn:"Artist",sFx:{ETH:+4}},
  { cat:"Artist", id:"beeple_exhibition",
    text:"{c} has a contact at Beeple's studio. One slot in the next group show. Very curated, very visible.",
    acc:"Submit a piece",   aFx:{ETH:+5,HEAT:+5,NETWORK:+10,CLOUT:+22},aVr:{ETH:6,HEAT:4,NETWORK:5,CLOUT:10},
    rej:"Not ready yet",    rFx:{ETH:0,HEAT:-3,NETWORK:-5,CLOUT:-8},  rVr:{ETH:2,HEAT:3,NETWORK:3,CLOUT:5},   syn:"Artist",sFx:{CLOUT:+8}},
  { cat:"Artist", id:"ai_debate",
    text:"{c} wants you on an AI art ethics panel. The discourse is heated.",
    acc:"Join the panel",   aFx:{ETH:0,HEAT:+15,NETWORK:+8,CLOUT:+18},aVr:{ETH:3,HEAT:8,NETWORK:5,CLOUT:10},
    rej:"Stay out of it",   rFx:{ETH:0,HEAT:-5,NETWORK:-6,CLOUT:-8},  rVr:{ETH:3,HEAT:4,NETWORK:4,CLOUT:5},   syn:"Artist",sFx:{CLOUT:+6}},
  { cat:"Artist", id:"copy_callout",
    text:"{c} found someone blatantly copying work in your circles. Call it out or let it slide.",
    acc:"Call it out",      aFx:{ETH:0,HEAT:+15,NETWORK:+5,CLOUT:+12},aVr:{ETH:3,HEAT:10,NETWORK:5,CLOUT:8},
    rej:"Ignore it",        rFx:{ETH:0,HEAT:-8,NETWORK:-5,CLOUT:-10}, rVr:{ETH:3,HEAT:5,NETWORK:4,CLOUT:6},   syn:"Artist",sFx:{HEAT:-5}},
  { cat:"Artist", id:"pfp_project",
    text:"{c} built a PFP collection. Wants you to mint publicly and post about it.",
    acc:"Mint and post",    aFx:{ETH:-8,HEAT:+10,NETWORK:+8,CLOUT:+20},aVr:{ETH:6,HEAT:8,NETWORK:5,CLOUT:12},
    rej:"Hard pass",        rFx:{ETH:+3,HEAT:-5,NETWORK:-8,CLOUT:-12},rVr:{ETH:3,HEAT:4,NETWORK:4,CLOUT:6},   syn:"Artist",sFx:{CLOUT:+6}},
  { cat:"Artist", id:"charity_auction",
    text:"{c} is organizing a charity auction of donated digital work.",
    acc:"Donate a piece",   aFx:{ETH:0,HEAT:-8,NETWORK:+8,CLOUT:+14}, aVr:{ETH:3,HEAT:5,NETWORK:5,CLOUT:8},
    rej:"Can't right now",  rFx:{ETH:0,HEAT:+5,NETWORK:-8,CLOUT:-10}, rVr:{ETH:3,HEAT:4,NETWORK:4,CLOUT:6},   syn:"Artist",sFx:{CLOUT:+5}},
  { cat:"Artist", id:"physical_bridge",
    text:"{c} is doing a physical–digital bridge show. Wants your piece in it.",
    acc:"Submit a piece",   aFx:{ETH:+5,HEAT:+3,NETWORK:+8,CLOUT:+15},aVr:{ETH:8,HEAT:4,NETWORK:5,CLOUT:10},
    rej:"Another time",     rFx:{ETH:0,HEAT:-3,NETWORK:-6,CLOUT:-8},  rVr:{ETH:3,HEAT:3,NETWORK:4,CLOUT:5},   syn:"Artist",sFx:{CLOUT:+5}},
  { cat:"Artist", id:"influencer_shill",
    text:"{c} can get a large account to shill your piece. Flip potential, reputation risk.",
    acc:"Go for it",        aFx:{ETH:+18,HEAT:+15,NETWORK:+5,CLOUT:+12},aVr:{ETH:15,HEAT:8,NETWORK:5,CLOUT:10},
    rej:"Too hot",          rFx:{ETH:-5,HEAT:-5,NETWORK:-8,CLOUT:-8}, rVr:{ETH:4,HEAT:4,NETWORK:4,CLOUT:5},   syn:"Artist",sFx:{CLOUT:+5}},
  { cat:"Artist", id:"journalist",
    text:"{c} connected you with a journalist writing about the NFT space.",
    acc:"Do the interview",  aFx:{ETH:-3,HEAT:+12,NETWORK:+8,CLOUT:+18},aVr:{ETH:4,HEAT:8,NETWORK:5,CLOUT:10},
    rej:"No comment",        rFx:{ETH:0,HEAT:+5,NETWORK:-8,CLOUT:-10},rVr:{ETH:3,HEAT:5,NETWORK:4,CLOUT:6},   syn:"Artist",sFx:{CLOUT:+5}},
  { cat:"Artist", id:"gen_art_collab",
    text:"{c} wants your aesthetic input on a generative algorithm they're building.",
    acc:"Collaborate",       aFx:{ETH:+5,HEAT:+3,NETWORK:+8,CLOUT:+14},aVr:{ETH:6,HEAT:4,NETWORK:5,CLOUT:8},
    rej:"Not your thing",    rFx:{ETH:0,HEAT:-3,NETWORK:-8,CLOUT:-8}, rVr:{ETH:3,HEAT:3,NETWORK:4,CLOUT:5},   syn:"Builder",sFx:{CLOUT:+6}},
  { cat:"Artist", id:"residency",
    text:"{c} is curating an on-chain residency. Six months of visibility and network access.",
    acc:"Apply",             aFx:{ETH:+5,HEAT:+3,NETWORK:+12,CLOUT:+10},aVr:{ETH:6,HEAT:4,NETWORK:6,CLOUT:8},
    rej:"Pass this round",   rFx:{ETH:0,HEAT:-3,NETWORK:-10,CLOUT:-6},rVr:{ETH:3,HEAT:3,NETWORK:5,CLOUT:4},   syn:"Artist",sFx:{NETWORK:+5}},
  { cat:"Artist", id:"print_on_demand",
    text:"{c} wants to launch a print-on-demand store with your best pieces. Passive, low prestige.",
    acc:"Set it up",         aFx:{ETH:+12,HEAT:-3,NETWORK:+3,CLOUT:-5},aVr:{ETH:8,HEAT:3,NETWORK:3,CLOUT:5},
    rej:"Rather not",        rFx:{ETH:-3,HEAT:-2,NETWORK:-2,CLOUT:+2},rVr:{ETH:2,HEAT:2,NETWORK:2,CLOUT:2},   syn:"Artist",sFx:{ETH:+4}},
  { cat:"Artist", id:"new_marketplace_join",
    text:"{c} wants you as a launch artist on their new marketplace. Early mover advantage, platform risk.",
    acc:"Join the launch",   aFx:{ETH:-3,HEAT:+5,NETWORK:+12,CLOUT:+15},aVr:{ETH:6,HEAT:5,NETWORK:6,CLOUT:8},
    rej:"Too early",         rFx:{ETH:+3,HEAT:-3,NETWORK:-8,CLOUT:-6},rVr:{ETH:3,HEAT:3,NETWORK:4,CLOUT:4},   syn:"Platform",sFx:{NETWORK:+6}},
  { cat:"Artist", id:"cc0_conversion",
    text:"{c} is converting their entire catalogue to CC0. Wants you to do the same as a statement.",
    acc:"Go CC0",            aFx:{ETH:-5,HEAT:-5,NETWORK:+10,CLOUT:+18},aVr:{ETH:5,HEAT:4,NETWORK:6,CLOUT:10},
    rej:"Keep your rights",  rFx:{ETH:+3,HEAT:+3,NETWORK:-5,CLOUT:-8},rVr:{ETH:3,HEAT:3,NETWORK:4,CLOUT:5},   syn:"Artist",sFx:{CLOUT:+6}},
  { cat:"Artist", id:"burn_collection",
    text:"{c} wants to do a ceremonial on-chain burn of 10 pieces. Scarcity play.",
    acc:"Burn them",         aFx:{ETH:+10,HEAT:+3,NETWORK:+5,CLOUT:+12},aVr:{ETH:10,HEAT:4,NETWORK:4,CLOUT:8},
    rej:"No way",            rFx:{ETH:-3,HEAT:-2,NETWORK:-3,CLOUT:-5},rVr:{ETH:2,HEAT:2,NETWORK:3,CLOUT:4},   syn:"Artist",sFx:{CLOUT:+5}},

  // ── COLLECTOR (30) ──
  { cat:"Collector", id:"floor_sweep",
    text:"{c} is coordinating a quiet floor sweep on a struggling collection.",
    acc:"Join the sweep",   aFx:{ETH:+15,HEAT:+10,NETWORK:+8,CLOUT:+5},aVr:{ETH:12,HEAT:8,NETWORK:5,CLOUT:6},
    rej:"Stay out",         rFx:{ETH:-3,HEAT:-5,NETWORK:-8,CLOUT:-5}, rVr:{ETH:3,HEAT:3,NETWORK:4,CLOUT:4},   syn:"Collector",sFx:{ETH:+6}},
  { cat:"Collector", id:"auth_dispute",
    text:"{c} says a collector is disputing a piece's authenticity. They want you to vouch.",
    acc:"Vouch publicly",   aFx:{ETH:0,HEAT:+12,NETWORK:+5,CLOUT:+12},aVr:{ETH:3,HEAT:8,NETWORK:5,CLOUT:10},
    rej:"Stay neutral",     rFx:{ETH:0,HEAT:-5,NETWORK:-10,CLOUT:-8},rVr:{ETH:3,HEAT:4,NETWORK:5,CLOUT:5},   syn:"Collector",sFx:{HEAT:-5}},
  { cat:"Collector", id:"collector_intro",
    text:"{c} wants to introduce you to a whale collector. Private meeting.",
    acc:"Take the meeting",  aFx:{ETH:+10,HEAT:+3,NETWORK:+12,CLOUT:+8},aVr:{ETH:10,HEAT:4,NETWORK:6,CLOUT:8},
    rej:"Not interested",    rFx:{ETH:-3,HEAT:-3,NETWORK:-12,CLOUT:-5},rVr:{ETH:3,HEAT:3,NETWORK:5,CLOUT:4},  syn:"Collector",sFx:{ETH:+5}},
  { cat:"Collector", id:"stolen_funds",
    text:"{c} says a mutual's wallet got drained. Fundraiser mint ongoing.",
    acc:"Contribute",       aFx:{ETH:-10,HEAT:-8,NETWORK:+12,CLOUT:+10},aVr:{ETH:6,HEAT:5,NETWORK:5,CLOUT:6},
    rej:"Stay out",         rFx:{ETH:+5,HEAT:+5,NETWORK:-10,CLOUT:-10},rVr:{ETH:4,HEAT:4,NETWORK:5,CLOUT:6},  syn:"Collector",sFx:{NETWORK:+5}},
  { cat:"Collector", id:"curation_list",
    text:"{c} is listing the most important wallets in the space. They want yours.",
    acc:"Accept inclusion",  aFx:{ETH:0,HEAT:+8,NETWORK:+10,CLOUT:+15},aVr:{ETH:3,HEAT:6,NETWORK:5,CLOUT:8},
    rej:"Stay anonymous",    rFx:{ETH:0,HEAT:-8,NETWORK:-5,CLOUT:-8}, rVr:{ETH:3,HEAT:5,NETWORK:4,CLOUT:5},   syn:"Collector",sFx:{CLOUT:+5}},
  { cat:"Collector", id:"wash_trade",
    text:"{c} needs a counterparty for a wash trade on their collection.",
    acc:"Do the trade",     aFx:{ETH:+12,HEAT:+15,NETWORK:+5,CLOUT:-3},aVr:{ETH:5,HEAT:8,NETWORK:4,CLOUT:4},
    rej:"Stay clean",       rFx:{ETH:-5,HEAT:-8,NETWORK:-8,CLOUT:+3},rVr:{ETH:3,HEAT:4,NETWORK:4,CLOUT:3},   syn:"Collector",sFx:{HEAT:-6}},
  { cat:"Collector", id:"airdrop_farm",
    text:"{c} has a farming strategy for a new protocol. Needs addresses.",
    acc:"Share wallets",    aFx:{ETH:+10,HEAT:+10,NETWORK:+8,CLOUT:-3},aVr:{ETH:10,HEAT:8,NETWORK:5,CLOUT:4},
    rej:"Stay out",         rFx:{ETH:-3,HEAT:-5,NETWORK:-6,CLOUT:+3},rVr:{ETH:3,HEAT:4,NETWORK:4,CLOUT:3},   syn:"Collector",sFx:{ETH:+5}},
  { cat:"Collector", id:"exit_together",
    text:"{c} says a project is done. Exiting quietly together.",
    acc:"Exit together",    aFx:{ETH:+18,HEAT:+10,NETWORK:+3,CLOUT:-10},aVr:{ETH:18,HEAT:8,NETWORK:5,CLOUT:8},
    rej:"Stay loyal",       rFx:{ETH:-8,HEAT:0,NETWORK:+10,CLOUT:+12},rVr:{ETH:8,HEAT:4,NETWORK:5,CLOUT:6},   syn:"Collector",sFx:{ETH:+5}},
  { cat:"Collector", id:"gallery_route",
    text:"{c} wants to route a private gallery sale through your wallet.",
    acc:"Help route it",    aFx:{ETH:+12,HEAT:+15,NETWORK:+5,CLOUT:+3},aVr:{ETH:8,HEAT:8,NETWORK:4,CLOUT:5},
    rej:"Stay clean",       rFx:{ETH:-3,HEAT:-8,NETWORK:-5,CLOUT:+3},rVr:{ETH:3,HEAT:4,NETWORK:4,CLOUT:3},   syn:"Collector",sFx:{HEAT:-6}},
  { cat:"Collector", id:"grail_drop",
    text:"{c} has early access to a legendary wallet's private drop. Very limited.",
    acc:"Get in early",     aFx:{ETH:-10,HEAT:+3,NETWORK:+5,CLOUT:+20},aVr:{ETH:12,HEAT:4,NETWORK:4,CLOUT:10},
    rej:"Not worth the risk",rFx:{ETH:+3,HEAT:-3,NETWORK:-5,CLOUT:-10},rVr:{ETH:3,HEAT:3,NETWORK:3,CLOUT:6},  syn:"Collector",sFx:{CLOUT:+8}},

  // ── BUILDER (25) ──
  { cat:"Builder", id:"protocol_launch",
    text:"{c} is launching an on-chain art protocol. Early adopters get governance tokens.",
    acc:"Adopt early",      aFx:{ETH:-5,HEAT:+5,NETWORK:+10,CLOUT:+8},aVr:{ETH:8,HEAT:5,NETWORK:5,CLOUT:8},
    rej:"Too experimental", rFx:{ETH:+3,HEAT:-3,NETWORK:-8,CLOUT:-5},rVr:{ETH:3,HEAT:3,NETWORK:4,CLOUT:4},   syn:"Builder",sFx:{NETWORK:+6}},
  { cat:"Builder", id:"mixer_run",
    text:"{c} built a new mixer and needs test funds run through it.",
    acc:"Put funds in",     aFx:{ETH:+8,HEAT:+20,NETWORK:+5,CLOUT:-5},aVr:{ETH:15,HEAT:10,NETWORK:4,CLOUT:6},
    rej:"Hard no",          rFx:{ETH:-3,HEAT:-12,NETWORK:-5,CLOUT:+3},rVr:{ETH:3,HEAT:6,NETWORK:4,CLOUT:3},   syn:"Builder",sFx:{HEAT:-8}},
  { cat:"Builder", id:"bridge_relay",
    text:"{c} needs a wallet to relay cross-chain funds through.",
    acc:"Be the relay",     aFx:{ETH:+8,HEAT:+18,NETWORK:+5,CLOUT:-3},aVr:{ETH:10,HEAT:10,NETWORK:4,CLOUT:5},
    rej:"Hard no",          rFx:{ETH:0,HEAT:-10,NETWORK:-5,CLOUT:+3},rVr:{ETH:3,HEAT:5,NETWORK:4,CLOUT:3},   syn:"Builder",sFx:{HEAT:-8}},
  { cat:"Builder", id:"smart_contract",
    text:"{c} wrote an automated trading contract. Needs someone to deploy it.",
    acc:"Run it",           aFx:{ETH:+14,HEAT:+8,NETWORK:+5,CLOUT:+3},aVr:{ETH:12,HEAT:6,NETWORK:4,CLOUT:5},
    rej:"Not my thing",     rFx:{ETH:-3,HEAT:-5,NETWORK:-5,CLOUT:0}, rVr:{ETH:3,HEAT:3,NETWORK:3,CLOUT:3},   syn:"Builder",sFx:{ETH:+5}},
  { cat:"Builder", id:"sec_audit",
    text:"{c} says regulatory attention is coming. Clean up wallet history quietly.",
    acc:"Clean up",         aFx:{ETH:-12,HEAT:-20,NETWORK:0,CLOUT:+3},aVr:{ETH:6,HEAT:8,NETWORK:3,CLOUT:5},
    rej:"Ignore it",        rFx:{ETH:+8,HEAT:+18,NETWORK:+3,CLOUT:-3},rVr:{ETH:5,HEAT:10,NETWORK:3,CLOUT:4},  syn:"Builder",sFx:{HEAT:-5}},
  { cat:"Builder", id:"offshore_shell",
    text:"{c} has one slot left in a clean offshore entity.",
    acc:"Take the slot",    aFx:{ETH:+5,HEAT:-15,NETWORK:+5,CLOUT:+5},aVr:{ETH:8,HEAT:8,NETWORK:4,CLOUT:5},
    rej:"No thanks",        rFx:{ETH:-3,HEAT:+5,NETWORK:-3,CLOUT:0}, rVr:{ETH:3,HEAT:4,NETWORK:3,CLOUT:3},   syn:"Builder",sFx:{HEAT:-5}},
  { cat:"Builder", id:"lawyer_up",
    text:"{c} says you need a lawyer. Expensive but could save you.",
    acc:"Hire them",        aFx:{ETH:-15,HEAT:-18,NETWORK:+5,CLOUT:+5},aVr:{ETH:5,HEAT:8,NETWORK:4,CLOUT:4},
    rej:"Handle it solo",   rFx:{ETH:+3,HEAT:+12,NETWORK:-3,CLOUT:-5},rVr:{ETH:4,HEAT:8,NETWORK:3,CLOUT:4},   syn:"Founder",sFx:{HEAT:-5}},
  { cat:"Builder", id:"doxx_threat",
    text:"{c} says your identity is close to being revealed. They can stop it — for a price.",
    acc:"Pay up",           aFx:{ETH:-15,HEAT:-15,NETWORK:+3,CLOUT:+3},aVr:{ETH:8,HEAT:8,NETWORK:4,CLOUT:5},
    rej:"Call the bluff",   rFx:{ETH:0,HEAT:+20,NETWORK:-5,CLOUT:-15},rVr:{ETH:4,HEAT:10,NETWORK:5,CLOUT:8},  syn:"Founder",sFx:{HEAT:-5}},
  { cat:"Builder", id:"open_source",
    text:"{c} is open-sourcing their art toolchain. Wants your contributions to ship it.",
    acc:"Contribute",       aFx:{ETH:-3,HEAT:-5,NETWORK:+15,CLOUT:+8},aVr:{ETH:3,HEAT:4,NETWORK:6,CLOUT:6},
    rej:"No time",          rFx:{ETH:0,HEAT:+3,NETWORK:-8,CLOUT:-5}, rVr:{ETH:2,HEAT:3,NETWORK:4,CLOUT:4},   syn:"Builder",sFx:{NETWORK:+5}},

  // ── FOUNDER (20) ──
  { cat:"Founder", id:"vc_round",
    text:"{c} is doing a friends & family round. No KYC. 10x or rug.",
    acc:"Wire in",          aFx:{ETH:+12,HEAT:+8,NETWORK:+10,CLOUT:+5},aVr:{ETH:20,HEAT:8,NETWORK:6,CLOUT:8},
    rej:"Too sketchy",      rFx:{ETH:-3,HEAT:-3,NETWORK:-10,CLOUT:-5},rVr:{ETH:3,HEAT:3,NETWORK:5,CLOUT:5},   syn:"Founder",sFx:{ETH:+8}},
  { cat:"Founder", id:"token_launch",
    text:"{c} is launching a culture token. Early allocation, picking a side publicly.",
    acc:"Ape in",           aFx:{ETH:+12,HEAT:+12,NETWORK:+8,CLOUT:+15},aVr:{ETH:18,HEAT:8,NETWORK:5,CLOUT:12},
    rej:"Too public",       rFx:{ETH:-5,HEAT:0,NETWORK:-8,CLOUT:-10}, rVr:{ETH:4,HEAT:3,NETWORK:5,CLOUT:6},   syn:"Founder",sFx:{ETH:+5}},
  { cat:"Founder", id:"advisory_fee",
    text:"{c} wants to pay your advisory fee in a way that skips tax.",
    acc:"Take the fee",     aFx:{ETH:+15,HEAT:+12,NETWORK:+3,CLOUT:+3},aVr:{ETH:8,HEAT:8,NETWORK:3,CLOUT:4},
    rej:"By the books",     rFx:{ETH:+3,HEAT:-10,NETWORK:0,CLOUT:-5},rVr:{ETH:4,HEAT:5,NETWORK:3,CLOUT:4},   syn:"Founder",sFx:{HEAT:-5}},
  { cat:"Founder", id:"dao_vote",
    text:"{c} is pushing a governance vote to redirect treasury funds toward artists.",
    acc:"Vote yes",         aFx:{ETH:-3,HEAT:+8,NETWORK:+10,CLOUT:+10},aVr:{ETH:3,HEAT:6,NETWORK:5,CLOUT:8},
    rej:"Abstain",          rFx:{ETH:0,HEAT:-5,NETWORK:-8,CLOUT:-8}, rVr:{ETH:3,HEAT:4,NETWORK:4,CLOUT:5},   syn:"Platform",sFx:{CLOUT:+5}},
  { cat:"Founder", id:"marketplace_list",
    text:"{c} is launching a marketplace. Wants you as founding creator.",
    acc:"Join founding",    aFx:{ETH:-5,HEAT:+5,NETWORK:+12,CLOUT:+15},aVr:{ETH:8,HEAT:5,NETWORK:6,CLOUT:10},
    rej:"Too early",        rFx:{ETH:+3,HEAT:-3,NETWORK:-10,CLOUT:-8},rVr:{ETH:3,HEAT:3,NETWORK:5,CLOUT:5},   syn:"Platform",sFx:{NETWORK:+6}},
  { cat:"Founder", id:"rugpull_out",
    text:"{c} says a project is done. Time to quietly exit.",
    acc:"Exit together",    aFx:{ETH:+18,HEAT:+10,NETWORK:+3,CLOUT:-10},aVr:{ETH:18,HEAT:8,NETWORK:5,CLOUT:8},
    rej:"Stay loyal",       rFx:{ETH:-8,HEAT:0,NETWORK:+10,CLOUT:+12},rVr:{ETH:8,HEAT:4,NETWORK:5,CLOUT:6},   syn:"Founder",sFx:{ETH:+6}},
  { cat:"Founder", id:"collab_mint",
    text:"{c} wants to co-sign a 1/1. Your name on it forever.",
    acc:"Co-sign",          aFx:{ETH:+5,HEAT:+5,NETWORK:+8,CLOUT:+20},aVr:{ETH:10,HEAT:5,NETWORK:5,CLOUT:10},
    rej:"Keep distance",    rFx:{ETH:-3,HEAT:-3,NETWORK:-8,CLOUT:-12},rVr:{ETH:3,HEAT:3,NETWORK:4,CLOUT:6},   syn:"Artist",sFx:{CLOUT:+6}},
  { cat:"Founder", id:"stealth_launch",
    text:"{c} is doing a stealth launch with no marketing. Insiders only.",
    acc:"Get in quietly",   aFx:{ETH:+15,HEAT:+5,NETWORK:+5,CLOUT:+5},aVr:{ETH:14,HEAT:5,NETWORK:4,CLOUT:6},
    rej:"Too risky",        rFx:{ETH:-3,HEAT:-3,NETWORK:-5,CLOUT:-3},rVr:{ETH:3,HEAT:3,NETWORK:3,CLOUT:3},   syn:"Founder",sFx:{ETH:+5}},

  // ── PLATFORM (20) ──
  { cat:"Platform", id:"exchange_list",
    text:"{c} can get something listed on a major exchange. Costs ETH upfront.",
    acc:"Pay the fees",     aFx:{ETH:-12,HEAT:+15,NETWORK:+12,CLOUT:+20},aVr:{ETH:8,HEAT:8,NETWORK:6,CLOUT:10},
    rej:"Not interested",   rFx:{ETH:+5,HEAT:-5,NETWORK:-8,CLOUT:-8},rVr:{ETH:4,HEAT:4,NETWORK:5,CLOUT:5},   syn:"Platform",sFx:{CLOUT:+6}},
  { cat:"Platform", id:"emergency_liq",
    text:"{c}'s protocol is 12 hours from insolvency. They need liquidity.",
    acc:"Provide it",       aFx:{ETH:-12,HEAT:+5,NETWORK:+15,CLOUT:+8},aVr:{ETH:14,HEAT:5,NETWORK:6,CLOUT:8},
    rej:"Not my problem",   rFx:{ETH:+5,HEAT:-5,NETWORK:-15,CLOUT:-12},rVr:{ETH:4,HEAT:4,NETWORK:6,CLOUT:6},  syn:"Platform",sFx:{NETWORK:+6}},
  { cat:"Platform", id:"liquidity_pool",
    text:"{c} needs a trusted counterparty for a private LP position.",
    acc:"Provide LP",       aFx:{ETH:+10,HEAT:+8,NETWORK:+8,CLOUT:+5},aVr:{ETH:12,HEAT:6,NETWORK:5,CLOUT:6},
    rej:"Pass",             rFx:{ETH:-3,HEAT:-5,NETWORK:-8,CLOUT:-5},rVr:{ETH:3,HEAT:4,NETWORK:4,CLOUT:4},   syn:"Platform",sFx:{ETH:+5}},
  { cat:"Platform", id:"bridge_hop",
    text:"{c} wants you as an early validator on their cross-chain bridge.",
    acc:"Validate",         aFx:{ETH:+6,HEAT:+10,NETWORK:+10,CLOUT:+5},aVr:{ETH:10,HEAT:8,NETWORK:6,CLOUT:5},
    rej:"Too early",        rFx:{ETH:-3,HEAT:-5,NETWORK:-8,CLOUT:-3},rVr:{ETH:3,HEAT:4,NETWORK:4,CLOUT:3},   syn:"Builder",sFx:{NETWORK:+5}},
  { cat:"Platform", id:"influencer_deal",
    text:"{c} brokered a deal with a major creator to feature your project.",
    acc:"Go ahead",         aFx:{ETH:+12,HEAT:+10,NETWORK:+8,CLOUT:+15},aVr:{ETH:12,HEAT:8,NETWORK:5,CLOUT:10},
    rej:"Too risky",        rFx:{ETH:-5,HEAT:-5,NETWORK:-8,CLOUT:-8},rVr:{ETH:4,HEAT:4,NETWORK:4,CLOUT:5},   syn:"Platform",sFx:{CLOUT:+5}},
  { cat:"Platform", id:"sec_probe",
    text:"{c} has inside knowledge that a platform is being probed.",
    acc:"Withdraw now",     aFx:{ETH:+5,HEAT:-10,NETWORK:-5,CLOUT:0}, aVr:{ETH:6,HEAT:6,NETWORK:4,CLOUT:3},
    rej:"Wait and see",     rFx:{ETH:-15,HEAT:+15,NETWORK:+3,CLOUT:-5},rVr:{ETH:10,HEAT:8,NETWORK:3,CLOUT:5},  syn:"Builder",sFx:{HEAT:-5}},
  { cat:"Platform", id:"data_monetize",
    text:"{c} wants to aggregate and sell on-chain behavioral data. You'd get a cut.",
    acc:"Share the data",   aFx:{ETH:+14,HEAT:+12,NETWORK:+5,CLOUT:-5},aVr:{ETH:8,HEAT:8,NETWORK:4,CLOUT:5},
    rej:"No way",           rFx:{ETH:-3,HEAT:-5,NETWORK:-3,CLOUT:+5},rVr:{ETH:2,HEAT:4,NETWORK:3,CLOUT:4},   syn:"Platform",sFx:{ETH:+4}},

  // ── ARTIST additional (23 more → 46 total) ──
  { cat:"Artist", id:"a_stolen_pfp",
    text:"{c} just found out someone is selling prints of your work without permission. They want to help you draft a public callout.",
    acc:"Go public",     aFx:{ETH:-3,HEAT:+18,NETWORK:+8,CLOUT:+12}, aVr:{ETH:3,HEAT:8,NETWORK:5,CLOUT:8},
    rej:"Let it slide",  rFx:{ETH:+3,HEAT:-5,NETWORK:-5,CLOUT:-8},   rVr:{ETH:2,HEAT:4,NETWORK:3,CLOUT:5}},
  { cat:"Artist", id:"a_generative_drop",
    text:"{c} is launching a 10k generative series and wants your aesthetic as the base layer.",
    acc:"License it",    aFx:{ETH:+14,HEAT:+5,NETWORK:+8,CLOUT:+10}, aVr:{ETH:12,HEAT:4,NETWORK:5,CLOUT:8},
    rej:"Not that kind", rFx:{ETH:-3,HEAT:-3,NETWORK:-5,CLOUT:-5},   rVr:{ETH:2,HEAT:3,NETWORK:3,CLOUT:4}},
  { cat:"Artist", id:"a_museum_digital",
    text:"{c} is curating a digital-native museum show. Long lead time, zero pay, massive legitimacy.",
    acc:"Submit work",   aFx:{ETH:-3,HEAT:-5,NETWORK:+10,CLOUT:+20}, aVr:{ETH:3,HEAT:4,NETWORK:5,CLOUT:10},
    rej:"Can't afford it",rFx:{ETH:0,HEAT:+3,NETWORK:-8,CLOUT:-10},  rVr:{ETH:2,HEAT:3,NETWORK:4,CLOUT:6}},
  { cat:"Artist", id:"a_album_cover",
    text:"{c} is a musician dropping their debut album. They want your visuals for the cover art.",
    acc:"Do the cover",  aFx:{ETH:+8,HEAT:+5,NETWORK:+12,CLOUT:+14}, aVr:{ETH:8,HEAT:4,NETWORK:6,CLOUT:8},
    rej:"Music is different",rFx:{ETH:-3,HEAT:-2,NETWORK:-5,CLOUT:-5},rVr:{ETH:2,HEAT:2,NETWORK:3,CLOUT:4}},
  { cat:"Artist", id:"a_limited_physical",
    text:"{c} is doing a very limited run of signed physical prints. 20 copies, hand-numbered. You'd split revenue.",
    acc:"Do the run",    aFx:{ETH:+12,HEAT:+3,NETWORK:+5,CLOUT:+10}, aVr:{ETH:10,HEAT:3,NETWORK:4,CLOUT:6},
    rej:"Too much hassle",rFx:{ETH:-3,HEAT:-2,NETWORK:-3,CLOUT:-3},  rVr:{ETH:2,HEAT:2,NETWORK:2,CLOUT:2}},
  { cat:"Artist", id:"a_artist_talk",
    text:"{c} is organizing an online artist talk series. They want you to present your process.",
    acc:"Talk about it",  aFx:{ETH:-3,HEAT:-3,NETWORK:+10,CLOUT:+12},aVr:{ETH:2,HEAT:3,NETWORK:5,CLOUT:6},
    rej:"Too exposed",    rFx:{ETH:0,HEAT:-3,NETWORK:-8,CLOUT:-8},   rVr:{ETH:2,HEAT:2,NETWORK:4,CLOUT:5}},
  { cat:"Artist", id:"a_residency_berlin",
    text:"{c} has a studio residency in Berlin. Six weeks, international crowd, fully subsidized.",
    acc:"Go to Berlin",  aFx:{ETH:+5,HEAT:-5,NETWORK:+12,CLOUT:+14}, aVr:{ETH:5,HEAT:4,NETWORK:6,CLOUT:8},
    rej:"Not this time", rFx:{ETH:0,HEAT:+3,NETWORK:-5,CLOUT:-5},    rVr:{ETH:2,HEAT:2,NETWORK:3,CLOUT:4}},
  { cat:"Artist", id:"a_animated_collab",
    text:"{c} is making a short animated film and wants to incorporate your visual language.",
    acc:"Collaborate",   aFx:{ETH:+5,HEAT:+3,NETWORK:+10,CLOUT:+16}, aVr:{ETH:6,HEAT:3,NETWORK:5,CLOUT:8},
    rej:"Wrong medium",  rFx:{ETH:-3,HEAT:-2,NETWORK:-5,CLOUT:-5},   rVr:{ETH:2,HEAT:2,NETWORK:3,CLOUT:4}},
  { cat:"Artist", id:"a_brand_deal",
    text:"{c} brokered a branded content deal. The brand is boring but the number is not.",
    acc:"Take the money",aFx:{ETH:+20,HEAT:+5,NETWORK:+5,CLOUT:-8},  aVr:{ETH:12,HEAT:5,NETWORK:4,CLOUT:6},
    rej:"Stay independent",rFx:{ETH:-5,HEAT:-5,NETWORK:-3,CLOUT:+8}, rVr:{ETH:3,HEAT:4,NETWORK:3,CLOUT:5}},
  { cat:"Artist", id:"a_twitter_drama",
    text:"{c} is getting dragged on CT for their pricing. They want you to publicly defend them.",
    acc:"Defend them",   aFx:{ETH:0,HEAT:+18,NETWORK:+5,CLOUT:+10},  aVr:{ETH:2,HEAT:10,NETWORK:5,CLOUT:8},
    rej:"Stay neutral",  rFx:{ETH:0,HEAT:-5,NETWORK:-8,CLOUT:-8},    rVr:{ETH:2,HEAT:4,NETWORK:4,CLOUT:5}},
  { cat:"Artist", id:"a_exclusive_gallery",
    text:"{c} was offered an exclusive gallery deal: one gallery handles all your secondary sales for 2 years.",
    acc:"Sign it",       aFx:{ETH:+10,HEAT:-3,NETWORK:-5,CLOUT:+10}, aVr:{ETH:10,HEAT:3,NETWORK:4,CLOUT:8},
    rej:"Stay free",     rFx:{ETH:-5,HEAT:-3,NETWORK:+5,CLOUT:-5},   rVr:{ETH:3,HEAT:2,NETWORK:3,CLOUT:4}},
  { cat:"Artist", id:"a_ai_training_data",
    text:"{c} is negotiating a deal to license art for AI training data. Big money, massive controversy.",
    acc:"License it",    aFx:{ETH:+25,HEAT:+25,NETWORK:+3,CLOUT:-15},aVr:{ETH:15,HEAT:12,NETWORK:4,CLOUT:10},
    rej:"Absolutely not",rFx:{ETH:-5,HEAT:-10,NETWORK:+8,CLOUT:+10}, rVr:{ETH:3,HEAT:5,NETWORK:4,CLOUT:6}},
  { cat:"Artist", id:"a_delist_threat",
    text:"{c} says a major platform is threatening to delist work over a rights dispute. You need to decide fast.",
    acc:"Fight the delist",aFx:{ETH:-5,HEAT:+15,NETWORK:+8,CLOUT:+8},aVr:{ETH:4,HEAT:8,NETWORK:5,CLOUT:6},
    rej:"Quietly comply", rFx:{ETH:+5,HEAT:-10,NETWORK:-5,CLOUT:-8}, rVr:{ETH:3,HEAT:5,NETWORK:3,CLOUT:5}},
  { cat:"Artist", id:"a_grant_application",
    text:"{c} tells you about a cultural grant for digital artists. Deadline is tomorrow. Chance of success: 30%.",
    acc:"Apply tonight",  aFx:{ETH:+15,HEAT:-8,NETWORK:+5,CLOUT:+8}, aVr:{ETH:20,HEAT:5,NETWORK:4,CLOUT:6},
    rej:"Too stressful",  rFx:{ETH:-3,HEAT:-3,NETWORK:-3,CLOUT:-3},  rVr:{ETH:2,HEAT:2,NETWORK:2,CLOUT:2}},
  { cat:"Artist", id:"a_fake_collection",
    text:"{c} discovers someone minted a fake collection using your name. Help expose it or go quiet.",
    acc:"Expose it now",  aFx:{ETH:-3,HEAT:+15,NETWORK:+10,CLOUT:+12},aVr:{ETH:3,HEAT:8,NETWORK:5,CLOUT:8},
    rej:"Don't feed it",  rFx:{ETH:0,HEAT:+5,NETWORK:-5,CLOUT:-8},   rVr:{ETH:2,HEAT:4,NETWORK:3,CLOUT:5}},
  { cat:"Artist", id:"a_longtime_collab",
    text:"{c} has been your creative partner for years. They need you to co-sign a piece that's a bit out of your lane.",
    acc:"Ride for them",  aFx:{ETH:+5,HEAT:+5,NETWORK:+8,CLOUT:+15}, aVr:{ETH:6,HEAT:5,NETWORK:5,CLOUT:8},
    rej:"Not this time",  rFx:{ETH:0,HEAT:-5,NETWORK:-8,CLOUT:-10},  rVr:{ETH:2,HEAT:4,NETWORK:4,CLOUT:6}},
  { cat:"Artist", id:"a_stolen_inspiration",
    text:"{c} tells you a big-name artist clearly ripped your visual style without credit.",
    acc:"Call it out",    aFx:{ETH:0,HEAT:+20,NETWORK:+8,CLOUT:+15}, aVr:{ETH:3,HEAT:10,NETWORK:5,CLOUT:10},
    rej:"Live with it",   rFx:{ETH:0,HEAT:-8,NETWORK:-5,CLOUT:-12},  rVr:{ETH:2,HEAT:5,NETWORK:4,CLOUT:6}},
  { cat:"Artist", id:"a_vr_world",
    text:"{c} is building a virtual gallery world and wants your work as the centerpiece environment.",
    acc:"Build it out",   aFx:{ETH:+5,HEAT:+5,NETWORK:+12,CLOUT:+18},aVr:{ETH:8,HEAT:4,NETWORK:6,CLOUT:10},
    rej:"Not into VR",    rFx:{ETH:-3,HEAT:-3,NETWORK:-5,CLOUT:-8},  rVr:{ETH:2,HEAT:3,NETWORK:3,CLOUT:5}},
  { cat:"Artist", id:"a_price_floor_raise",
    text:"{c} is coordinating a group of artists to collectively raise their floor prices simultaneously.",
    acc:"Join the pact",  aFx:{ETH:+12,HEAT:+8,NETWORK:+8,CLOUT:+10},aVr:{ETH:10,HEAT:6,NETWORK:5,CLOUT:6},
    rej:"Stay independent",rFx:{ETH:-5,HEAT:-3,NETWORK:-5,CLOUT:-3}, rVr:{ETH:3,HEAT:3,NETWORK:3,CLOUT:3}},
  { cat:"Artist", id:"a_festival_commission",
    text:"{c} got you a commission from an IRL festival to produce a large-scale digital installation.",
    acc:"Take it",        aFx:{ETH:+18,HEAT:+3,NETWORK:+12,CLOUT:+18},aVr:{ETH:10,HEAT:4,NETWORK:6,CLOUT:10},
    rej:"Too much work",  rFx:{ETH:-5,HEAT:-3,NETWORK:-8,CLOUT:-10}, rVr:{ETH:3,HEAT:3,NETWORK:4,CLOUT:6}},
  { cat:"Artist", id:"a_ghost_commission",
    text:"{c} offers you a well-paid ghost commission — you make it, they sell it under their name.",
    acc:"Take the money", aFx:{ETH:+18,HEAT:+5,NETWORK:-3,CLOUT:-5}, aVr:{ETH:10,HEAT:4,NETWORK:3,CLOUT:5},
    rej:"Own your work",  rFx:{ETH:-5,HEAT:-3,NETWORK:+3,CLOUT:+5},  rVr:{ETH:3,HEAT:3,NETWORK:3,CLOUT:3}},
  { cat:"Artist", id:"a_selfie_meme_blowup",
    text:"{c} wants to turn one of your pieces into a meme template. You'd lose control but gain massive reach.",
    acc:"Let it happen",  aFx:{ETH:+5,HEAT:+12,NETWORK:+15,CLOUT:+18},aVr:{ETH:6,HEAT:8,NETWORK:8,CLOUT:12},
    rej:"Protect the work",rFx:{ETH:-3,HEAT:-3,NETWORK:-10,CLOUT:-10},rVr:{ETH:2,HEAT:3,NETWORK:5,CLOUT:6}},
  { cat:"Artist", id:"a_write_manifesto",
    text:"{c} wants you to co-author a manifesto about the future of digital art. Very public, very divisive.",
    acc:"Sign the manifesto",aFx:{ETH:-3,HEAT:+10,NETWORK:+12,CLOUT:+16},aVr:{ETH:3,HEAT:6,NETWORK:6,CLOUT:8},
    rej:"Let others talk", rFx:{ETH:0,HEAT:-5,NETWORK:-8,CLOUT:-8},  rVr:{ETH:2,HEAT:4,NETWORK:4,CLOUT:5}},

  // ── COLLECTOR additional (16 more → 26 total) ──
  { cat:"Collector", id:"c_rare_find",
    text:"{c} spotted a misattributed piece selling for 10% of its real value. Act fast.",
    acc:"Grab it",        aFx:{ETH:-15,HEAT:+5,NETWORK:+8,CLOUT:+12},aVr:{ETH:12,HEAT:4,NETWORK:5,CLOUT:8},
    rej:"Too risky",      rFx:{ETH:+5,HEAT:-3,NETWORK:-5,CLOUT:-5},  rVr:{ETH:3,HEAT:3,NETWORK:3,CLOUT:4}},
  { cat:"Collector", id:"c_whitelist_spot",
    text:"{c} has a free whitelist slot for a project with strong fundamentals. 24-hour window.",
    acc:"Take the spot",  aFx:{ETH:-8,HEAT:+8,NETWORK:+8,CLOUT:+10}, aVr:{ETH:10,HEAT:5,NETWORK:5,CLOUT:6},
    rej:"Pass",           rFx:{ETH:+3,HEAT:-3,NETWORK:-5,CLOUT:-5},  rVr:{ETH:3,HEAT:3,NETWORK:3,CLOUT:4}},
  { cat:"Collector", id:"c_flip_strategy",
    text:"{c} has a flip strategy for a hyped drop. Get in, get out within 6 hours.",
    acc:"Execute the flip",aFx:{ETH:+20,HEAT:+10,NETWORK:+3,CLOUT:+5},aVr:{ETH:18,HEAT:6,NETWORK:3,CLOUT:4},
    rej:"Too risky",       rFx:{ETH:-5,HEAT:-5,NETWORK:-3,CLOUT:-3}, rVr:{ETH:4,HEAT:4,NETWORK:2,CLOUT:3}},
  { cat:"Collector", id:"c_coordinated_buy",
    text:"{c} is coordinating a group buy to prop up a project's floor and flip together.",
    acc:"Join the group",  aFx:{ETH:+15,HEAT:+12,NETWORK:+8,CLOUT:+5},aVr:{ETH:15,HEAT:8,NETWORK:5,CLOUT:5},
    rej:"Sit this one out", rFx:{ETH:-5,HEAT:-8,NETWORK:-5,CLOUT:-5},rVr:{ETH:4,HEAT:5,NETWORK:3,CLOUT:4}},
  { cat:"Collector", id:"c_portfolio_review",
    text:"{c} wants to do a public portfolio review on their popular stream. Visibility for your holdings.",
    acc:"Go public",       aFx:{ETH:0,HEAT:+10,NETWORK:+12,CLOUT:+15},aVr:{ETH:2,HEAT:6,NETWORK:6,CLOUT:8},
    rej:"Private portfolio",rFx:{ETH:0,HEAT:-5,NETWORK:-8,CLOUT:-8}, rVr:{ETH:2,HEAT:4,NETWORK:4,CLOUT:5}},
  { cat:"Collector", id:"c_rug_warning",
    text:"{c} has insider intel that a project you're both in is about to rug.",
    acc:"Exit quietly",    aFx:{ETH:+15,HEAT:+12,NETWORK:-5,CLOUT:-5},aVr:{ETH:10,HEAT:8,NETWORK:4,CLOUT:5},
    rej:"Hold your bags",  rFx:{ETH:-20,HEAT:-5,NETWORK:+5,CLOUT:+3},rVr:{ETH:15,HEAT:5,NETWORK:4,CLOUT:4}},
  { cat:"Collector", id:"c_delegate_vote",
    text:"{c} needs your voting power delegated for a major DAO governance proposal.",
    acc:"Delegate it",     aFx:{ETH:0,HEAT:+5,NETWORK:+12,CLOUT:+8}, aVr:{ETH:2,HEAT:4,NETWORK:6,CLOUT:5},
    rej:"Keep your vote",  rFx:{ETH:0,HEAT:-5,NETWORK:-8,CLOUT:-5},  rVr:{ETH:2,HEAT:3,NETWORK:4,CLOUT:4}},
  { cat:"Collector", id:"c_loan_a_piece",
    text:"{c} wants to borrow a piece from your collection to display at their gallery opening.",
    acc:"Lend it out",     aFx:{ETH:0,HEAT:-5,NETWORK:+10,CLOUT:+12},aVr:{ETH:2,HEAT:4,NETWORK:5,CLOUT:6},
    rej:"Not a lending library",rFx:{ETH:0,HEAT:+3,NETWORK:-8,CLOUT:-8},rVr:{ETH:2,HEAT:3,NETWORK:4,CLOUT:5}},
  { cat:"Collector", id:"c_fractional",
    text:"{c} wants to fractionalize a blue-chip piece you both hold. Liquidity now, loss of full ownership.",
    acc:"Fractionalize it",aFx:{ETH:+12,HEAT:+5,NETWORK:+8,CLOUT:+5},aVr:{ETH:10,HEAT:4,NETWORK:5,CLOUT:4},
    rej:"Stay whole",      rFx:{ETH:-5,HEAT:-3,NETWORK:-3,CLOUT:+3}, rVr:{ETH:3,HEAT:3,NETWORK:3,CLOUT:3}},
  { cat:"Collector", id:"c_early_access_deal",
    text:"{c} can get you early access to a private collector club. Annual dues, but connections are real.",
    acc:"Join the club",   aFx:{ETH:-12,HEAT:-3,NETWORK:+15,CLOUT:+12},aVr:{ETH:8,HEAT:3,NETWORK:6,CLOUT:6},
    rej:"Too expensive",   rFx:{ETH:+5,HEAT:-3,NETWORK:-10,CLOUT:-8},rVr:{ETH:3,HEAT:3,NETWORK:5,CLOUT:5}},
  { cat:"Collector", id:"c_artist_support",
    text:"{c} suggests buying directly from an emerging artist at a high price to support them publicly.",
    acc:"Buy the piece",   aFx:{ETH:-12,HEAT:-8,NETWORK:+10,CLOUT:+14},aVr:{ETH:8,HEAT:5,NETWORK:5,CLOUT:8},
    rej:"Wait for secondary",rFx:{ETH:+5,HEAT:+3,NETWORK:-8,CLOUT:-10},rVr:{ETH:3,HEAT:3,NETWORK:4,CLOUT:6}},
  { cat:"Collector", id:"c_cold_wallet_flex",
    text:"{c} organizes a cold wallet flex event — display your best hold publicly for clout.",
    acc:"Flex it",         aFx:{ETH:0,HEAT:+10,NETWORK:+5,CLOUT:+18}, aVr:{ETH:2,HEAT:6,NETWORK:4,CLOUT:10},
    rej:"Stay anonymous",  rFx:{ETH:0,HEAT:-8,NETWORK:-5,CLOUT:-10}, rVr:{ETH:2,HEAT:5,NETWORK:3,CLOUT:6}},
  { cat:"Collector", id:"c_emergency_liquidity",
    text:"{c} needs to liquidate fast. You can acquire a trophy piece at a heavy discount.",
    acc:"Buy at discount", aFx:{ETH:-20,HEAT:+5,NETWORK:+5,CLOUT:+20},aVr:{ETH:15,HEAT:4,NETWORK:4,CLOUT:10},
    rej:"Not right now",   rFx:{ETH:+8,HEAT:-3,NETWORK:-5,CLOUT:-8}, rVr:{ETH:5,HEAT:3,NETWORK:3,CLOUT:5}},
  { cat:"Collector", id:"c_suspicious_provenance",
    text:"{c} found a high-value piece with unclear provenance. Could be a steal or a legal mess.",
    acc:"Take the risk",   aFx:{ETH:+18,HEAT:+15,NETWORK:+3,CLOUT:+5},aVr:{ETH:20,HEAT:12,NETWORK:4,CLOUT:6},
    rej:"Provenance matters",rFx:{ETH:-3,HEAT:-8,NETWORK:+3,CLOUT:+3},rVr:{ETH:3,HEAT:5,NETWORK:3,CLOUT:3}},
  { cat:"Collector", id:"c_write_review",
    text:"{c} asks you to write an honest public review of a project you collected early.",
    acc:"Write it",        aFx:{ETH:-3,HEAT:+8,NETWORK:+10,CLOUT:+12},aVr:{ETH:2,HEAT:5,NETWORK:5,CLOUT:6},
    rej:"Prefer silence",  rFx:{ETH:0,HEAT:-5,NETWORK:-8,CLOUT:-8},  rVr:{ETH:2,HEAT:3,NETWORK:4,CLOUT:5}},
  { cat:"Collector", id:"c_nft_lending",
    text:"{c} found a protocol that lets you earn yield on NFTs. Novel, untested, potentially lucrative.",
    acc:"Deposit your NFTs",aFx:{ETH:+15,HEAT:+8,NETWORK:+5,CLOUT:+3},aVr:{ETH:15,HEAT:6,NETWORK:4,CLOUT:4},
    rej:"Too experimental", rFx:{ETH:-3,HEAT:-5,NETWORK:-3,CLOUT:+3},rVr:{ETH:3,HEAT:4,NETWORK:3,CLOUT:3}},

  // ── BUILDER additional (16 more → 25 total) ──
  { cat:"Builder", id:"b_exploit_found",
    text:"{c} discovered a live exploit in a major protocol. Report it for a bounty or stay quiet.",
    acc:"Claim the bounty",aFx:{ETH:+15,HEAT:-10,NETWORK:+10,CLOUT:+10},aVr:{ETH:10,HEAT:5,NETWORK:5,CLOUT:6},
    rej:"Say nothing",     rFx:{ETH:+5,HEAT:+15,NETWORK:-5,CLOUT:-5}, rVr:{ETH:5,HEAT:8,NETWORK:4,CLOUT:4}},
  { cat:"Builder", id:"b_fork_drama",
    text:"{c} wants to fork a struggling project and relaunch it. The original community will be angry.",
    acc:"Fork it",         aFx:{ETH:+10,HEAT:+15,NETWORK:+8,CLOUT:+5},aVr:{ETH:10,HEAT:8,NETWORK:5,CLOUT:5},
    rej:"Don't touch it",  rFx:{ETH:-3,HEAT:-8,NETWORK:-5,CLOUT:+3}, rVr:{ETH:3,HEAT:5,NETWORK:3,CLOUT:3}},
  { cat:"Builder", id:"b_token_airdrop",
    text:"{c} is engineering an airdrop to bootstrap a community. You'd help design the criteria.",
    acc:"Design the drop",  aFx:{ETH:-5,HEAT:+10,NETWORK:+15,CLOUT:+10},aVr:{ETH:5,HEAT:6,NETWORK:6,CLOUT:6},
    rej:"Not my circus",   rFx:{ETH:+3,HEAT:-5,NETWORK:-8,CLOUT:-5}, rVr:{ETH:2,HEAT:4,NETWORK:4,CLOUT:4}},
  { cat:"Builder", id:"b_audit_skip",
    text:"{c} wants to ship a contract without a full audit to beat a competitor to market.",
    acc:"Ship it fast",    aFx:{ETH:+10,HEAT:+15,NETWORK:+8,CLOUT:+5},aVr:{ETH:15,HEAT:10,NETWORK:5,CLOUT:5},
    rej:"Audit first",     rFx:{ETH:-5,HEAT:-8,NETWORK:-3,CLOUT:+5}, rVr:{ETH:3,HEAT:5,NETWORK:3,CLOUT:3}},
  { cat:"Builder", id:"b_api_backdoor",
    text:"{c} suggests leaving a quiet backdoor in the API for emergency intervention. Nobody will know.",
    acc:"Add the backdoor",aFx:{ETH:+8,HEAT:+18,NETWORK:+3,CLOUT:-3},aVr:{ETH:8,HEAT:10,NETWORK:3,CLOUT:4},
    rej:"Clean code only", rFx:{ETH:-3,HEAT:-10,NETWORK:+5,CLOUT:+5},rVr:{ETH:2,HEAT:5,NETWORK:4,CLOUT:4}},
  { cat:"Builder", id:"b_copycat_contract",
    text:"{c} wants to clone a competitor's contract and rebrand it. Legal gray zone, fast deployment.",
    acc:"Clone and ship",  aFx:{ETH:+12,HEAT:+12,NETWORK:+5,CLOUT:-3},aVr:{ETH:10,HEAT:8,NETWORK:4,CLOUT:4},
    rej:"Build from scratch",rFx:{ETH:-8,HEAT:-5,NETWORK:+3,CLOUT:+5},rVr:{ETH:5,HEAT:4,NETWORK:3,CLOUT:4}},
  { cat:"Builder", id:"b_dao_takeover",
    text:"{c} has enough governance tokens to force a proposal through. Power move.",
    acc:"Force the vote",  aFx:{ETH:+5,HEAT:+20,NETWORK:+8,CLOUT:+10},aVr:{ETH:5,HEAT:10,NETWORK:5,CLOUT:8},
    rej:"Play it straight", rFx:{ETH:-3,HEAT:-8,NETWORK:+5,CLOUT:+3},rVr:{ETH:2,HEAT:5,NETWORK:4,CLOUT:3}},
  { cat:"Builder", id:"b_infra_shortcut",
    text:"{c} found a way to reduce infrastructure costs by 80% — but it centralizes a key component.",
    acc:"Take the shortcut",aFx:{ETH:+15,HEAT:+8,NETWORK:-5,CLOUT:-3},aVr:{ETH:8,HEAT:6,NETWORK:4,CLOUT:3},
    rej:"Stay decentralized",rFx:{ETH:-8,HEAT:-5,NETWORK:+8,CLOUT:+5},rVr:{ETH:5,HEAT:4,NETWORK:5,CLOUT:4}},
  { cat:"Builder", id:"b_competitor_intel",
    text:"{c} accidentally received a competitor's roadmap. The edge is real but the ethics aren't.",
    acc:"Use the intel",   aFx:{ETH:+10,HEAT:+12,NETWORK:+5,CLOUT:+3},aVr:{ETH:8,HEAT:8,NETWORK:4,CLOUT:3},
    rej:"Delete and move on",rFx:{ETH:-5,HEAT:-8,NETWORK:+5,CLOUT:+8},rVr:{ETH:3,HEAT:5,NETWORK:3,CLOUT:5}},
  { cat:"Builder", id:"b_hackathon_win",
    text:"{c} wants you to join their hackathon team. Prize is small but the network is the real value.",
    acc:"Join the team",   aFx:{ETH:+5,HEAT:-3,NETWORK:+15,CLOUT:+10},aVr:{ETH:5,HEAT:3,NETWORK:6,CLOUT:6},
    rej:"No bandwidth",    rFx:{ETH:-3,HEAT:-2,NETWORK:-8,CLOUT:-5}, rVr:{ETH:2,HEAT:2,NETWORK:4,CLOUT:4}},
  { cat:"Builder", id:"b_whitepaper_ghost",
    text:"{c} wants you to ghostwrite their whitepaper. Significant fee, zero credit.",
    acc:"Write the paper",  aFx:{ETH:+18,HEAT:+5,NETWORK:-3,CLOUT:-5},aVr:{ETH:10,HEAT:4,NETWORK:3,CLOUT:4},
    rej:"Put my name on it",rFx:{ETH:-5,HEAT:-3,NETWORK:+3,CLOUT:+5},rVr:{ETH:3,HEAT:3,NETWORK:3,CLOUT:3}},
  { cat:"Builder", id:"b_node_validator",
    text:"{c} needs a trusted wallet to run a validator node. Staking required, rewards guaranteed.",
    acc:"Run the node",    aFx:{ETH:+10,HEAT:-3,NETWORK:+10,CLOUT:+5},aVr:{ETH:10,HEAT:3,NETWORK:5,CLOUT:4},
    rej:"Too much lockup", rFx:{ETH:-3,HEAT:-2,NETWORK:-5,CLOUT:-3}, rVr:{ETH:3,HEAT:2,NETWORK:3,CLOUT:3}},
  { cat:"Builder", id:"b_fake_traction",
    text:"{c} wants to inflate usage metrics before a funding round. Technically just bots.",
    acc:"Inflate the numbers",aFx:{ETH:+15,HEAT:+18,NETWORK:+5,CLOUT:-5},aVr:{ETH:10,HEAT:10,NETWORK:4,CLOUT:5},
    rej:"Real growth only", rFx:{ETH:-5,HEAT:-10,NETWORK:+3,CLOUT:+8},rVr:{ETH:3,HEAT:5,NETWORK:3,CLOUT:5}},
  { cat:"Builder", id:"b_open_source_fork_profit",
    text:"{c} wants to monetize an MIT-licensed open source project they didn't build.",
    acc:"Monetize it",     aFx:{ETH:+14,HEAT:+12,NETWORK:-3,CLOUT:-5},aVr:{ETH:10,HEAT:8,NETWORK:3,CLOUT:5},
    rej:"Give credit",     rFx:{ETH:-5,HEAT:-8,NETWORK:+8,CLOUT:+8}, rVr:{ETH:3,HEAT:5,NETWORK:4,CLOUT:5}},
  { cat:"Builder", id:"b_emergency_patch",
    text:"{c} found a critical bug in a live contract. It needs an emergency patch right now, no testing.",
    acc:"Deploy the patch", aFx:{ETH:+3,HEAT:+8,NETWORK:+12,CLOUT:+10},aVr:{ETH:5,HEAT:8,NETWORK:5,CLOUT:6},
    rej:"Wait for review",  rFx:{ETH:-10,HEAT:+12,NETWORK:-3,CLOUT:-5},rVr:{ETH:8,HEAT:8,NETWORK:4,CLOUT:4}},
  { cat:"Builder", id:"b_privacy_tool",
    text:"{c} is building a privacy layer for on-chain transactions. Useful and controversial in equal parts.",
    acc:"Help build it",   aFx:{ETH:+8,HEAT:+12,NETWORK:+10,CLOUT:+5},aVr:{ETH:8,HEAT:8,NETWORK:5,CLOUT:4},
    rej:"Too much heat",   rFx:{ETH:-3,HEAT:-8,NETWORK:-5,CLOUT:+3}, rVr:{ETH:3,HEAT:5,NETWORK:3,CLOUT:3}},

  // ── FOUNDER additional (17 more → 25 total) ──
  { cat:"Founder", id:"f_pivot_hard",
    text:"{c} wants to completely pivot the project's direction after 8 months of building.",
    acc:"Back the pivot",  aFx:{ETH:+5,HEAT:+10,NETWORK:+5,CLOUT:-5}, aVr:{ETH:8,HEAT:8,NETWORK:5,CLOUT:5},
    rej:"Stay the course", rFx:{ETH:-5,HEAT:-5,NETWORK:+5,CLOUT:+5},  rVr:{ETH:4,HEAT:5,NETWORK:4,CLOUT:4}},
  { cat:"Founder", id:"f_silent_investor",
    text:"{c} found a silent investor willing to put in big. The investor wants no public mention.",
    acc:"Take the deal",   aFx:{ETH:+20,HEAT:+5,NETWORK:-5,CLOUT:-5}, aVr:{ETH:15,HEAT:5,NETWORK:4,CLOUT:5},
    rej:"Transparency only",rFx:{ETH:-5,HEAT:-5,NETWORK:+8,CLOUT:+8}, rVr:{ETH:4,HEAT:4,NETWORK:4,CLOUT:5}},
  { cat:"Founder", id:"f_acquihire_offer",
    text:"{c} has an acquihire offer from a major player. Life-changing money, project gets shelved.",
    acc:"Take the exit",   aFx:{ETH:+30,HEAT:+5,NETWORK:-10,CLOUT:-15},aVr:{ETH:15,HEAT:5,NETWORK:6,CLOUT:8},
    rej:"Keep building",   rFx:{ETH:-8,HEAT:-3,NETWORK:+10,CLOUT:+12},rVr:{ETH:6,HEAT:4,NETWORK:5,CLOUT:6}},
  { cat:"Founder", id:"f_paid_pr",
    text:"{c} can get you covered in three major crypto publications. It costs ETH and reads like an ad.",
    acc:"Buy the coverage", aFx:{ETH:-12,HEAT:+8,NETWORK:+10,CLOUT:+15},aVr:{ETH:8,HEAT:6,NETWORK:5,CLOUT:8},
    rej:"Earn coverage",   rFx:{ETH:+5,HEAT:-5,NETWORK:-8,CLOUT:-8},  rVr:{ETH:3,HEAT:4,NETWORK:4,CLOUT:5}},
  { cat:"Founder", id:"f_fake_roadmap",
    text:"{c} wants to publish an ambitious roadmap knowing half of it won't ship. Hype is the strategy.",
    acc:"Publish the roadmap",aFx:{ETH:+8,HEAT:+15,NETWORK:+10,CLOUT:+12},aVr:{ETH:8,HEAT:10,NETWORK:5,CLOUT:8},
    rej:"Ship before you hype",rFx:{ETH:-5,HEAT:-8,NETWORK:+5,CLOUT:+5},rVr:{ETH:3,HEAT:5,NETWORK:4,CLOUT:4}},
  { cat:"Founder", id:"f_kol_deal",
    text:"{c} can get a top KOL to shill the project. Undisclosed paid deal.",
    acc:"Pay the KOL",     aFx:{ETH:-10,HEAT:+15,NETWORK:+12,CLOUT:+18},aVr:{ETH:8,HEAT:8,NETWORK:6,CLOUT:10},
    rej:"Organic only",    rFx:{ETH:+5,HEAT:-8,NETWORK:-8,CLOUT:-10}, rVr:{ETH:3,HEAT:5,NETWORK:4,CLOUT:6}},
  { cat:"Founder", id:"f_second_project",
    text:"{c} wants you to co-found a second project while the first is still in progress.",
    acc:"Go for it",       aFx:{ETH:+10,HEAT:+10,NETWORK:+8,CLOUT:+8},aVr:{ETH:10,HEAT:8,NETWORK:5,CLOUT:6},
    rej:"One thing at a time",rFx:{ETH:-5,HEAT:-5,NETWORK:-3,CLOUT:+5},rVr:{ETH:3,HEAT:4,NETWORK:3,CLOUT:4}},
  { cat:"Founder", id:"f_community_vote_ignore",
    text:"{c} says the community voted one way but it doesn't serve the project's growth. Overrule it?",
    acc:"Overrule the vote",aFx:{ETH:+8,HEAT:+18,NETWORK:-5,CLOUT:-8},aVr:{ETH:8,HEAT:10,NETWORK:5,CLOUT:6},
    rej:"Respect the vote", rFx:{ETH:-5,HEAT:-8,NETWORK:+10,CLOUT:+8},rVr:{ETH:3,HEAT:5,NETWORK:5,CLOUT:5}},
  { cat:"Founder", id:"f_layoff_quietly",
    text:"{c} suggests quietly laying off half the team and framing it as a restructuring.",
    acc:"Do the restructuring",aFx:{ETH:+15,HEAT:+12,NETWORK:-5,CLOUT:-8},aVr:{ETH:10,HEAT:8,NETWORK:5,CLOUT:6},
    rej:"Be transparent",  rFx:{ETH:-8,HEAT:-5,NETWORK:+8,CLOUT:+8},  rVr:{ETH:5,HEAT:5,NETWORK:4,CLOUT:5}},
  { cat:"Founder", id:"f_launch_token_early",
    text:"{c} is pushing to launch the token 6 months early while the hype cycle is hot.",
    acc:"Launch now",      aFx:{ETH:+20,HEAT:+15,NETWORK:+8,CLOUT:+12},aVr:{ETH:18,HEAT:10,NETWORK:5,CLOUT:8},
    rej:"Wait for product fit",rFx:{ETH:-5,HEAT:-8,NETWORK:+5,CLOUT:+5},rVr:{ETH:4,HEAT:5,NETWORK:4,CLOUT:4}},
  { cat:"Founder", id:"f_conference_speak",
    text:"{c} got you a speaking slot at a major web3 conference. Center-stage, center of attention.",
    acc:"Take the stage",  aFx:{ETH:-3,HEAT:+8,NETWORK:+15,CLOUT:+18},aVr:{ETH:3,HEAT:5,NETWORK:6,CLOUT:10},
    rej:"Not ready yet",   rFx:{ETH:0,HEAT:-5,NETWORK:-10,CLOUT:-10}, rVr:{ETH:2,HEAT:4,NETWORK:5,CLOUT:6}},
  { cat:"Founder", id:"f_resign_ceo",
    text:"{c} suggests you step back as the public face to reduce heat and bring in a professional CEO.",
    acc:"Step back",       aFx:{ETH:+5,HEAT:-15,NETWORK:+5,CLOUT:-10},aVr:{ETH:5,HEAT:8,NETWORK:5,CLOUT:8},
    rej:"Stay at the helm", rFx:{ETH:-5,HEAT:+10,NETWORK:-3,CLOUT:+8},rVr:{ETH:4,HEAT:6,NETWORK:4,CLOUT:5}},
  { cat:"Founder", id:"f_copy_tokenomics",
    text:"{c} wants to copy a proven tokenomics model from a competitor and slightly rebrand it.",
    acc:"Copy the model",  aFx:{ETH:+10,HEAT:+10,NETWORK:+5,CLOUT:-5},aVr:{ETH:8,HEAT:7,NETWORK:4,CLOUT:5},
    rej:"Design your own", rFx:{ETH:-8,HEAT:-5,NETWORK:+5,CLOUT:+8},  rVr:{ETH:5,HEAT:4,NETWORK:4,CLOUT:5}},
  { cat:"Founder", id:"f_investor_day",
    text:"{c} wants to organize an investor day showing bullish metrics. Some of them are... projected.",
    acc:"Run the event",   aFx:{ETH:+12,HEAT:+12,NETWORK:+10,CLOUT:+12},aVr:{ETH:10,HEAT:8,NETWORK:5,CLOUT:8},
    rej:"Show real numbers",rFx:{ETH:-5,HEAT:-8,NETWORK:+5,CLOUT:+5},  rVr:{ETH:4,HEAT:5,NETWORK:4,CLOUT:4}},
  { cat:"Founder", id:"f_leak_competitor",
    text:"{c} has damaging info about a competitor. Leak it anonymously or hold onto it.",
    acc:"Leak it",         aFx:{ETH:0,HEAT:+20,NETWORK:+8,CLOUT:+10}, aVr:{ETH:3,HEAT:10,NETWORK:5,CLOUT:8},
    rej:"Hold your fire",  rFx:{ETH:0,HEAT:-8,NETWORK:-5,CLOUT:+3},   rVr:{ETH:2,HEAT:5,NETWORK:3,CLOUT:3}},
  { cat:"Founder", id:"f_treasury_yield",
    text:"{c} wants to put project treasury funds into a high-yield DeFi protocol. Juicy APY, smart contract risk.",
    acc:"Deploy the funds", aFx:{ETH:+18,HEAT:+10,NETWORK:+3,CLOUT:+3},aVr:{ETH:20,HEAT:8,NETWORK:3,CLOUT:3},
    rej:"Keep it safe",    rFx:{ETH:-3,HEAT:-5,NETWORK:+3,CLOUT:+3},  rVr:{ETH:3,HEAT:4,NETWORK:2,CLOUT:2}},
  { cat:"Founder", id:"f_celebrity_deal",
    text:"{c} landed a celebrity ambassador deal. They know nothing about the space but their audience is huge.",
    acc:"Sign the celebrity",aFx:{ETH:-15,HEAT:+10,NETWORK:+15,CLOUT:+25},aVr:{ETH:10,HEAT:8,NETWORK:8,CLOUT:12},
    rej:"Authenticity first",rFx:{ETH:+5,HEAT:-5,NETWORK:-8,CLOUT:-10},rVr:{ETH:3,HEAT:4,NETWORK:5,CLOUT:6}},

  // ── PLATFORM additional (13 more → 20 total) ──
  { cat:"Platform", id:"p_vc_term_sheet",
    text:"{c} has a VC term sheet on the table. Standard terms, but they want a board seat.",
    acc:"Sign the term sheet",aFx:{ETH:+25,HEAT:+5,NETWORK:+10,CLOUT:+10},aVr:{ETH:15,HEAT:5,NETWORK:5,CLOUT:6},
    rej:"Stay bootstrapped",  rFx:{ETH:-8,HEAT:-5,NETWORK:+5,CLOUT:+8}, rVr:{ETH:5,HEAT:4,NETWORK:4,CLOUT:5}},
  { cat:"Platform", id:"p_ban_artist",
    text:"{c} is pressuring you to ban a controversial artist from the platform. Community is divided.",
    acc:"Enforce the ban",   aFx:{ETH:+5,HEAT:+15,NETWORK:-5,CLOUT:-8},aVr:{ETH:4,HEAT:8,NETWORK:5,CLOUT:6},
    rej:"Protect the artist", rFx:{ETH:-5,HEAT:-8,NETWORK:+10,CLOUT:+10},rVr:{ETH:3,HEAT:5,NETWORK:5,CLOUT:6}},
  { cat:"Platform", id:"p_fee_hike",
    text:"{c} is proposing a platform fee increase. Revenue goes up, creator trust goes down.",
    acc:"Raise the fees",    aFx:{ETH:+18,HEAT:+12,NETWORK:-8,CLOUT:-10},aVr:{ETH:10,HEAT:8,NETWORK:5,CLOUT:6},
    rej:"Keep fees low",     rFx:{ETH:-8,HEAT:-5,NETWORK:+10,CLOUT:+8}, rVr:{ETH:5,HEAT:4,NETWORK:5,CLOUT:5}},
  { cat:"Platform", id:"p_copycat_platform",
    text:"{c} points out a rival platform copying your exact features. You could reverse-copy them back.",
    acc:"Copy them back",    aFx:{ETH:+5,HEAT:+12,NETWORK:+5,CLOUT:-5},aVr:{ETH:5,HEAT:7,NETWORK:4,CLOUT:5},
    rej:"Innovate instead",  rFx:{ETH:-8,HEAT:-5,NETWORK:+8,CLOUT:+8}, rVr:{ETH:5,HEAT:4,NETWORK:5,CLOUT:5}},
  { cat:"Platform", id:"p_user_data_leak",
    text:"{c} discovered a data breach. Disclose immediately or quietly patch and say nothing.",
    acc:"Disclose it now",   aFx:{ETH:-5,HEAT:+15,NETWORK:+10,CLOUT:+5},aVr:{ETH:4,HEAT:8,NETWORK:5,CLOUT:4},
    rej:"Patch and stay quiet",rFx:{ETH:+8,HEAT:+20,NETWORK:-5,CLOUT:-8},rVr:{ETH:5,HEAT:10,NETWORK:4,CLOUT:5}},
  { cat:"Platform", id:"p_creator_fund",
    text:"{c} proposes a creator fund to attract top artists. Costs treasury but changes the ecosystem.",
    acc:"Launch the fund",   aFx:{ETH:-15,HEAT:-5,NETWORK:+15,CLOUT:+15},aVr:{ETH:10,HEAT:5,NETWORK:6,CLOUT:8},
    rej:"Not financially viable",rFx:{ETH:+8,HEAT:+5,NETWORK:-12,CLOUT:-12},rVr:{ETH:5,HEAT:4,NETWORK:5,CLOUT:6}},
  { cat:"Platform", id:"p_gamification",
    text:"{c} wants to add points and leaderboards to gamify user behavior. Engagement up, dignity questionable.",
    acc:"Add gamification",  aFx:{ETH:+8,HEAT:+5,NETWORK:+12,CLOUT:+8},aVr:{ETH:6,HEAT:4,NETWORK:6,CLOUT:5},
    rej:"Keep it clean",     rFx:{ETH:-5,HEAT:-3,NETWORK:-8,CLOUT:-5},rVr:{ETH:3,HEAT:3,NETWORK:4,CLOUT:4}},
  { cat:"Platform", id:"p_acquisition_offer",
    text:"{c} has an offer from a legacy art institution to acquire a minority stake in the platform.",
    acc:"Take their money",  aFx:{ETH:+20,HEAT:+5,NETWORK:+12,CLOUT:+12},aVr:{ETH:12,HEAT:5,NETWORK:6,CLOUT:8},
    rej:"Stay independent",  rFx:{ETH:-8,HEAT:-3,NETWORK:+5,CLOUT:+5}, rVr:{ETH:5,HEAT:3,NETWORK:4,CLOUT:4}},
  { cat:"Platform", id:"p_centralize_hosting",
    text:"{c} suggests migrating platform storage to a centralized cloud. Cheaper, faster, less aligned.",
    acc:"Make the move",     aFx:{ETH:+12,HEAT:+8,NETWORK:-5,CLOUT:-5},aVr:{ETH:8,HEAT:6,NETWORK:4,CLOUT:4},
    rej:"Stay decentralized",rFx:{ETH:-8,HEAT:-5,NETWORK:+10,CLOUT:+8},rVr:{ETH:5,HEAT:4,NETWORK:5,CLOUT:5}},
  { cat:"Platform", id:"p_sponsored_feed",
    text:"{c} proposes selling sponsored slots in the discovery feed. Revenue model or integrity issue?",
    acc:"Sell the slots",    aFx:{ETH:+15,HEAT:+8,NETWORK:+3,CLOUT:-8},aVr:{ETH:8,HEAT:6,NETWORK:3,CLOUT:6},
    rej:"Organic discovery", rFx:{ETH:-5,HEAT:-5,NETWORK:+8,CLOUT:+8}, rVr:{ETH:3,HEAT:4,NETWORK:4,CLOUT:5}},
  { cat:"Platform", id:"p_cross_chain_rush",
    text:"{c} wants to expand to three new chains simultaneously before competitors do.",
    acc:"Expand fast",       aFx:{ETH:-10,HEAT:+8,NETWORK:+15,CLOUT:+10},aVr:{ETH:10,HEAT:6,NETWORK:6,CLOUT:6},
    rej:"One chain at a time",rFx:{ETH:+5,HEAT:-5,NETWORK:-8,CLOUT:-5},rVr:{ETH:3,HEAT:4,NETWORK:4,CLOUT:4}},
  { cat:"Platform", id:"p_delist_scam",
    text:"{c} identified a scam project that's getting a lot of traction on the platform. Delist or let it run?",
    acc:"Delist it now",     aFx:{ETH:-3,HEAT:-8,NETWORK:+10,CLOUT:+12},aVr:{ETH:3,HEAT:5,NETWORK:5,CLOUT:6},
    rej:"Not our problem",   rFx:{ETH:+5,HEAT:+15,NETWORK:-8,CLOUT:-10},rVr:{ETH:3,HEAT:8,NETWORK:4,CLOUT:6}},
  { cat:"Platform", id:"p_token_unlock",
    text:"{c} wants to unlock a large team token allocation early, before the vesting cliff.",
    acc:"Do the early unlock",aFx:{ETH:+20,HEAT:+18,NETWORK:-5,CLOUT:-10},aVr:{ETH:15,HEAT:10,NETWORK:5,CLOUT:8},
    rej:"Respect the vesting",rFx:{ETH:-5,HEAT:-8,NETWORK:+8,CLOUT:+10},rVr:{ETH:4,HEAT:5,NETWORK:4,CLOUT:6}},


];




// Pick a caster of matching type, excluding the player card
function icCaster(cat, excludeId) {
  const typed = ACCOUNTS.filter(a => a.rarity && a.handle && a.id !== excludeId &&
    (a.cat||"").split("/")[0].trim() === cat);
  const fallback = ACCOUNTS.filter(a => a.rarity && a.handle && a.id !== excludeId);
  const pool = typed.length >= 2 ? typed : fallback;
  return pool[Math.floor(Math.random()*pool.length)] || ACCOUNTS.find(a=>a.id!==excludeId) || ACCOUNTS[0];
}

// Main pick function — 8% event chance, no event while one is active
function icPickDeal(used, playerType, playerId, activeMods) {
  const usedSet = new Set(used);
  const hasActiveMod = (activeMods||[]).length > 0;
  // Only offer event if none currently active and random chance hits
  const unusedEvents = IC_MARKET_EVENTS.filter(e=>!usedSet.has(e.id))
    .sort(()=>Math.random()-.5);
  if (!hasActiveMod && unusedEvents.length > 0 && Math.random() < 0.08) {
    const ev = unusedEvents[0];
    return { ...ev, caster: icCaster("Founder", playerId), text: ev.text };
  }
  let pool = IC_DEALS.filter(d=>!usedSet.has(d.id));
  if (!pool.length) pool = [...IC_DEALS]; // cycle reset
  // 90% type-matched, 10% wild
  const typePool = pool.filter(d=>d.cat===playerType);
  const chosen = typePool.length>=2 && Math.random()<0.90
    ? typePool[Math.floor(Math.random()*typePool.length)]
    : pool[Math.floor(Math.random()*pool.length)];
  const caster = icCaster(chosen.cat, playerId);
  return { ...chosen, caster, text: chosen.text.replace("{c}", caster.name) };
}

function icPickDealForType(used, playerType, playerId, activeMods) {
  return icPickDeal(used, playerType, playerId, activeMods);
}

/* ── Meters bar ── */
function ICMeters({ meters, prev, flash }) {
  const mono = { fontFamily:"'DM Mono',monospace" };
  return (
    <div style={{display:"flex",gap:5,padding:"9px 12px 10px",
      background:"#080808",borderBottom:"1px solid #141414"}}>
      {IC_KEYS.map(k => {
        const v  = Math.round(meters[k]);
        const pv = Math.round(prev?.[k] ?? v);
        const diff = v - pv;
        const s = IC_METERS[k];
        const danger = v < 15 || v > 85;
        const barColor = v<20?"#c06060":v>80?"#e8a030":s.color;
        return (
          <div key={k} style={{flex:1}}>
            {/* Fixed-height label row — delta overlaid so it never shifts bars */}
            <div style={{height:14,display:"flex",alignItems:"center",
              justifyContent:"space-between",marginBottom:3,position:"relative"}}>
              <span style={{...mono,fontSize:7.5,letterSpacing:.3,fontWeight:500,
                color:danger?"#e05a4a":"#666"}}>{s.label}</span>
              {flash && diff !== 0 && (
                <span style={{...mono,fontSize:9,fontWeight:700,lineHeight:1,
                  color:diff>0?"#6aca6a":"#e05a4a"}}>
                  {diff>0?"+":""}{diff}
                </span>
              )}
            </div>
            <div style={{height:6,background:"#1a1a1a",borderRadius:3,overflow:"hidden",
              boxShadow:danger?`0 0 0 1px ${barColor}55`:"none"}}>
              <div style={{height:"100%",borderRadius:3,width:`${v}%`,
                background:barColor,transition:"width .45s ease",
                boxShadow:danger?`0 0 8px ${barColor}88`:"none"}}/>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Deal card (the proposal) ── */
function ICDealCard({ deal, player, dispW }) {
  const mono = { fontFamily:"'DM Mono',monospace" };
  const H = Math.round(dispW*(470/300));
  const r = RARITIES[deal.caster?.rarity||"C"];
  const isEvent = !!deal.isEvent;
  const eyeSize = Math.round(dispW * 0.44);

  // Event card: eye + gold border, no portrait
  if (isEvent) {
    return (
      <div style={{
        width:dispW, height:H, borderRadius:7, overflow:"hidden",
        background:"#090807",
        border:"1.5px solid #e8c96e88",
        boxShadow:"0 0 28px #e8c96e22",
        display:"flex", flexDirection:"column", flexShrink:0,
      }}>
        {/* Top half: animated eye centered */}
        <div style={{height:"52%",display:"flex",flexDirection:"column",
          alignItems:"center",justifyContent:"center",position:"relative",
          borderBottom:"1px solid #1e1800"}}>
          <img src={`data:image/svg+xml;base64,${LOGO_B64}`} alt="networked.cards"
            style={{width:"70%",opacity:0.3,filter:"brightness(0) invert(1)"}}/>
          {/* EVENT badge top-left */}
          <div style={{position:"absolute",top:8,left:8,
            background:"rgba(0,0,0,0.9)",border:"1px solid #e8c96e66",
            borderRadius:3,padding:"2px 9px",...mono,
            fontSize:Math.round(dispW*.036),color:"#e8c96e",letterSpacing:1.5}}>
            ⚡ EVENT
          </div>
          {/* Event name bottom */}
          <div style={{position:"absolute",bottom:8,left:10,...mono,
            fontSize:Math.round(dispW*.058),color:"#e8c96e",fontWeight:500,
            letterSpacing:.5}}>
            {deal.name}
          </div>
        </div>
        {/* Bottom half: text + choices */}
        <div style={{flex:1,padding:`${Math.round(dispW*.052)}px ${Math.round(dispW*.065)}px`,
          display:"flex",flexDirection:"column",justifyContent:"space-between"}}>
          <div style={{...mono,fontSize:Math.round(dispW*.055),color:"#c8c8c8",lineHeight:1.65}}>
            {deal.text}
          </div>
          <div style={{display:"flex",justifyContent:"space-between",
            paddingTop:8,borderTop:"1px solid #1e1800"}}>
            <div style={{...mono,fontSize:Math.round(dispW*.042),color:"#c06060"}}>← {deal.rej}</div>
            <div style={{...mono,fontSize:Math.round(dispW*.042),color:"#5aba5a"}}>{deal.acc} →</div>
          </div>
        </div>
      </div>
    );
  }

  // Regular deal card: portrait
  return (
    <div style={{
      width:dispW, height:H, borderRadius:7, overflow:"hidden",
      background:"#080808", border:`1.5px solid ${r.color}`,
      display:"flex", flexDirection:"column", flexShrink:0,
    }}>
      <div style={{height:"52%",overflow:"hidden",position:"relative",flexShrink:0}}>
        <img src={ASSET.cardPfp(deal.caster?.handle||"")} alt=""
          onError={e=>ipfsOnError(e, card.image_cid)}
          style={{width:"100%",height:"100%",objectFit:"cover",objectPosition:"center 15%"}}/>
        <div style={{position:"absolute",inset:0,
          background:"linear-gradient(to bottom,transparent 35%,rgba(0,0,0,0.92))"}}/>
        <div style={{position:"absolute",bottom:7,left:10,...mono,
          fontSize:Math.round(dispW*.052),color:r.accent,fontWeight:500}}>
          {deal.caster?.name}
        </div>

      </div>
      <div style={{flex:1,padding:`${Math.round(dispW*.052)}px ${Math.round(dispW*.065)}px`,
        display:"flex",flexDirection:"column",justifyContent:"space-between"}}>
        <div style={{...mono,fontSize:Math.round(dispW*.058),color:"#b8b8b8",lineHeight:1.65}}>
          {deal.text}
        </div>
        <div style={{display:"flex",justifyContent:"space-between",
          paddingTop:8,borderTop:"1px solid #181818"}}>
          <div style={{...mono,fontSize:Math.round(dispW*.042),color:"#c06060"}}>← {deal.rej}</div>
          <div style={{...mono,fontSize:Math.round(dispW*.042),color:"#5aba5a"}}>{deal.acc} →</div>
        </div>
      </div>
    </div>
  );
}

/* ── Result card — tiltable, with eye + deltas ── */
function ICResultCard({ result, prev, dispW }) {
  const mono = { fontFamily:"'DM Mono',monospace" };
  const H = Math.round(dispW*(470/300));
  const [tilt, setTilt] = useState({ rx:0, ry:0 });
  const cardRef = useRef(null);
  const deltas = IC_KEYS.map(k => ({
    k, label:IC_METERS[k].label, color:IC_METERS[k].color,
    d: Math.round((result.newM[k]||0)-(prev?.[k]||0)),
  })).filter(x=>x.d!==0);
  const eyeSize = Math.round(dispW * 0.42);

  const onMove = useCallback(e => {
    if (!cardRef.current) return;
    if (e.pointerType === "touch") return;
    const r = cardRef.current.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top)  / r.height;
    setTilt({ rx:(y-0.5)*-10, ry:(x-0.5)*10 });
  }, []);
  const onLeave = useCallback(() => setTilt({rx:0,ry:0}), []);

  return (
    <div style={{perspective:700,width:dispW,flexShrink:0}}>
      <div
        ref={cardRef}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        style={{
          width:dispW, height:H, borderRadius:7,
          background:"#080808", border:"1.5px solid #1e1e1e",
          display:"flex", flexDirection:"column", justifyContent:"space-between",
          padding:`${Math.round(dispW*.08)}px ${Math.round(dispW*.08)}px`,
          overflow:"hidden",
          transform:`perspective(700px) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`,
          transition: tilt.rx===0&&tilt.ry===0 ? "transform .4s ease" : "transform .08s linear",
          willChange:"transform",
          boxShadow:"0 8px 32px rgba(0,0,0,0.7)",
        }}>
        <div style={{...mono,fontSize:Math.round(dispW*.038),color:"#2a2a2a",letterSpacing:2}}>
          {result.accepted ? "ACCEPTED" : "REJECTED"}
        </div>
        <div style={{display:"flex",justifyContent:"center",alignItems:"center",flex:1,padding:"8px 0"}}>
          <img src={`data:image/svg+xml;base64,${LOGO_B64}`} alt="networked.cards"
            style={{width:"65%",opacity:0.12,filter:"brightness(0) invert(1)"}}/>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:Math.round(dispW*.032)}}>
          {deltas.map(({k,label,color,d}) => (
            <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{...mono,fontSize:Math.round(dispW*.048),color:"#3a3a3a"}}>{label}</span>
              <span style={{...mono,fontSize:Math.round(dispW*.075),fontWeight:700,
                color:d>0?color:"#c06060"}}>{d>0?"+":""}{d}</span>
            </div>
          ))}
          {deltas.length===0 && (
            <div style={{...mono,fontSize:Math.round(dispW*.05),color:"#2a2a2a",textAlign:"center"}}>no change</div>
          )}
          {result.newMod && (
            <div style={{marginTop:Math.round(dispW*.02),
              padding:`${Math.round(dispW*.03)}px ${Math.round(dispW*.04)}px`,
              background:"#1a1400",border:"1px solid #e8c96e44",borderRadius:4,
              display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span style={{...mono,fontSize:Math.round(dispW*.05),color:"#e8c96e"}}>
                ⚡ {result.newMod.label}
              </span>
              <span style={{...mono,fontSize:Math.round(dispW*.044),color:"#7a6020"}}>
                {result.newMod.rounds} days
              </span>
            </div>
          )}
        </div>
        <div style={{...mono,fontSize:Math.round(dispW*.034),color:"#1a1a1a",
          letterSpacing:1,textAlign:"center",marginTop:Math.round(dispW*.03)}}>
          swipe or tap →
        </div>
      </div>
    </div>
  );
}

/* ── Game over card — AnimatedEye (special=true for red tint) ── */
function ICGameOverCard({ turns, death, isNew, best, dispW }) {
  const mono = { fontFamily:"'DM Mono',monospace" };
  const H = Math.round(dispW*(470/300));
  const [tilt, setTilt] = useState({rx:0,ry:0});
  const ref = useRef(null);
  const onMove = useCallback(e=>{
    if (!ref.current||e.pointerType==="touch") return;
    const r=ref.current.getBoundingClientRect();
    setTilt({rx:((e.clientY-r.top)/r.height-.5)*-10,ry:((e.clientX-r.left)/r.width-.5)*10});
  },[]);
  const onLeave = useCallback(()=>setTilt({rx:0,ry:0}),[]);
  const isResting = tilt.rx===0&&tilt.ry===0;
  return (
    <div style={{perspective:700,width:dispW,flexShrink:0}}>
      <div ref={ref} onPointerMove={onMove} onPointerLeave={onLeave} style={{
        width:dispW, height:H, borderRadius:7, overflow:"hidden", boxSizing:"border-box",
        background:"#0d0505",
        border:"2px solid #c06060cc",
        boxShadow:"0 0 14px #c0606018",
        display:"flex", flexDirection:"column", alignItems:"center",
        justifyContent:"space-between",
        padding:`${Math.round(dispW*.09)}px ${Math.round(dispW*.08)}px`,
        textAlign:"center",
        transform:`perspective(700px) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`,
        transition:isResting?"transform .4s ease":"transform .08s linear",
        willChange:"transform",
      }}>
        <div style={{...mono,fontSize:Math.round(dispW*.032),color:"#3a1515",
          letterSpacing:2,alignSelf:"flex-start"}}>CAMPAIGN</div>
        <div style={{...mono,fontSize:Math.round(dispW*.12),color:"#c06060",fontWeight:700,
          letterSpacing:3,lineHeight:.88,textShadow:"0 0 40px #c0606077"}}>
          GAME<br/>OVER
        </div>
        <img src={`data:image/svg+xml;base64,${LOGO_B64}`} alt="networked.cards"
        style={{width:"55%",opacity:0.15,filter:"brightness(0) invert(1)"}}/>
        <div style={{...mono,fontSize:Math.round(dispW*.052),color:"#c06060",lineHeight:1.5,
          maxWidth:"88%"}}>
          {death}
        </div>
        <div style={{display:"flex",gap:Math.round(dispW*.06),...mono,
          fontSize:Math.round(dispW*.052),justifyContent:"center"}}>
          <span style={{color:isNew?"#e8c96e":"#888"}}>
            {turns}<span style={{...mono,fontSize:Math.round(dispW*.034),
              color:isNew?"#9a7010":"#333",marginLeft:4}}>days</span>
          </span>
          {best>0&&<span style={{color:"#333"}}>
            {best}<span style={{...mono,fontSize:Math.round(dispW*.034),marginLeft:4}}>best</span>
          </span>}
        </div>
        {isNew&&<div style={{...mono,fontSize:Math.round(dispW*.038),color:"#e8c96e",
          letterSpacing:2}}>✦ NEW RECORD</div>}
        <div style={{...mono,fontSize:Math.round(dispW*.032),color:"#2a2a2a",letterSpacing:.5}}>
          swipe to continue →
        </div>
      </div>
    </div>
  );
}

/* ── Tutorial ── */
const IC_TUT = [
  {title:"CAMPAIGN",        body:"Choose a player from your collection. Navigate the NFT space. Survive as long as possible.", accent:"#e8c96e"},
  {title:"SWIPE",           body:"Each day a contact proposes a deal. Swipe RIGHT to accept, LEFT to reject. Both choices have consequences you won't always see coming.", accent:"#4a9fd4"},
  {title:"FOUR\nMETERS",   body:"ETH · HEAT · NETWORK · CLOUT. Any meter hitting 0 or 100 ends your run — too broke, too famous, too exposed, too invisible. Stay mid.", accent:"#c06060"},
  {title:"⚡ EVENTS",       body:"Rare market events can shake the board for several days. Use them strategically — they're your best tool to correct meters that are spiralling.", accent:"#e8c96e"},
  {title:"YOUR\nTYPE",     body:"Your card's type (Artist, Builder, Collector...) changes your starting values and determines which deals you'll see most often — 90% of offers match your type.", accent:"#4aad6a"},
  {title:"REWARDS",         body:"Every 5 days survived earns you 1 booster pack. The longer you last, the more you earn.", accent:"#9b6dd4"},
];

function ICTutCard({ t, dispW }) {
  const mono = { fontFamily:"'DM Mono',monospace" };
  const H = Math.round(dispW*(470/300));
  return (
    <div style={{
      width:dispW, height:H, borderRadius:7,
      background:"#080808", border:`1.5px solid ${t.accent}44`,
      display:"flex", flexDirection:"column", justifyContent:"space-between",
      padding:`${Math.round(dispW*.09)}px ${Math.round(dispW*.08)}px`,
      flexShrink:0,
    }}>
      <div style={{fontFamily:"'DM Mono',monospace",fontSize:Math.round(dispW*.04),
        color:"#252525",letterSpacing:2}}>CAMPAIGN</div>
      <div>
        <div style={{fontFamily:"'DM Mono',monospace",
          fontSize:Math.round(dispW*.1),color:t.accent,fontWeight:500,
          lineHeight:1.05,marginBottom:Math.round(dispW*.055),
          whiteSpace:"pre-line"}}>{t.title}</div>
        <div style={{fontFamily:"'DM Mono',monospace",
          fontSize:Math.round(dispW*.058),color:"#777",lineHeight:1.7}}>{t.body}</div>
      </div>
      <div style={{fontFamily:"'DM Mono',monospace",fontSize:Math.round(dispW*.036),
        color:"#1e1e1e",letterSpacing:1}}>→ swipe</div>
    </div>
  );
}

/* ── ResultSwipe — full swipe animation, tap or drag to dismiss ── */
function ResultSwipe({ onNext, cardWidth, children }) {
  const fired    = useRef(false);
  const startRef = useRef(null);
  const dragRef  = useRef(false);
  const cardRef  = useRef(null);
  const [pos,    setPos]    = useState({ x:0, y:0 });
  const [tilt,   setTilt]   = useState({ rx:0, ry:0 });
  const [flying, setFlying] = useState(null);
  const THROW = 60;

  const go = (dx) => {
    if (fired.current) return;
    fired.current = true;
    const dir = dx >= 0 ? 1 : -1;
    setFlying({ x: dir * 1100, y: -70 });
    setTimeout(onNext, 400);
  };

  // Desktop tilt — global pointermove, DEADZONE, activates on card entry (same as SwipeableCardStack)
  const tiltActiveRef = useRef(false);
  const RS_DZ = 80;
  useEffect(() => {
    const onMove = e => {
      if (e.pointerType==="touch" || dragRef.current) return;
      if (!cardRef.current) return;
      const r = cardRef.current.getBoundingClientRect();
      const inCard = e.clientX>=r.left && e.clientX<=r.right && e.clientY>=r.top && e.clientY<=r.bottom;
      if (inCard) tiltActiveRef.current = true;
      if (!tiltActiveRef.current) return;
      const cx=r.left+r.width/2, cy=r.top+r.height/2;
      const dx=e.clientX-cx, dy=e.clientY-cy;
      if (Math.max(0,Math.abs(dx)-r.width/2)>RS_DZ || Math.max(0,Math.abs(dy)-r.height/2)>RS_DZ) {
        tiltActiveRef.current=false; setTilt({rx:0,ry:0}); return;
      }
      setTilt({ rx:Math.max(-1,Math.min(1,dy/(r.height/2)))*-12, ry:Math.max(-1,Math.min(1,dx/(r.width/2)))*12 });
    };
    document.addEventListener("pointermove", onMove);
    return ()=>document.removeEventListener("pointermove", onMove);
  }, [flying]);
  const onHoverMove  = ()=>{};
  const onHoverLeave = ()=>{ tiltActiveRef.current=false; setTilt({rx:0,ry:0}); };

  // Gyro tilt (mobile)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    if (!getGyroEnabled()) return;
    let base = null;
    const onGyro = e => {
      if (dragRef.current) return;
      const b = e.beta??0, g = e.gamma??0;
      if (!base) base={b,g};
      const db = Math.max(-16,Math.min(16,b-base.b));
      const dg = Math.max(-16,Math.min(16,g-base.g));
      setTilt({ rx:db*-0.85, ry:dg*0.85 });
    };
    window.addEventListener("deviceorientation", onGyro);
    return ()=>window.removeEventListener("deviceorientation", onGyro);
  }, []);

  // Drag to swipe
  const onDown = (e) => {
    if (flying) return;
    startRef.current = { x:e.clientX, y:e.clientY };
    dragRef.current  = true;
    setTilt({rx:0,ry:0});
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!dragRef.current || !startRef.current) return;
    setPos({ x:e.clientX-startRef.current.x, y:e.clientY-startRef.current.y });
  };
  const onUp = (e) => {
    if (!dragRef.current) return;
    dragRef.current = false;
    const dx = pos.x, dy = pos.y;
    const dist = Math.sqrt(dx*dx+dy*dy);
    if (dist < 8) {
      const mid = (cardRef.current?.getBoundingClientRect().left||0) + (cardWidth||200)/2;
      const dir = e.clientX >= mid ? 60 : -60;
      setPos({x:dir,y:-10});
      setTimeout(()=>go(dir), 100);
    } else if (Math.abs(dx) > THROW) {
      go(dx);
    } else {
      setPos({x:0,y:0});
    }
  };

  const tx = flying ? flying.x : pos.x;
  const ty = flying ? flying.y : pos.y;
  const rot = tx * 0.055;
  const resting = tilt.rx===0 && tilt.ry===0;

  return (
    <div style={{display:"flex",justifyContent:"center",paddingTop:14,
      userSelect:"none",width:"100%"}}>
      {/* Tilt hitbox: larger invisible area, tilt only when cursor inside card */}
      <div
        onMouseMove={onHoverMove} onMouseLeave={onHoverLeave}
        style={{ padding:12, margin:-12, cursor: flying?"default":"grab" }}
      >
        <div
          ref={cardRef}
          onPointerDown={onDown}
          onPointerMove={e=>{ if(dragRef.current) onMove(e); }}
          onPointerUp={onUp} onPointerCancel={onUp}
          style={{
            perspective: 700,
            willChange:"transform",
            transform: flying || pos.x!==0 || pos.y!==0
              ? `translate(${tx}px,${ty}px) rotate(${rot}deg)`
              : `perspective(700px) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`,
            transition: flying
              ? "transform 0.4s cubic-bezier(.18,.68,.32,1.04)"
              : dragRef.current
                ? "none"
                : resting
                  ? "transform 0.5s cubic-bezier(.25,.46,.45,.94)"
                  : "transform 0.08s linear",
            boxShadow:"0 8px 32px rgba(0,0,0,0.6)",
            borderRadius:7,
          }}
        >{children}</div>
      </div>
    </div>
  );
}


/* ── Summary card + PNG download ── */
function icBuildNarrative(playerName, turns, death, stats) {
  const acc = stats?.accepted || 0;
  const rej = stats?.rejected || 0;
  const cats = stats?.cats || {};
  const evs  = stats?.events || 0;
  const topCat = Object.entries(cats).sort((a,b)=>b[1]-a[1])[0]?.[0];
  const ratio = acc + rej > 0 ? acc / (acc + rej) : 0.5;

  let behaviour;
  if (ratio > 0.75) behaviour = "said yes to almost everything";
  else if (ratio < 0.3) behaviour = "rejected most opportunities";
  else behaviour = "stayed selective";

  let specialty = topCat ? `leaned heavily into ${topCat.toLowerCase()} deals` : "kept a mixed portfolio";
  let eventLine = evs >= 3 ? "used market events to their advantage" : evs === 0 ? "never caught a market event" : "navigated a few market events";

  const causeMap = {
    "ETH DRAINED": "went bankrupt",
    "HEAT MAXED": "got arrested",
    "NETWORK DRAINED": "became isolated",
    "CLOUT DRAINED": "faded into irrelevance",
    "ETH MAXED": "left too obvious a paper trail",
    "NETWORK MAXED": "became dangerously overexposed",
    "CLOUT MAXED": "became too visible a target",
  };
  const endLine = Object.entries(causeMap).find(([k])=>death?.includes(k))?.[1] || "lost control";

  return `${playerName} ${endLine} on day ${turns}. They ${behaviour}, ${specialty}, and ${eventLine}.`;
}

function ICSummaryCard({ player, turns, death, stats, dispW, onShare, onNext }) {
  const mono = { fontFamily:"'DM Mono',monospace" };
  if (!player) return null;
  const H = Math.round(dispW*(470/300));
  const narrative = icBuildNarrative(player.name||"Unknown", turns, death, stats);
  const r = RARITIES[player.rarity||"C"];
  const pad = Math.round(dispW*.07);
  return (
    <div style={{
      width:dispW, height:H, borderRadius:7,
      background:"#131313", border:`2px solid ${IC_TYPE_COLOR[icType(player)]||"#888888"}`,
      boxShadow:`0 0 18px ${IC_TYPE_COLOR[icType(player)]||"#888888"}33, 0 8px 32px rgba(0,0,0,0.85)`,
      display:"flex", flexDirection:"column", justifyContent:"space-between",
      padding:pad, boxSizing:"border-box",
      overflow:"hidden",
    }}>
      <div style={{...mono,fontSize:Math.round(dispW*.034),color:"#444",letterSpacing:2}}>
        RUN SUMMARY
      </div>
      {/* Portrait + name */}
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <div style={{width:Math.round(dispW*.2),height:Math.round(dispW*.2*(470/300)),
          borderRadius:4,overflow:"hidden",border:`1px solid ${r.color}66`,flexShrink:0}}>
          <img src={ASSET.cardPfp(player.handle||"")} alt=""
            onError={e=>ipfsOnError(e, card.image_cid)}
            style={{width:"100%",height:"100%",objectFit:"cover",objectPosition:"center 15%"}}/>
        </div>
        <div>
          <div style={{...mono,fontSize:Math.round(dispW*.062),color:"#e0e0e0",
            fontWeight:500,lineHeight:1.2}}>{player.name}</div>
          <div style={{...mono,fontSize:Math.round(dispW*.042),color:IC_TYPE_COLOR[icType(player)]||r.accent}}>{icType(player)}</div>
        </div>
      </div>
      {/* Days */}
      <div style={{...mono,fontSize:Math.round(dispW*.042),color:"#666"}}>
        survived{" "}
        <span style={{color:"#d8d8d8",fontSize:Math.round(dispW*.068),fontWeight:500}}>
          {turns}
        </span>{" "}days
      </div>
      {/* Narrative */}
      <div style={{...mono,fontSize:Math.round(dispW*.052),color:"#999",lineHeight:1.6,
        fontStyle:"italic"}}>
        "{narrative}"
      </div>
      {/* Accept/reject stats */}
      <div style={{display:"flex",gap:Math.round(dispW*.04),...mono,
        fontSize:Math.round(dispW*.044),color:"#555"}}>
        <span>{stats?.accepted||0}<span style={{color:"#333",marginLeft:2}}>✓</span></span>
        <span>{stats?.rejected||0}<span style={{color:"#333",marginLeft:2}}>✗</span></span>
        {(stats?.events||0)>0&&<span>{stats.events}<span style={{color:"#333",marginLeft:2}}>⚡</span></span>}
      </div>
      {/* Footer */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <button onClick={onNext} style={{...mono,fontSize:Math.round(dispW*.036),color:"#444",
          background:"none",border:"1px solid #2a2a2a",borderRadius:3,
          padding:"3px 10px",cursor:"pointer",letterSpacing:.3}}>→ play again</button>
        <button
          onClick={e=>{e.stopPropagation(); onShare?.();}}
          style={{...mono,fontSize:Math.round(dispW*.036),color:"#555",background:"none",
            border:"1px solid #2a2a2a",borderRadius:3,padding:"3px 9px",cursor:"pointer"}}>
          save ↓
        </button>
      </div>
    </div>
  );
}

async function downloadSummaryPng(player, turns, death, stats) {
  const narrative = icBuildNarrative(player.name, turns, death, stats);
  const r = RARITIES[player.rarity];
  const typeColor = IC_TYPE_COLOR[icType(player)] || r.accent || "#888";
  const mono = "monospace";
  const SC = 2; // retina
  // Final image: card (300×470) + footer strip
  const CW = 300, CH = 470, FOOT = 90;
  const W = CW, H = CH + FOOT;
  const canvas = document.createElement("canvas");
  canvas.width = W*SC; canvas.height = H*SC;
  const ctx = canvas.getContext("2d");
  ctx.scale(SC, SC);

  // ── Card background ──
  const pad = 16, r2 = 8;
  ctx.fillStyle = "#0d0d0d";
  ctx.beginPath();
  ctx.roundRect(0,0,CW,CH,r2); ctx.fill();
  ctx.strokeStyle = typeColor+"bb"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(0,0,CW,CH,r2); ctx.stroke();

  // ── Portrait top half ──
  const pfpSrc = ASSET.cardPfp(player.handle);
  let pfpImg = null;
  try {
    pfpImg = await new Promise((res,rej)=>{ const i=new Image(); i.crossOrigin="anonymous"; i.onload=()=>res(i); i.onerror=rej; i.src=pfpSrc; });
  } catch {}
  const portH = Math.round(CH * 0.32);
  if (pfpImg) {
    ctx.save();
    ctx.beginPath(); ctx.roundRect(0,0,CW,portH,{upperLeft:r2,upperRight:r2,lowerLeft:0,lowerRight:0}); ctx.clip();
    ctx.drawImage(pfpImg,0,0,CW,portH);
    ctx.restore();
  }
  // Gradient over portrait
  const grad = ctx.createLinearGradient(0, portH*0.4, 0, portH+4);
  grad.addColorStop(0,"rgba(13,13,13,0)"); grad.addColorStop(1,"rgba(13,13,13,1)");
  ctx.fillStyle = grad; ctx.fillRect(0,0,CW,portH+4);

  // ── Card content ──
  let y = portH + 14;

  // RUN SUMMARY label
  ctx.font = `${11/SC*SC}px ${mono}`; ctx.fillStyle = "#333";
  ctx.fillText("RUN SUMMARY", pad, y - portH/2 < 0 ? pad+10 : y);
  y += 4;

  // Player name + type
  ctx.font = `bold 18px ${mono}`; ctx.fillStyle = "#e0e0e0";
  ctx.fillText(player.name, pad, y+18); y += 22;
  ctx.font = `12px ${mono}`; ctx.fillStyle = typeColor;
  ctx.fillText(icType(player).toUpperCase(), pad, y+13); y += 24;

  // Days survived
  ctx.font = `13px ${mono}`; ctx.fillStyle = "#555";
  ctx.fillText("survived", pad, y+12);
  ctx.font = `bold 22px ${mono}`; ctx.fillStyle = "#c8c8c8";
  ctx.fillText(turns, pad+70, y+14);
  ctx.font = `13px ${mono}`; ctx.fillStyle = "#555";
  ctx.fillText("days", pad+100, y+12); y += 32;

  // Narrative (word-wrapped)
  ctx.font = `italic 12px ${mono}`; ctx.fillStyle = "#777";
  const maxW = CW - pad*2;
  const wds = `"${narrative}"`.split(" ");
  let row="";
  for (const w of wds) {
    const test = row?row+" "+w:w;
    if (ctx.measureText(test).width > maxW && row) { ctx.fillText(row,pad,y); y+=18; row=w; }
    else row=test;
  }
  if (row) { ctx.fillText(row,pad,y); y+=18; }
  y += 10;

  // Stats
  ctx.font = `11px ${mono}`; ctx.fillStyle = "#3a3a3a";
  ctx.fillText(`${stats?.accepted||0}✓  ${stats?.rejected||0}✗${stats?.events>0?"  "+stats.events+"⚡":""}`, pad, y);

  // ── Footer ──
  ctx.fillStyle = "#080808"; ctx.fillRect(0,CH,CW,FOOT);
  ctx.strokeStyle = "#161616"; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(0,CH); ctx.lineTo(CW,CH); ctx.stroke();

  // Logo SVG as image
  try {
    const logoImg = await new Promise((res,rej)=>{
      const i=new Image(); i.onload=()=>res(i); i.onerror=rej;
      i.src=`data:image/svg+xml;base64,${LOGO_B64}`;
    });
    const lh = 20, lw = Math.round(lh * logoImg.naturalWidth / logoImg.naturalHeight);
    ctx.drawImage(logoImg, pad, CH+16, lw, lh);
  } catch {
    ctx.font = `bold 14px ${mono}`; ctx.fillStyle = "#d0d0d0";
    ctx.fillText("networked.cards", pad, CH+30);
  }
  ctx.font = `10px ${mono}`; ctx.fillStyle = "#333";
  ctx.fillText("think you can do better? play at thecabal.cards", pad, CH+52);

  const link = document.createElement("a");
  link.download = `networked_${(player.handle||"player").replace("@","")}_day${turns}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}


/* ══════════════════════ MAIN ══════════════════════ */
function InnerCircleView({ uniqueCards, st, save, notify }) {
  const mono    = { fontFamily:"'DM Mono',monospace" };
  const run     = st.ic || {};
  const best    = run.best || 0;
  const neverTut = run.neverTut || false;
  const CARD_W  = Math.min(220, (typeof window!=="undefined"?window.innerWidth:375) - 36);

  const [phase,   setPhase]   = useState(neverTut?"pick":"tutorial");
  const [deathCapture, setDeathCapture] = useState(null);
  const [player,  setPlayer]  = useState(null);
  const [meters,  setMeters]  = useState(null);
  const [prevM,   setPrevM]   = useState(null);
  const [turn,    setTurn]    = useState(0);
  const [deal,    setDeal]    = useState(null);
  const [usedIds, setUsedIds] = useState([]);
  const [result,  setResult]  = useState(null);
  const [showFlash, setFlash] = useState(false);
  const [modifiers, setModifiers] = useState([]); // [{id,label,rounds,ETH_m,HEAT_m,NETWORK_m,CLOUT_m}]
  const [runStats, setRunStats]   = useState({ accepted:0, rejected:0, cats:{}, events:0 });
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const doAbandon = () => {
    setConfirmAbandon(false);
    setModifiers([]);
    setPhase("pick");
  };

  const finishTut = (never=false) => {
    if (never) save({ ic:{...(run||{}),neverTut:true} });
    setPhase("pick");
  };

  const startRun = (card) => {
    const m = icStartMeters(card);
    setPlayer(card); setMeters(m); setPrevM(m);
    setTurn(0); setUsedIds([]); setResult(null); setFlash(false); setModifiers([]); decidedRef.current = false;
    setRunStats({ accepted:0, rejected:0, cats:{}, events:0 });
    setDeal(icPickDeal([], icType(card), card.id, []));
    setPhase("swipe");
  };

  const decidedRef = useRef(false);
  const decide = (accepted) => {
    if (!deal || !meters) return;
    if (decidedRef.current) return; // prevent double-fire from animation
    decidedRef.current = true;
    const synBonus = {}; // synergy removed
    // Market events: no immediate stat change — only install modifier
    const isEventDeal = !!deal.isEvent;
    const fx  = isEventDeal ? {} : (accepted ? deal.aFx : deal.rFx);
    const vr  = isEventDeal ? {} : (accepted ? deal.aVr : deal.rVr);
    const newM = icApply(meters, fx, vr, synBonus, modifiers);
    // Tick modifiers down, then install new one if accepted event
    const tickedMods = modifiers
      .map(mod => ({ ...mod, rounds: mod.rounds - 1 }))
      .filter(mod => mod.rounds > 0);
    const newModDef = isEventDeal && accepted ? deal.mod_acc : (!isEventDeal ? null : null);
    const newMods = newModDef
      ? [...tickedMods.filter(m=>m.id!==newModDef.id), { ...newModDef }]
      : tickedMods;
    setModifiers(newMods);
    const death = icDeath(newM);
    const newTurn = turn + 1;
    setTurn(newTurn);
    setPrevM(meters);
    setMeters(newM);
    // Track run stats
    setRunStats(prev => ({
      accepted: prev.accepted + (accepted?1:0),
      rejected: prev.rejected + (!accepted?1:0),
      cats: deal?.cat ? {...prev.cats, [deal.cat]: (prev.cats[deal.cat]||0)+1} : prev.cats,
      events: prev.events + (deal?.isEvent?1:0),
    }));
    const r = { accepted, newM, death, newMod: newModDef||null, mods: newMods };
    setResult(r);
    setFlash(true);
    if (death) {
      const newBest = Math.max(best, newTurn);
      const maxT = Math.max(run.maxTurns||0, newTurn);
      const ach = { ...st.achievements };
      if (!ach.campBankrupt) ach.campBankrupt = true;
      if (newTurn>=10 && !ach.camp10) { ach.camp10=true; setTimeout(()=>notify("✓ Achievement: Initiate"),400); }
      if (newTurn>=25 && !ach.camp25) { ach.camp25=true; setTimeout(()=>notify("✓ Achievement: Operator"),800); }
      if (newTurn>=50 && !ach.camp50) { ach.camp50=true; setTimeout(()=>notify("✓ Achievement: Inner Circle"),1200); }
      if (newTurn>=100 && !ach.camp100) { ach.camp100=true; setTimeout(()=>notify("✓ Achievement: The Long Game"),1600); }
      save({ ic:{...(run||{}), best:newBest, neverTut, maxTurns:maxT}, achievements:ach });
      // Freeze snapshot for summary card
      setDeathCapture({ turns:newTurn, death,
        stats:{ ...runStats,
          accepted: runStats.accepted+(accepted?1:0),
          rejected: runStats.rejected+(!accepted?1:0) }});
    } else {
      // Award pack every 5 rounds survived
      const prevMilestone = Math.floor(turn / 5);
      const newMilestone  = Math.floor(newTurn / 5);
      if (newMilestone > prevMilestone) {
        save({ packs: (st?.packs||0) + 1 });
        notify("✦ day " + newTurn + " — pack earned");
        // Check campaign achievements
        const cur = run.maxTurns || 0;
        const newMax = Math.max(cur, newTurn);
        if (newMax !== cur) save({ ic:{...(run||{}), best, neverTut, maxTurns: newMax} });
      }
    }
    setPhase("result");
  };

  const afterResult = () => {
    if (result?.death) {
      setPhase("death");
      return;
    }
    // Use functional update to avoid stale closure on usedIds/deal
    setUsedIds(prev => {
      const newUsed = deal?.id ? [...prev, deal.id] : prev;
      const pType = icType(player);
      // result.mods is the already-ticked modifier list set by decide()
      const activeMods = result?.mods || [];
      const next = icPickDealForType(newUsed, pType, player?.id, activeMods);
      setDeal(next);
      return newUsed;
    });
    setFlash(false);
    setResult(null);
    decidedRef.current = false;
    setPhase("swipe");
  };

  /* ── TUTORIAL ── */
  if (phase === "tutorial") {
    const cards = IC_TUT.map((t,i)=>({id:`ict${i}`,_t:t}));
    return (
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",paddingTop:20}}>
        <div style={{...mono,fontSize:7.5,color:"#252525",letterSpacing:2,marginBottom:16}}>HOW TO PLAY</div>
        <SwipeableCardStack cards={cards} cardWidth={CARD_W} ownedIds={new Set()}
          onComplete={()=>finishTut(false)}
          renderCard={c=><ICTutCard t={c._t} dispW={CARD_W}/>}/>
        <div style={{display:"flex",gap:12,marginTop:16}}>
          <button onClick={()=>finishTut(false)} style={{...mono,fontSize:8,color:"#555",
            background:"none",border:"1px solid #1e1e1e",borderRadius:4,
            padding:"6px 14px",cursor:"pointer",letterSpacing:1}}>SKIP</button>
          <button onClick={()=>finishTut(true)} style={{...mono,fontSize:8,color:"#252525",
            background:"none",border:"none",padding:"6px 0",cursor:"pointer"}}>
            don't show again</button>
        </div>
      </div>
    );
  }

  /* ── PICK ── */
  if (phase === "pick") {
    const sorted = [...uniqueCards].sort((a,b)=>
      RARITY_ORDER.indexOf(a.rarity)-RARITY_ORDER.indexOf(b.rarity));
    return (
      <div style={{animation:"slideUp .3s ease"}}>
        <div style={{position:"sticky",top:0,zIndex:10,background:"#080808",
          borderBottom:"1px solid #161616",padding:"12px 14px 14px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6}}>
            <div style={{...mono,fontSize:16,color:"#d0d0d0",letterSpacing:1}}>CAMPAIGN</div>
            {best>0 && <div style={{...mono,fontSize:8,color:"#2a2a2a"}}>best {best} days</div>}
          </div>
          <div style={{...mono,fontSize:9,color:"#333",lineHeight:1.7,fontStyle:"italic"}}>
            the key to success is to stay mid.
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(120px,1fr))",
          gap:10,padding:"10px 0 24px"}}>
          {sorted.map(card => {
            const type = icType(card);
            return (
              <div key={card.id} onClick={()=>startRun(card)}
                style={{cursor:"pointer",borderRadius:7,position:"relative"}}>
                <FlippableCard card={card} dispW={120} noFlipOnClick allowTilt={false}/>
                <div style={{position:"absolute",top:6,left:6,
                  background:"rgba(0,0,0,0.88)",
                  border:`1px solid ${IC_TYPE_COLOR[type]||"#333"}55`,
                  borderRadius:3,padding:"2px 6px",...mono,fontSize:7,
                  color:IC_TYPE_COLOR[type]||"#555"}}>{type}</div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  /* ── HUD ── */
  const HUD = () => {
    const type = icType(player);
    const r = RARITIES[player.rarity];
    return (
      <>
        <div style={{background:"#080808",borderBottom:"1px solid #0e0e0e"}}>
          {/* Top row: player mini | Day X (center) | quit */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
            padding:"8px 14px 0px"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,minWidth:70}}>
              <div style={{width:28,height:Math.round(28*470/300),borderRadius:3,
                overflow:"hidden",border:`1px solid ${r.color}55`,flexShrink:0}}>
                <img src={ASSET.cardPfp(player.handle)} alt=""
                  onError={e=>ipfsOnError(e, card.image_cid)}
                  style={{width:"100%",height:"100%",objectFit:"cover",objectPosition:"center 15%"}}/>
              </div>
              <div style={{...mono,fontSize:8,color:IC_TYPE_COLOR[type]||"#555",
                fontWeight:500,lineHeight:1}}>{type}</div>
            </div>
            <div style={{...mono,fontSize:13,color:"#c8c8c8",fontWeight:500,letterSpacing:1,
              position:"absolute",left:"50%",transform:"translateX(-50%)"}}>
              Day {turn + 1}
            </div>
            {confirmAbandon ? (
              <div style={{display:"flex",gap:5,alignItems:"center"}}>
                <span style={{...mono,fontSize:7,color:"#555"}}>quit?</span>
                <button onClick={doAbandon} style={{...mono,fontSize:9,color:"#c06060",
                  background:"none",border:"1px solid #c0606066",borderRadius:3,
                  padding:"4px 10px",cursor:"pointer"}}>yes</button>
                <button onClick={()=>setConfirmAbandon(false)} style={{...mono,fontSize:9,color:"#555",
                  background:"none",border:"1px solid #2a2a2a",borderRadius:3,
                  padding:"4px 10px",cursor:"pointer"}}>no</button>
              </div>
            ) : (
              <button onClick={()=>setConfirmAbandon(true)} style={{...mono,fontSize:9,
                color:"#666",background:"none",border:"1px solid #2a2a2a",
                borderRadius:3,padding:"4px 12px",cursor:"pointer"}}>
                quit
              </button>
            )}
          </div>
          {/* GM line — centered */}
          <div style={{textAlign:"center",padding:"3px 14px 7px",...mono,fontSize:10,color:"#555",lineHeight:1.4}}>
            GM <span style={{color:"#888",fontWeight:500}}>{player.name}</span>
            {", here's your choice for today."}
          </div>
          {modifiers.length>0 && (
            <div style={{display:"flex",justifyContent:"center",gap:5,padding:"0 14px 7px",flexWrap:"wrap"}}>
              {modifiers.map(m=>(
                <span key={m.id} style={{...mono,color:"#e8c96e",
                  background:"#1a1400",border:"1px solid #e8c96e33",
                  borderRadius:3,padding:"2px 8px",fontSize:8,letterSpacing:.5}}>
                  ⚡ {m.label} · {m.rounds}d
                </span>
              ))}
            </div>
          )}
        </div>
        <ICMeters meters={meters} prev={prevM} flash={showFlash}/>
      </>
    );
  };

  /* ── SWIPE ── */
  // Safety net: if something went wrong and we're stuck in swipe with no deal, recover
  if (phase === "swipe" && !deal) {
    return (
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:40}}>
        <button onClick={()=>setPhase("pick")} style={{
          fontFamily:"'DM Mono',monospace",fontSize:10,color:"#555",background:"none",
          border:"1px solid #222",borderRadius:5,padding:"10px 24px",cursor:"pointer"
        }}>← restart</button>
      </div>
    );
  }
  if (phase === "swipe" && deal) {
    return (
      <div>
        <HUD/>
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",paddingTop:14}}>
          <SwipeableCardStack
            cards={[{...deal, id: deal?.id || "deal"}]}
            cardWidth={CARD_W} ownedIds={new Set()}
            onComplete={()=>{}}
            onSwipe={(_,dir)=>decide(dir==="right")}
            hideHint={true} maxTilt={16}
            renderCard={c=><ICDealCard deal={c} player={player} dispW={CARD_W}/>}
          />
        </div>
      </div>
    );
  }

  /* ── RESULT — tap or swipe to continue (no stack — avoids stale closure) ── */
  if (phase === "result" && result) {
    return (
      <div>
        <HUD/>
        <ResultSwipe onNext={afterResult} cardWidth={CARD_W}>
          <ICResultCard result={result} prev={prevM} dispW={CARD_W}/>
        </ResultSwipe>
      </div>
    );
  }

  /* ── DEATH — ResultSwipe avoids stale closure / double-fire soft lock ── */
  if (phase === "death" && result) {
    const isNew = (deathCapture?.turns||turn) > best;
    return (
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",paddingTop:20}}>
        <ResultSwipe onNext={()=>setPhase("summary")} cardWidth={CARD_W}>
          <ICGameOverCard
            turns={deathCapture?.turns||turn} death={result.death}
            isNew={isNew} best={best} dispW={CARD_W}/>
        </ResultSwipe>
      </div>
    );
  }

  /* ── SUMMARY — wrapped in ResultSwipe for full card interaction ── */
  if (phase === "summary") {
    if (!player) { setPhase("pick"); return null; }
    const cap = deathCapture || { turns:turn, death:result?.death||"", stats:runStats };
    return (
      <ResultSwipe onNext={()=>setPhase("pick")} cardWidth={CARD_W}>
        <ICSummaryCard
          player={player} turns={cap.turns} death={cap.death} stats={cap.stats}
          dispW={CARD_W}
          onShare={()=>downloadSummaryPng(player, cap.turns, cap.death, cap.stats)}
          onNext={()=>setPhase("pick")}
        />
      </ResultSwipe>
    );
  }

  return null;
}




function GyroToggleButton() {
  const mono = { fontFamily:"'DM Mono',monospace" };
  const [enabled, setEnabled] = useState(getGyroEnabled());
  const toggle = () => {
    const next = !enabled;
    try { localStorage.setItem(GYRO_OFF_KEY, next ? "0" : "1"); } catch {}
    setEnabled(next);
    // If turning on and iOS needs permission, request it
    if (next && typeof DeviceOrientationEvent?.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().catch(()=>{});
    }
  };
  return (
    <div style={{marginBottom:12,padding:"10px 12px",borderRadius:6,
      background:"#090909",border:"1px solid #1a1a1a",
      display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div>
        <div style={{...mono,fontSize:9,color:"#c8c8c8",marginBottom:3}}>Gyroscope tilt</div>
        <div style={{...mono,fontSize:7.5,color:"#333"}}>tilt device to reveal card edges</div>
      </div>
      <button onClick={toggle} style={{
        ...mono,fontSize:9,letterSpacing:1,padding:"6px 14px",
        border:`1px solid ${enabled?"#5aba5a44":"#2a2a2a"}`,
        borderRadius:4,cursor:"pointer",
        background:enabled?"#0a1a0a":"#111",
        color:enabled?"#5aba5a":"#444",
        transition:"all .15s",
      }}>{enabled?"ON":"OFF"}</button>
    </div>
  );
}

function MissionsView({ st, save, notify, uniqueCards }) {
  const mono = { fontFamily:"'DM Mono',monospace" };

  const ownedRarities = new Set(uniqueCards.map(c=>c.rarity));
  const allRarities = ["LR","UR","R","C"].every(r=>ownedRarities.has(r));

  const claimMission = useCallback((missionId, reward, isWeekly) => {
    const updateMs = isWeekly
      ? { weekly: { ...(st.weekly||{}), [`claimed_${missionId}`]: true } }
      : { missions: { ...st.missions, [`claimed_${missionId}`]: true } };
    save({ ...updateMs, packs: st.packs + reward });
    notify(`+${reward} pack${reward!==1?"s":""}`);
  }, [st, save, notify]);

  const claimAchi = useCallback((achiId, reward) => {
    save({ achievements: { ...st.achievements, [`claimed_${achiId}`]: true }, packs: st.packs + reward });
    notify(`+${reward} pack${reward!==1?"s":""}`);
  }, [st, save, notify]);

  // ── Row components — no emojis ──
  const StatusDot = ({ done, claimed }) => (
    <div style={{
      width:8, height:8, borderRadius:"50%", flexShrink:0,
      background: claimed ? "#22c55e" : done ? "#4ade80" : "#1e1e1e",
      boxShadow: done && !claimed ? "0 0 6px #4ade8066" : "none",
      transition:"all .2s",
    }}/>
  );

  const MissionRow = ({ m, isWeekly }) => {
    const ms = isWeekly ? (st.weekly||{}) : st.missions;
    const done = isWeekly
      ? m.check({ weekly: st.weekly||{}, missions: st.missions, collection: st.collection })
      : m.check({ ...st, missions: { ...st.missions, allRarities } });
    const claimed = ms[`claimed_${m.id}`] || false;
    const canClaim = done && !claimed;
    return (
      <div style={{
        display:"flex", alignItems:"center", gap:12, padding:"9px 12px",
        background:"#080808",
        border:`1px solid ${canClaim?"#2a2a2a":done?"#181818":"#111"}`,
        borderRadius:5, marginBottom:4, transition:"border-color .2s",
      }}>
        <StatusDot done={done} claimed={claimed}/>
        <div style={{flex:1, ...mono}}>
          <div style={{fontSize:9, color: claimed?"#333": done?"#bbb":"#555", lineHeight:1.3}}>{m.label}</div>
          {!claimed && <div style={{fontSize:7.5, color:"#3a3a3a", marginTop:2}}>+{m.reward} pack{m.reward!==1?"s":""}</div>}
        </div>
        {canClaim
          ? <button onClick={()=>claimMission(m.id, m.reward, isWeekly)} style={{
              ...mono, background:"transparent", border:"1px solid #333",
              color:"#d0d0d0", borderRadius:4, padding:"4px 12px",
              fontSize:7.5, letterSpacing:1.5, cursor:"pointer", flexShrink:0, transition:"all .15s",
            }}
            onMouseEnter={e=>{e.target.style.borderColor="#666";}}
            onMouseLeave={e=>{e.target.style.borderColor="#333";}}>
              CLAIM
            </button>
          : claimed && <div style={{...mono,fontSize:7,color:"#2a2a2a",letterSpacing:1}}>CLAIMED</div>
        }
      </div>
    );
  };

  const AchiRow = ({ a }) => {
    const unlocked = st.achievements[a.id] || false;
    const claimed  = st.achievements[`claimed_${a.id}`] || false;
    const canClaim = unlocked && !claimed;
    return (
      <div style={{
        display:"flex", alignItems:"center", gap:12, padding:"9px 12px",
        background:"#080808",
        border:`1px solid ${canClaim?"#2a2a2a":unlocked?"#181818":"#111"}`,
        borderRadius:5, marginBottom:4, transition:"border-color .2s",
      }}>
        <StatusDot done={unlocked} claimed={claimed}/>
        <div style={{flex:1, ...mono}}>
          <div style={{fontSize:9, color: claimed?"#333": unlocked?"#bbb":"#555", lineHeight:1.3}}>{a.label}</div>
          <div style={{fontSize:7.5, color: unlocked?"#333":"#2a2a2a", marginTop:2, lineHeight:1.3}}>{a.desc}</div>
          {!claimed && <div style={{fontSize:7.5, color:"#3a3a3a", marginTop:2}}>+{a.reward} pack{a.reward!==1?"s":""}</div>}
        </div>
        {canClaim
          ? <button onClick={()=>claimAchi(a.id, a.reward)} style={{
              ...mono, background:"transparent", border:"1px solid #333",
              color:"#d0d0d0", borderRadius:4, padding:"4px 12px",
              fontSize:7.5, letterSpacing:1.5, cursor:"pointer", flexShrink:0, transition:"all .15s",
            }}
            onMouseEnter={e=>{e.target.style.borderColor="#666";}}
            onMouseLeave={e=>{e.target.style.borderColor="#333";}}>
              CLAIM
            </button>
          : claimed && <div style={{...mono,fontSize:7,color:"#2a2a2a",letterSpacing:1}}>CLAIMED</div>
        }
      </div>
    );
  };

  const Section = ({ label, children }) => (
    <div style={{marginBottom:22}}>
      <div style={{...mono, fontSize:7.5, color:"#444", letterSpacing:2.5, marginBottom:10}}>{label}</div>
      {children}
    </div>
  );

  return (
    <div style={{animation:"slideUp .3s ease"}}>
      <Section label="DAILY">
        {DAILY_MISSIONS.map(m => <MissionRow key={m.id} m={m} isWeekly={false}/>)}
      </Section>

      <Section label="WEEKLY">
        {WEEKLY_MISSIONS.map(m => <MissionRow key={m.id} m={m} isWeekly={true}/>)}
      </Section>

      <Section label="ACHIEVEMENTS">
        {["GACHA","FORGE"].map(sector => {
          const sItems = ACHI_DEF.filter(a=>a.s===sector);
          return (
            <div key={sector} style={{marginBottom:14}}>
              <div style={{...mono,fontSize:6.5,color:"#2a2a2a",letterSpacing:2,marginBottom:6}}>{sector}</div>
              {sItems.map(a=><AchiRow key={a.id} a={a}/>)}
            </div>
          );
        })}
      </Section>

      <Section label="STATS">
        <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:14}}>
          {Object.entries(RARITIES).map(([k,v])=>(
            <div key={k} style={{background:v.color+"18",border:`1px solid ${v.color}40`,borderRadius:4,padding:"5px 12px",flex:"1 1 40%"}}>
              <div style={{...mono,fontSize:8,color:v.accent,letterSpacing:.5,marginBottom:2}}>{v.name.toUpperCase()}</div>
              <div style={{...mono,fontSize:14,color:v.accent,fontWeight:500}}>
                {v.rate*100<1?(v.rate*100).toFixed(2):(v.rate*100).toFixed(2)}%
              </div>
            </div>
          ))}
        </div>
        <div style={{...mono,fontSize:9,color:"#444",lineHeight:1.6,marginBottom:14}}>
          ✦ lucky pack: 1 guaranteed UR + 1 R · 5% chance per pack
        </div>
        {/* Gyro toggle — mobile only */}
        {typeof DeviceOrientationEvent !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches && (
          <GyroToggleButton/>
        )}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4}}>
          {[
            ["Packs opened",    st.totalOpened],
            ["Unique cards",    `${uniqueCards.length} / ${ACCOUNTS.length}`],
            ["Total pulls",     st.pullCount],
            ["UR + LR owned",   uniqueCards.filter(c=>c.rarity==="UR"||c.rarity==="LR").reduce((s,c)=>s+c.count,0)],
            ["Legendaries",     uniqueCards.filter(c=>c.rarity==="LR").reduce((s,c)=>s+c.count,0)],
            ["Cards burned",    st.achievements?._burnTotal||0],
          ].map(([l,v])=>(
            <div key={l} style={{padding:"8px 10px",borderRadius:5,background:"#080808",border:"1px solid #111"}}>
              <div style={{...mono,fontSize:7,color:"#444",letterSpacing:.5,marginBottom:3}}>{l.toUpperCase()}</div>
              <div style={{...mono,color:"#d0d0d0",fontSize:18,fontWeight:500,lineHeight:1}}>{v}</div>
            </div>
          ))}
        </div>
      </Section>

    </div>
  );
}

export default function TheCabal() {
  return <TheCabalApp/>;
}
