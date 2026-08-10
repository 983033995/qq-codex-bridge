import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { router } from "./router.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Control UI root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
