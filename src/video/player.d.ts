// R-V1: the <hyperframes-player> custom element (@hyperframes/player) in JSX.
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "hyperframes-player": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        controls?: boolean;
        muted?: boolean;
        loop?: boolean;
        autoplay?: boolean;
        width?: number;
        height?: number;
        "sandbox-origin"?: string;
        "low-power-idle"?: boolean;
        "disable-click-to-play"?: boolean;
      };
    }
  }
}
