import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PromptDialog } from "./PromptDialog";
import { expectNoA11yViolations } from "../test-utils/a11y";

describe("PromptDialog", () => {
  it("submits an initial value without requiring an edit", () => {
    const onSubmit = vi.fn();
    render(<PromptDialog title="Name" initialValue="Original – bearbeitet" submitLabel="Rendern" onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect(screen.getByRole("textbox")).toHaveValue("Original – bearbeitet");
    fireEvent.click(screen.getByRole("button", { name: "Rendern" }));
    expect(onSubmit).toHaveBeenCalledWith("Original – bearbeitet");
  });
  it("renders title and input", () => {
    render(
      <PromptDialog
        title="Enter password"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Enter password")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("calls onSubmit with trimmed input value", () => {
    const onSubmit = vi.fn();
    render(
      <PromptDialog
        title="Enter value"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  my-password  " },
    });
    fireEvent.submit(screen.getByRole("textbox"));

    expect(onSubmit).toHaveBeenCalledWith("my-password");
  });

  it("does not submit when input is empty", () => {
    const onSubmit = vi.fn();
    render(
      <PromptDialog
        title="Enter value"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.submit(screen.getByRole("textbox"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onCancel when cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <PromptDialog
        title="Enter value"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("calls onCancel when Escape is pressed", () => {
    const onCancel = vi.fn();
    render(
      <PromptDialog
        title="Enter value"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("has dialog role", () => {
    render(
      <PromptDialog
        title="Enter value"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <PromptDialog
        title="Enter password"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
