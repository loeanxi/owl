import React from "react";
import { createRoot } from "react-dom/client";
import App from "../../src/App.tsx";

// Bundle the actual App, including its artifact scope, transcript and bridge client.
createRoot(document.getElementById("root")).render(React.createElement(App));
