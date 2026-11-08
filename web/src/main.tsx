import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initNavigation } from "./nav/focus";
import "./styles/app.css";

initNavigation();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
