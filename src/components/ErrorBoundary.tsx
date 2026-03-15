import { Component, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('StreamVault Error:', error);
    console.error('Component Stack:', errorInfo.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <div>
            <h1 className="text-22 lg:text-28 font-bold text-[#ff4757]">Something went wrong</h1>
            <p className="text-15 lg:text-18 text-[#888] max-w-full lg:max-w-[600px] text-center px-4 lg:px-0">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            <button
              className="py-3 px-7 bg-surface-border border-2 border-transparent rounded-lg text-15 lg:text-18 transition-all duration-150 focus:border-accent focus:scale-[1.03]"
              data-focusable
              tabIndex={0}
              onClick={this.handleReload}
              autoFocus
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
