import { createRoot } from "react-dom/client";
import { App } from "@frontend/app/app";
import "@frontend/styles/theme.css";
import "@frontend/styles/base.css";

createRoot(document.getElementById("root")!).render(<App />);
