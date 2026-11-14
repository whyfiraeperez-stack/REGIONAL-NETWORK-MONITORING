import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./style.css";

class DashboardErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("Dashboard startup/render failure:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <main style={{ minHeight: "100vh", padding: "32px", background: "#07131c", color: "#e8f0f4", fontFamily: "Arial, sans-serif" }}>
          <h1>Dashboard could not start</h1>
          <p>The dashboard caught a startup or rendering error instead of showing a blank screen.</p>
          <pre style={{ whiteSpace: "pre-wrap", color: "#ffb4b4", background: "#351e25", padding: "16px", borderRadius: "8px" }}>{String(this.state.error?.message || this.state.error)}</pre>
          <button onClick={() => window.location.reload()} style={{ padding: "10px 16px", cursor: "pointer" }}>Reload dashboard</button>
        </main>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  document.body.innerHTML = '<main style="padding:32px;font-family:Arial,sans-serif"><h1>Dashboard setup error</h1><p>The page is missing its root element. Check the deployed index.html file.</p></main>';
} else {
  createRoot(rootElement).render(
    <React.StrictMode>
      <DashboardErrorBoundary>
        <App />
      </DashboardErrorBoundary>
    </React.StrictMode>
  );
}
