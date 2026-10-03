import React from "react";
import { createRoot } from "react-dom/client";
import App from "../../src/App.tsx";

// Render the actual application; the browser harness supplies a local fake bridge.
createRoot(document.getElementById("root")).render(React.createElement(App));
