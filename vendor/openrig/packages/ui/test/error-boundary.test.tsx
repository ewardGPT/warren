// OPR.0.4.1.13: the reusable ErrorBoundary contains a child render-throw to its
// subtree (default fallback or a provided one) instead of letting it white-screen the
// page - the "render stably" insurance behind the table-view crash fix.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { ErrorBoundary } from "../src/components/ui/ErrorBoundary.js";

function Boom(): never {
  throw new Error("kaboom");
}

afterEach(() => cleanup());

describe("OPR.0.4.1.13 ErrorBoundary", () => {
  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <div data-testid="ok-child">fine</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("ok-child")).toBeTruthy();
  });

  it("contains a child render-throw + shows the default fallback (no white-screen)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <ErrorBoundary label="Table view">
          <Boom />
        </ErrorBoundary>,
      ),
    ).not.toThrow();
    const fallback = screen.getByTestId("error-boundary-fallback");
    expect(fallback.textContent).toContain("Table view");
    expect(fallback.getAttribute("role")).toBe("alert");
    spy.mockRestore();
  });

  it("renders a provided fallback when given one", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary fallback={<div data-testid="custom-fallback">custom</div>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("custom-fallback")).toBeTruthy();
    spy.mockRestore();
  });
});
