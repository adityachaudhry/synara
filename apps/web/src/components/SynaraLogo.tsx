// FILE: SynaraLogo.tsx
// Purpose: Render the Synara mark as an inline SVG that follows theme foreground color.
// Layer: Shared app branding primitive

import type { SVGProps } from "react";
import { SYNARA_LOGO_PATHS } from "~/assets/synaraLogoPath";
import { cn } from "~/lib/utils";
import { useSynaraHostSidebar } from "../hostSidebar";

export function SynaraLogo({ className, ...props }: SVGProps<SVGSVGElement>) {
  const hostSidebar = useSynaraHostSidebar();
  const ariaLabel = props["aria-label"];

  if (hostSidebar?.brandIconUrl) {
    return (
      <svg
        viewBox="0 0 180 180"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden={ariaLabel ? undefined : true}
        {...props}
        className={cn("shrink-0", className)}
      >
        <image href={hostSidebar.brandIconUrl} x="0" y="0" width="180" height="180" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 470 504"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaLabel ? undefined : true}
      {...props}
      className={cn("shrink-0 text-foreground", className)}
    >
      {SYNARA_LOGO_PATHS.map((path) => (
        <path key={path} d={path} fill="currentColor" />
      ))}
    </svg>
  );
}
