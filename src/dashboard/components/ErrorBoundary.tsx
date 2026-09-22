import { Component, type ReactNode } from 'react';

interface State { error: Error | null }

/** Keeps one broken view from blanking the whole dashboard. */
export class ErrorBoundary extends Component<{ children: ReactNode; name: string }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidUpdate(prev: { name: string }) { if (prev.name !== this.props.name && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <div className="card" style={{ borderColor: 'rgba(248,113,113,.5)' }}>
          <h3 style={{ marginTop: 0 }}>The {this.props.name} view hit an error</h3>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', color: 'var(--bad)' }}>{this.state.error.message}</pre>
          <button className="btn sm" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </div>
    );
  }
}
