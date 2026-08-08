import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 局部兜底文案；不传则显示整页错误 */
  fallbackText?: string;
}

interface State {
  hasError: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallbackText) {
      return <div className="form-error">{this.props.fallbackText}</div>;
    }

    return (
      <div className="page">
        <div className="empty-state">
          <p>页面出错了。</p>
          <p className="text-secondary">刷新一下通常就能恢复；如果反复出现请告诉管理员。</p>
          <button className="btn btn-primary" onClick={() => window.location.reload()} style={{ marginTop: 12 }}>
            刷新页面
          </button>
        </div>
      </div>
    );
  }
}
