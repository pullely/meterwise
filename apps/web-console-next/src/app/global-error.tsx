"use client";

import * as React from "react";

/**
 * Last-resort boundary for errors in the root layout itself. It replaces the
 * whole document, so it can't rely on the app's CSS/providers — inline styles
 * only. This is the safety net that prevents a bare "Application error".
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("Global error boundary:", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#09090b",
          color: "#fafafa",
          fontFamily: "Inter, system-ui, sans-serif",
          padding: "1rem",
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: "#a1a1aa", margin: "0 0 16px" }}>
            The console hit an unexpected error. Please retry.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                height: 36,
                padding: "0 16px",
                borderRadius: 8,
                border: "1px solid #27272a",
                background: "transparent",
                color: "#fafafa",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <a
              href="/orgs"
              style={{
                height: 36,
                display: "inline-flex",
                alignItems: "center",
                padding: "0 16px",
                borderRadius: 8,
                background: "#6d5efc",
                color: "#fff",
                fontSize: 14,
                textDecoration: "none",
              }}
            >
              Back to organizations
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
