import React from "react";
import App from "./App";
import { startApp } from "./ErrorBoundary";
import { I18nProvider } from "./i18n";

// R19-A: the app runs under a root error boundary and a window crash guard,
// so a crash shows a recovery screen instead of a black window.
startApp(document.getElementById("root") as HTMLElement, () => (
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
));
