/**
 * ErrorBoundary — isolates render-time failures to a single panel.
 *
 * React only exposes error boundaries via class components, so this file is the
 * one class component in the dashboard. Each `name`d boundary wraps one panel
 * in App.tsx so a malformed assurance payload, a stale alert row, or a chart
 * arithmetic mishap can't take down the entire screen.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfacing the boundary name makes triage in the browser console cheap:
    // you immediately know which panel blew up, not just the stack trace.
    console.error(`[ErrorBoundary:${this.props.name}]`, error, info);
  }

  handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <section className="panel" role="alert" aria-live="polite">
          <div className="panel-title">{this.props.name}</div>
          <div className="realtime-banner is-inline">
            <span className="dot" aria-hidden />
            This panel encountered an error.
          </div>
          <div className="boundary-fallback">
            <code>{error.message}</code>
            <div className="actions">
              <button type="button" className="btn" onClick={this.handleRetry}>
                Retry
              </button>
            </div>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}
