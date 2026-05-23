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
          <div className="realtime-banner" style={{ borderBottom: 'none' }}>
            <span className="dot" aria-hidden />
            This panel encountered an error.
          </div>
          <div style={{ padding: '12px 16px', fontSize: 12 }}>
            <code style={{ display: 'block', marginBottom: 12, whiteSpace: 'pre-wrap' }}>
              {error.message}
            </code>
            <button type="button" onClick={this.handleRetry}>
              Retry
            </button>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}
