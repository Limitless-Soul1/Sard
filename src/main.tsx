import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// StrictMode is ON again (RAWY-10): FoliateController.open() is now idempotent (disposes
// any prior view + bails if superseded), so the dev double-invoke no longer races views.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
