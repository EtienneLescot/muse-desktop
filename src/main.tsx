import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Keep the inline boot surface available when the bundle cannot mount, but
// remove it after the first committed React frame so it never overlays the
// real application or becomes a second state source.
requestAnimationFrame(() => {
  document.getElementById("boot-screen")?.remove();
});
