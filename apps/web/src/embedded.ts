// FILE: embedded.ts
// Purpose: Public package entrypoint for mounting the complete Synara app in another React host.
// Layer: Web package boundary

import "@fontsource-variable/jetbrains-mono";
import "./index.css";

export { SynaraApp, type SynaraAppProps } from "./SynaraApp";
export { createEmbeddedAppHistory } from "./appNavigation";
export type {
  SynaraRuntimeConfig,
  SynaraWebSocketUrlResolver,
} from "./synaraRuntimeConfig";
