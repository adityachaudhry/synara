// FILE: GlasswingBrand.tsx
// Purpose: Render the official Glasswing mark or wordmark copied from glasswing-ai-2.
// Layer: Shared app branding primitive

import type { ImgHTMLAttributes } from "react";
import { cn } from "~/lib/utils";

type GlasswingBrandProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "alt" | "src"> & {
  variant?: "mark" | "wordmark";
};

const BRAND_ASSET_BY_VARIANT = {
  mark: "/brand/glasswing-mark.svg",
  wordmark: "/brand/glasswing-logo.svg",
} as const;

export function GlasswingBrand({
  className,
  variant = "mark",
  ...props
}: GlasswingBrandProps) {
  const isDecorative = props["aria-hidden"] === true;

  return (
    <img
      alt={isDecorative ? "" : "Glasswing AI"}
      src={BRAND_ASSET_BY_VARIANT[variant]}
      {...props}
      className={cn("shrink-0 object-contain", className)}
    />
  );
}
