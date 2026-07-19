import "@fontsource-variable/inter";
import React from "react";
import ReactDOM from "react-dom/client";

import { SuperTokensAuthPage } from "./SuperTokensAuthPage";
import "./auth.css";

export function renderSuperTokensAuth(): void {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing application root.");
  document.title = "Sign in · Glasswing AI";
  document.documentElement.classList.add("gw-auth-document");
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <SuperTokensAuthPage />
    </React.StrictMode>,
  );
}
