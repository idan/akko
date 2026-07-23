import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import Composer from "./Composer.svelte";

describe("Composer", () => {
  test("sends trimmed text on Enter and clears the input", async () => {
    const user = userEvent.setup();
    const onsend = vi.fn();
    render(Composer, { onsend });

    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.type(box, "  hello world  ");
    await user.keyboard("{Enter}");

    expect(onsend).toHaveBeenCalledTimes(1);
    expect(onsend).toHaveBeenCalledWith("hello world");
    expect(box.value).toBe("");
  });

  test("Shift+Enter inserts a newline instead of sending", async () => {
    const user = userEvent.setup();
    const onsend = vi.fn();
    render(Composer, { onsend });

    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.type(box, "line one");
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(onsend).not.toHaveBeenCalled();
    expect(box.value).toContain("line one");
  });

  test("does not send whitespace-only input", async () => {
    const user = userEvent.setup();
    const onsend = vi.fn();
    render(Composer, { onsend });

    await user.type(screen.getByRole("textbox"), "   ");
    await user.keyboard("{Enter}");

    expect(onsend).not.toHaveBeenCalled();
  });

  test("Send button is disabled until there is non-empty text", async () => {
    const user = userEvent.setup();
    render(Composer, { onsend: vi.fn() });

    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toBeDisabled();

    await user.type(screen.getByRole("textbox"), "x");
    expect(button).toBeEnabled();
  });
});
