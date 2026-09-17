import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

class AppErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render() {
    if (this.state.error !== null) {
      return (
        <div id="boot-screen" role="alert">
          <img src="/favicon.png" alt="Muse-Desktop" />
          <span>Muse-Desktop could not load. Restart the app to try again.</span>
        </div>
      );
    }
    return this.props.children;
  }
}

function DismissBootScreen() {
  useEffect(() => {
    document.getElementById("boot-screen")?.remove();
  }, []);
  return null;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
      <DismissBootScreen />
    </AppErrorBoundary>
  </React.StrictMode>,
);
