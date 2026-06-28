import ReactDOM from "react-dom/client";
import App from "./App";

// NOTE: StrictMode is intentionally omitted. Its dev-only double-invoke of effects
// races two <foliate-view> instances on the same container (the engine is a stateful
// custom element opened asynchronously). Revisit with a proper idempotent guard later.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
