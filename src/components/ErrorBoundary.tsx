// Contains a render/commit failure to one region of the shell. Without a
// boundary, React unmounts the WHOLE tree on any uncaught render or effect
// error and the window goes blank until restart (round 4: the post-PDF
// freeze). `resetKey` clears the failure when the region shows something
// else (another conversation, another preview target). Zero telemetry:
// the error is not reported anywhere.

import { Component, type ReactNode } from "react";

interface Props {
  /// When this value changes, a failed boundary renders its children again.
  resetKey: string | number;
  fallback: ReactNode;
  children: ReactNode;
}

interface State {
  failed: boolean;
  key: string | number;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { failed: false, key: props.resetKey };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
