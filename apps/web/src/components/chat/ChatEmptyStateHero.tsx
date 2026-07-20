// FILE: ChatEmptyStateHero.tsx
// Purpose: Render the centered empty-state hero for blank transcripts.
// Layer: Chat presentation
// Depends on: the caller-supplied project display name.

import { memo } from "react";
import { IN_APP_BRAND_HEADING_FONT_CLASS_NAME } from "~/branding";
import { GlasswingBrand } from "~/components/GlasswingBrand";

export const ChatEmptyStateHero = memo(function ChatEmptyStateHero({
  projectName,
}: {
  projectName: string | undefined;
}) {
  return (
    <div className="flex flex-col items-center gap-5 select-none">
      <GlasswingBrand aria-label="Glasswing AI" className="h-10 w-auto" />

      <div className="flex flex-col items-center gap-0.5">
        <h1
          className={`${IN_APP_BRAND_HEADING_FONT_CLASS_NAME} text-2xl font-medium tracking-[-0.015em] text-foreground/90`}
        >
          Let's build
        </h1>
        {projectName && <span className="text-lg text-muted-foreground/40">{projectName}</span>}
      </div>
    </div>
  );
});
