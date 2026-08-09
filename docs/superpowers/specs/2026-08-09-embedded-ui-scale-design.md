# Embedded Synara UI Scale Design

## Problem

At 100% Chrome zoom, the Glasswing-embedded Synara shell renders with a 12px
base type scale and 28px navigation rows inside a host that otherwise uses a
16px base. The full shell therefore looks globally zoomed out. Increasing only
the chat font would leave icons, sidebars, headers, control heights, gutters,
and composer geometry unchanged.

## Decision

Extend the additive `SynaraApp` host adapter with an optional
`displayScale` number. Glasswing will pass `1.3`, matching the requested point
between browser zoom 125% and 150%. Standalone Synara will omit the option and
continue rendering at scale `1`.

The React app will wrap its route provider in one positioned viewport shell.
For scales above `1`, the shell uses CSS layout zoom with `100%` width and
height. CSS zoom already reduces the logical percentage basis by the same
factor, so the rendered result occupies exactly the host rectangle while Synara
reflows against a smaller logical viewport and all descendants—type, spacing,
icons, fixed widths, and controls—grow together.

The public value is normalized to a conservative `1` through `1.5` range and
rounded to two decimals. Invalid values fall back to `1`. This keeps a malformed
embedding host from making the app unusable.

## Alternatives Rejected

- Change `DEFAULT_CHAT_FONT_SIZE_PX` globally: affects standalone and only
  enlarges text.
- Force spacious density in embedded mode: improves rows and composer spacing
  but leaves many fixed-size surfaces unchanged.
- Apply an unbounded transform in Glasswing: does not reflow layout, risks blurry
  text and clipping, and hides the behavior outside the reusable React adapter.

## Compatibility

- The option is additive and optional.
- Existing hosts and standalone entrypoints remain byte-for-byte equivalent in
  layout behavior when the option is absent.
- Glasswing owns the product choice of `1.3`; Synara owns safe normalization and
  the reflowing viewport implementation.
- Existing embedded container-height behavior remains authoritative, so scaling
  must not reintroduce bottom clipping.

## Verification

1. Unit tests first prove invalid values normalize to `1`, valid values are
   rounded/clamped, and scale `1.3` produces host-filling `100%` dimensions.
2. Existing runtime-config tests prove the option survives configuration and is
   absent in standalone defaults.
3. Production package and Glasswing builds must pass.
4. Chrome at browser zoom 100% must report an effective embedded scale of `1.3`,
   larger rendered navigation/control dimensions, exact host-edge containment,
   zero page overflow, and a usable composer plus model picker.
