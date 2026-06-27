import { AlertCircle, Home, RefreshCw } from "lucide-react";
import { Component, useState, type ErrorInfo, type ReactNode } from "react";

import { i18nText } from "../lib/i18n-text";
import { Button } from "./ui";

export type ErrorFallbackProps = {
  error: Error;
  reset: () => void;
  showHome?: boolean;
};

export function ErrorFallback({ error, reset, showHome = true }: ErrorFallbackProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center"
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
    >
      <AlertCircle className="h-10 w-10 text-app-danger" aria-hidden="true" />
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-app-text">
          {i18nText("页面出现错误", "Something went wrong")}
        </h1>
        <p className="text-sm text-app-muted">
          {i18nText("应用遇到了意外错误，请重试或返回首页。", "The app hit an unexpected error. Please retry or go back home.")}
        </p>
      </div>
      {error.message && (
        <div className="w-full max-w-md">
          <button
            type="button"
            className="text-xs text-app-muted underline hover:text-app-text"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? i18nText("隐藏详情", "Hide details") : i18nText("显示详情", "Show details")}
          </button>
          {expanded && (
            <pre className="mt-2 max-h-40 overflow-auto rounded border border-app-border bg-app-panel p-2 text-left text-xs text-app-danger">
              {error.message}
            </pre>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button onClick={reset}>
          <RefreshCw className="h-4 w-4" />
          {i18nText("重试", "Retry")}
        </Button>
        {showHome && (
          <Button variant="secondary" onClick={() => { window.location.hash = ""; window.location.pathname = "/"; }}>
            <Home className="h-4 w-4" />
            {i18nText("返回首页", "Go home")}
          </Button>
        )}
      </div>
    </div>
  );
}

export type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  showHomeInFallback?: boolean;
};

type ErrorBoundaryState = { error: Error | null };

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught an error.", error, info);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { fallback, showHomeInFallback = true } = this.props;
    if (typeof fallback === "function") return fallback(error, this.reset);
    if (fallback !== undefined) return fallback;
    return <ErrorFallback error={error} reset={this.reset} showHome={showHomeInFallback} />;
  }
}
