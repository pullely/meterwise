import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@web-console-next/components/ui/button";

/**
 * Regression for the billing-page crash (prod/stage, "Something went wrong" on
 * load). `<Button asChild>` renders through Radix `Slot`, which requires exactly
 * ONE React element child (it runs `React.Children.only`). The button used to
 * emit a `{showSpinner ? <Loader2/> : null}` sibling unconditionally; under
 * `asChild` that `null` still counts as a second child, so `Slot` threw
 * "React.Children.only expected to receive a single React element child" the
 * moment the component rendered. The billing page's "Change plan" button is
 * `asChild`, so the page crashed on load for every org.
 *
 * These tests render the real Button via `react-dom/server` and lock the
 * single-child contract so the regression can't return.
 */
describe("Button asChild", () => {
  it("renders a single-child Slot without throwing and preserves the child element", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        Button,
        { asChild: true },
        React.createElement("a", { href: "/orgs/acme/settings/billing/change-plan" }, "Change plan"),
      ),
    );
    // Slot merges Button's classes onto the child <a> rather than throwing.
    expect(html).toContain("Change plan");
    expect(html).toContain('href="/orgs/acme/settings/billing/change-plan"');
    expect(html).toContain("<a ");
    expect(html).not.toContain("<button");
  });

  it("renders a normal button with its label", () => {
    const html = renderToStaticMarkup(React.createElement(Button, {}, "Save"));
    expect(html).toContain("Save");
    expect(html).toContain("<button");
  });

  it("shows a leading spinner on a real button when loading", () => {
    const html = renderToStaticMarkup(React.createElement(Button, { loading: true }, "Save"));
    expect(html).toContain("animate-spin");
  });

  it("never injects a spinner under asChild (would break the single-child Slot)", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        Button,
        { asChild: true, loading: true },
        React.createElement("a", { href: "/x" }, "Go"),
      ),
    );
    expect(html).toContain("Go");
    expect(html).not.toContain("animate-spin");
  });
});
