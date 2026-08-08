import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";

import { SynaraApp } from "./SynaraApp";
import { APP_DISPLAY_NAME } from "./branding";
import { isElectron } from "./env";
import {
  applyGlasswingModeAttribute,
  getGlasswingModeForCurrentPage,
} from "./glasswingMode";

document.title = APP_DISPLAY_NAME;
applyGlasswingModeAttribute(document.documentElement, getGlasswingModeForCurrentPage());

if (isElectron) {
  document.documentElement.dataset.runtime = "electron";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SynaraApp />
  </React.StrictMode>,
);
