// @vitest-environment jsdom
// Round 7 spec: a newer release shows a non-invasive banner with "Update";
// it never installs by itself, and the close button hides the banner until
// the next check. R20-E: the shell owns the schedule (startup, every 2 h,
// on return; see updateSchedule.test.ts and App.updateSchedule.test.tsx);
// the banner only shows the result it is handed.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());

import { invokedWith, resetTauri } from "../test/tauriMock";
import { I18nProvider } from "../i18n";
import type { Locale } from "../i18n/locale";
import type { UpdateInfo } from "../core";
import { UpdateBanner } from "./UpdateBanner";

const NEXT: UpdateInfo = { version: "0.3.0", current_version: "0.2.0" };

afterEach(cleanup);

type Props = Parameters<typeof UpdateBanner>[0];

function renderBanner(props: Partial<Props> = {}, locale: Locale = "en") {
  const all: Props = { update: NEXT, checkSeq: 1, ...props };
  return render(
    <I18nProvider initial={locale}>
      <UpdateBanner {...all} />
    </I18nProvider>,
  );
}

describe("UpdateBanner (round 7)", () => {
  it("shows the new version with an Update button, and never installs by itself", async () => {
    const install = vi.fn(async () => {});
    renderBanner({ install });
    expect(screen.getByText("A new version is available: 0.3.0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
    await act(async () => {});
    expect(install).not.toHaveBeenCalled();
  });

  it("speaks Spanish", () => {
    renderBanner({}, "es");
    expect(screen.getByText("Hay una versión nueva: 0.3.0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actualizar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeTruthy();
  });

  it("shows nothing when there is no update", () => {
    const { container } = renderBanner({ update: null });
    expect(container.querySelector(".update-banner")).toBeNull();
  });

  it("Update downloads, installs and relaunches through the core, once", async () => {
    let finish: () => void = () => {};
    const install = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    renderBanner({ install });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    const busy = await screen.findByRole("button", { name: "Updating…" });
    // Round 14 (C3): aria-disabled, not `disabled`, so focus is not lost.
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(busy);
    expect(install).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("a failed install says so and lets the user retry", async () => {
    const install = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("bad signature"))
      .mockResolvedValueOnce(undefined);
    renderBanner({ install });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    // Round 14 (C3): the failure is a role="alert", not just status text.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not update. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(install).toHaveBeenCalledTimes(2));
  });

  it("round 14 QA: another surface installing keeps this banner inert", () => {
    const install = vi.fn(async () => {});
    const { container } = renderBanner({ install, externalBusy: true });

    const busy = screen.getByRole("button", { name: "Updating…" });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(busy);
    expect(install).not.toHaveBeenCalled();

    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    expect(dismiss.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(dismiss);
    expect(container.querySelector(".update-banner")).not.toBeNull();
  });

  it("installs through the core command update_install by default", async () => {
    resetTauri({ update_install: () => undefined });
    renderBanner();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(invokedWith("update_install")).toHaveLength(1));
  });

  it("never checks by itself: the shell owns the schedule (R20-E)", async () => {
    resetTauri({ update_check: () => NEXT });
    renderBanner({ update: null, checkSeq: 0 });
    await act(async () => {});
    expect(invokedWith("update_check")).toHaveLength(0);
  });

  it("dismiss hides the banner until the next check, which brings it back", () => {
    const { container, rerender } = renderBanner({ update: null, checkSeq: 1 });
    expect(container.querySelector(".update-banner")).toBeNull();
    const show = (seq: number) =>
      rerender(
        <I18nProvider initial="en">
          <UpdateBanner update={NEXT} checkSeq={seq} />
        </I18nProvider>,
      );
    show(2);
    expect(container.querySelector(".update-banner")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(container.querySelector(".update-banner")).toBeNull();
    // A re-render without a new check keeps it dismissed.
    show(2);
    expect(container.querySelector(".update-banner")).toBeNull();
    show(3);
    expect(container.querySelector(".update-banner")).not.toBeNull();
  });

  // CI regression (macos-latest): the user (or findByRole) can click
  // Dismiss in the gap between the commit that shows the banner and React's
  // passive-effect flush. An effect re-showing the banner on every check
  // then ran AFTER the dismiss and brought it back.
  it("a dismiss right after a check lands stays dismissed", async () => {
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const wasAct = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false; // real scheduling, no act() flushing
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await new Promise<void>((resolve) => {
        const seen = new MutationObserver(() => {
          const dismiss = host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
          if (!dismiss) return;
          seen.disconnect();
          dismiss.click(); // before the commit's passive effects ran
          resolve();
        });
        seen.observe(host, { childList: true, subtree: true });
        root.render(
          <I18nProvider initial="en">
            <UpdateBanner update={NEXT} checkSeq={1} />
          </I18nProvider>,
        );
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(host.querySelector(".update-banner")).toBeNull();
    } finally {
      root.unmount();
      host.remove();
      env.IS_REACT_ACT_ENVIRONMENT = wasAct;
    }
  });
});
