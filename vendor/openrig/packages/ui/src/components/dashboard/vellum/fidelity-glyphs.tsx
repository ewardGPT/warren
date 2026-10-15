// OPR.0.4.1.14 — fidelity launcher glyphs for the refreshed Dashboard route.
//
// Geometry is byte-faithful to the founder-LOCKED twin
// (digital-twin/opr-0.4.1.14/dashboard-fidelity.intent.html). These are the
// founder-ratified ICON ROUND set: the EXISTING-CODE dashboard glyphs
// (topology six-node / project river / for-you target / library globe) plus
// the two the icon-round re-cut — a magnifier RE-CENTERED in a perfect square
// (search) and a ship's HELM (settings, ink-only, distinct from for-you's
// amber target). The newly-drawn creative glyphs are deliberately NOT used
// here; per sequencing (a) the final glyphs swap in later on the icon
// re-confirm.
//
// Stroke width + linecaps + hover-amber colour are driven by the scoped CSS
// (.df-glyph svg / .df-cap i svg in dashboard-fidelity.css), so these stay
// context-agnostic: the same component renders at 84px in a card and at 9px
// in a caption, picking up the right weight from its container. Everything
// inherits `currentColor`, so the card's hover rule (color -> amber) tints the
// whole glyph; the for-you centre dot carries `df-amf` to stay amber at rest.

// ── 01 TOPOLOGY — six-node tree (existing TreeGraphic geometry) ───────────────
export function TopologyGlyph() {
  return (
    <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="22" y="6" width="16" height="8" />
      <rect x="6" y="28" width="14" height="8" />
      <rect x="40" y="28" width="14" height="8" />
      <rect x="6" y="48" width="14" height="6" />
      <rect x="22" y="48" width="14" height="6" />
      <rect x="40" y="48" width="14" height="6" />
      <line x1="30" y1="14" x2="13" y2="28" />
      <line x1="30" y1="14" x2="47" y2="28" />
      <line x1="13" y1="36" x2="13" y2="48" />
      <line x1="47" y1="36" x2="47" y2="48" />
      <line x1="13" y1="44" x2="29" y2="48" />
      <line x1="47" y1="44" x2="29" y2="48" />
    </svg>
  );
}

// ── 02 PROJECT — stratigraphic "river" (existing geometry, [01] label dropped
//    per the icon-round note so it does not clash with the card's own index) ──
export function ProjectGlyph() {
  return (
    <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M2 26 Q 18 18 30 22 T 58 18" />
      <path d="M2 36 Q 18 28 30 32 T 58 28" strokeDasharray="2 2" />
      <path d="M2 46 Q 18 40 30 42 T 58 38" strokeDasharray="2 2" />
      <circle cx="30" cy="22" r="2" fill="currentColor" />
      <line x1="30" y1="22" x2="30" y2="10" />
    </svg>
  );
}

// ── 03 FOR YOU — radar target (existing PulseGraphic geometry; single amber
//    centre dot stays amber at rest via df-amf) ────────────────────────────────
export function ForYouGlyph() {
  return (
    <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="30" cy="30" r="12" />
      <circle cx="30" cy="30" r="20" strokeDasharray="2 3" />
      <circle cx="30" cy="30" r="27" strokeDasharray="2 4" />
      <line x1="30" y1="0" x2="30" y2="60" strokeDasharray="2 3" />
      <line x1="0" y1="30" x2="60" y2="30" strokeDasharray="2 3" />
      <circle className="df-amf" cx="30" cy="30" r="4" />
    </svg>
  );
}

// ── 04 LIBRARY — gyroscope globe (existing SphereGraphic geometry) ────────────
export function LibraryGlyph() {
  return (
    <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="30" cy="30" r="26" />
      <ellipse cx="30" cy="30" rx="26" ry="9" />
      <ellipse cx="30" cy="30" rx="9" ry="26" />
      <line x1="0" y1="30" x2="60" y2="30" strokeDasharray="2 3" />
      <line x1="30" y1="0" x2="30" y2="60" strokeDasharray="2 3" />
      <circle cx="30" cy="30" r="3" fill="currentColor" />
    </svg>
  );
}

// ── 05 SEARCH & AUDIT — magnifier RE-CENTERED in a perfect square with four
//    corner focus-brackets (icon-round fix for the off-centre/forced-square) ──
export function SearchGlyph() {
  return (
    <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M10 18 V10 H18" />
      <path d="M42 10 H50 V18" />
      <path d="M10 42 V50 H18" />
      <path d="M42 50 H50 V42" />
      <circle cx="27" cy="27" r="11" />
      <line x1="22" y1="27" x2="32" y2="27" />
      <line x1="27" y1="22" x2="27" y2="32" />
      <line x1="35" y1="35" x2="44" y2="44" />
    </svg>
  );
}

// ── 06 SETTINGS — ship's HELM / navigation wheel: outer ring + hub + 8 spokes
//    with handle stubs. Ink-only and distinct in BOTH shape and colour from
//    for-you's amber target (icon-round fix for "too similar + both orange") ──
export function SettingsGlyph() {
  return (
    <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="30" cy="30" r="18" />
      <circle cx="30" cy="30" r="6" />
      <circle cx="30" cy="30" r="2" fill="currentColor" />
      <line x1="36" y1="30" x2="53" y2="30" />
      <line x1="24" y1="30" x2="7" y2="30" />
      <line x1="30" y1="36" x2="30" y2="53" />
      <line x1="30" y1="24" x2="30" y2="7" />
      <line x1="34.2" y1="34.2" x2="46.3" y2="46.3" />
      <line x1="25.8" y1="25.8" x2="13.7" y2="13.7" />
      <line x1="34.2" y1="25.8" x2="46.3" y2="13.7" />
      <line x1="25.8" y1="34.2" x2="13.7" y2="46.3" />
    </svg>
  );
}

// ── Field Environment globe — 72-unit gyroscope readout glyph ────────────────
export function FieldGlobeGlyph() {
  return (
    <svg viewBox="0 0 72 72" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="36" cy="36" r="26" />
      <ellipse cx="36" cy="36" rx="9" ry="26" />
      <ellipse cx="36" cy="36" rx="19" ry="26" />
      <line x1="10" y1="36" x2="62" y2="36" />
      <line x1="14" y1="22" x2="58" y2="22" />
      <line x1="14" y1="50" x2="58" y2="50" />
      <line x1="36" y1="2" x2="36" y2="70" strokeDasharray="2 3" />
      <line x1="2" y1="36" x2="70" y2="36" strokeDasharray="2 3" />
    </svg>
  );
}

// ── Caption mini-glyphs (9px) — paired one per card per the twin ─────────────
export type CaptionGlyphKind = "cross" | "square" | "circle";

export function CaptionGlyph({ kind }: { kind: CaptionGlyphKind }) {
  if (kind === "cross") {
    return (
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M2 2l8 8M10 2l-8 8" />
      </svg>
    );
  }
  if (kind === "square") {
    return (
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true">
        <rect className="df-cap-fill" x="3" y="3" width="6" height="6" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="6" cy="6" r="3" />
    </svg>
  );
}
