// FILE: embeddedTypography.ts
// Purpose: Maps a host-selected embedded base font size onto Synara's typography tokens.
// Layer: Web runtime adapter

import { getAppTypographyScale } from "./appTypography";

export interface EmbeddedTypographyStyle {
  readonly "--app-font-size-base": string;
  readonly "--app-font-size-ui": string;
  readonly "--app-font-size-ui-lg": string;
  readonly "--app-font-size-ui-sm": string;
  readonly "--app-font-size-ui-xs": string;
  readonly "--app-font-size-ui-2xs": string;
  readonly "--app-font-size-ui-meta": string;
  readonly "--app-font-size-ui-timestamp": string;
  readonly "--app-font-size-chat": string;
  readonly "--app-font-size-chat-code": string;
  readonly "--app-font-size-chat-meta": string;
  readonly "--app-font-size-chat-tiny": string;
}

export function createEmbeddedTypographyStyle(
  value: unknown,
): EmbeddedTypographyStyle | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;

  const scale = getAppTypographyScale(value);
  return {
    "--app-font-size-base": `${scale.basePx}px`,
    "--app-font-size-ui": `${scale.uiPx}px`,
    "--app-font-size-ui-lg": `${scale.uiLgPx}px`,
    "--app-font-size-ui-sm": `${scale.uiSmPx}px`,
    "--app-font-size-ui-xs": `${scale.uiXsPx}px`,
    "--app-font-size-ui-2xs": `${scale.ui2XsPx}px`,
    "--app-font-size-ui-meta": `${scale.uiMetaPx}px`,
    "--app-font-size-ui-timestamp": `${scale.uiTimestampPx}px`,
    "--app-font-size-chat": `${scale.chatPx}px`,
    "--app-font-size-chat-code": `${scale.chatCodePx}px`,
    "--app-font-size-chat-meta": `${scale.chatMetaPx}px`,
    "--app-font-size-chat-tiny": `${scale.chatTinyPx}px`,
  };
}

