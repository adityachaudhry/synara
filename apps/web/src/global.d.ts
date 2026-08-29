// FILE: global.d.ts
// Purpose: Declare ambient modules used by the web app when upstream packages omit types.
// Layer: Web type declarations
// Exports: module declarations only

declare module "@fontsource-variable/jetbrains-mono";

declare module "virtual:synara-central-icon-assets" {
  export const CENTRAL_ICON_ASSET_URLS: Readonly<
    Record<"reversed" | "fill", Readonly<Record<string, string>>>
  >;
}
