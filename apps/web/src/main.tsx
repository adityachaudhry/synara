import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/jetbrains-mono";
import "./index.css";

import { SynaraApp } from "./SynaraApp";
import { APP_DISPLAY_NAME } from "./branding";
import { isElectron } from "./env";
import { isMacPlatform } from "./lib/utils";

document.title = APP_DISPLAY_NAME;

if (isElectron) {
  document.documentElement.dataset.runtime = "electron";
  // macOS desktop windows are transparent vibrancy windows (see getWindowMaterialOptions
  // in apps/desktop), and Chromium cannot render `backdrop-filter` inside transparent
  // windows — frosted surfaces must fall back to a more opaque fill (see index.css).
  if (isMacPlatform(navigator.platform)) {
    document.documentElement.dataset.windowTransparent = "true";
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SynaraApp />
  </React.StrictMode>,
);
