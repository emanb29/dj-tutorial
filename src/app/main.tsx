import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./theme.css";

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error('index.html has no element with id "root".');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
