// OPR.0.4.1.13: a small reusable React error boundary.
//
// The topology table view (and other render-heavy surfaces) can throw during render
// on a malformed data shape. With NO boundary, a single render throw propagates to
// the root and white-screens the WHOLE page. This boundary CONTAINS a render throw to
// its subtree and shows a quiet inline fallback so the rest of the page stays usable -
// "render stably" (OPR.0.4.1.13). The root-cause data guard is the primary fix; this
// is defense-in-depth so any residual/future edge degrades gracefully, not fatally.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Inline fallback shown when a child render throws. */
  fallback?: ReactNode;
  /** Optional label for the default fallback + console diagnostics. */
  label?: string;
  /** Optional hook for diagnostics/telemetry. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the throw visible for diagnostics without crashing the page.
    console.error(`[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ""}]`, error, info.componentStack);
    this.props.onError?.(error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div
          data-testid="error-boundary-fallback"
          role="alert"
          className="border border-outline-variant bg-surface-low px-3 py-6 text-center font-mono text-xs text-on-surface-variant"
        >
          {this.props.label ? `${this.props.label} failed to render.` : "This view failed to render."}
          {" "}The rest of the page is still usable.
        </div>
      );
    }
    return this.props.children;
  }
}
