import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import "@fontsource-variable/jetbrains-mono";
import "./index.css";

import { appHistory } from "./appNavigation";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { isElectron } from "./env";
import {
  applyGlasswingModeAttribute,
  getGlasswingModeForCurrentPage,
} from "./glasswingMode";

const router = getRouter(appHistory);

document.title = APP_DISPLAY_NAME;
applyGlasswingModeAttribute(document.documentElement, getGlasswingModeForCurrentPage());

if (isElectron) {
  document.documentElement.dataset.runtime = "electron";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
