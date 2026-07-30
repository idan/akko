import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import SkillsPanel from "./SkillsPanel.svelte";
import type { AkkoClient } from "../client.svelte.ts";

/** A stub client with just the surface the panel reads. */
function client(over: Partial<AkkoClient> = {}): AkkoClient {
  return {
    skills: [],
    skillImpact: null,
    staleSessions: [],
    error: null,
    loadSkills: vi.fn(async () => {}),
    loadSystemPrompt: vi.fn(async () => "FULL PROMPT"),
    setSkillHidden: vi.fn(async () => {}),
    ...over,
  } as unknown as AkkoClient;
}

const skill = (name: string, over = {}) => ({
  name,
  description: `does ${name}`,
  source: "workspace",
  filePath: `/s/${name}`,
  enabled: true,
  hiddenFromPrompt: false,
  ...over,
});

describe("SkillsPanel", () => {
  test("shows the per-turn budget, which is the number that is otherwise invisible", () => {
    render(SkillsPanel, {
      client: client({
        skills: [skill("alpha")] as never,
        skillImpact: { perSkill: [{ name: "alpha", tokens: 120, hiddenFromPrompt: false }], totalTokens: 120, injectedBlock: "<available_skills>" } as never,
      }),
      onclose: vi.fn(),
    });

    expect(screen.getByText(/120 tokens \/ turn/)).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText(/does alpha/)).toBeInTheDocument();
  });

  test("orders skills by cost, so the expensive ones are what you see first", () => {
    const { container } = render(SkillsPanel, {
      client: client({
        skills: [skill("cheap"), skill("expensive")] as never,
        skillImpact: {
          perSkill: [
            { name: "cheap", tokens: 10, hiddenFromPrompt: false },
            { name: "expensive", tokens: 900, hiddenFromPrompt: false },
          ],
          totalTokens: 910,
          injectedBlock: "x",
        } as never,
      }),
      onclose: vi.fn(),
    });

    const names = [...container.querySelectorAll("[data-skill]")].map((el) => el.getAttribute("data-skill"));
    expect(names).toEqual(["expensive", "cheap"]);
  });

  test("a hidden skill reports zero cost and offers to be shown again", () => {
    render(SkillsPanel, {
      client: client({
        skills: [skill("quiet", { hiddenFromPrompt: true })] as never,
        skillImpact: { perSkill: [{ name: "quiet", tokens: 0, hiddenFromPrompt: true }], totalTokens: 0, injectedBlock: "" } as never,
      }),
      onclose: vi.fn(),
    });

    expect(screen.getByText("0 tok")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show in prompt/ })).toBeInTheDocument();
  });

  test("toggling asks the client to change visibility", async () => {
    const user = userEvent.setup();
    const c = client({
      skills: [skill("alpha")] as never,
      skillImpact: { perSkill: [{ name: "alpha", tokens: 5, hiddenFromPrompt: false }], totalTokens: 5, injectedBlock: "x" } as never,
    });
    render(SkillsPanel, { client: c, onclose: vi.fn() });

    await user.click(screen.getByRole("button", { name: /Hide from prompt/ }));
    expect(c.setSkillHidden).toHaveBeenCalledWith("alpha", true);
  });

  test("warns when running sessions still use an older skill set", () => {
    // Prompts are snapshots, so a change doesn't reach live sessions (doc 06).
    render(SkillsPanel, { client: client({ staleSessions: ["ses_1", "ses_2"] as never }), onclose: vi.fn() });
    expect(screen.getByRole("status")).toHaveTextContent(/2 running session\(s\)/);
  });

  test("surfaces the refusal to edit a skill that lives on disk", () => {
    render(SkillsPanel, {
      client: client({ error: `"onDisk" comes from a file on disk, so Akko won't edit it.` }),
      onclose: vi.fn(),
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/file on disk/);
  });

  test("loads the full system prompt only when asked", async () => {
    const user = userEvent.setup();
    const c = client({ skills: [skill("alpha")] as never });
    render(SkillsPanel, { client: c, onclose: vi.fn() });

    // Building the prompt spins up a session, so it must not happen on render.
    expect(c.loadSystemPrompt).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Show full system prompt/ }));
    await waitFor(() => expect(screen.getByText("FULL PROMPT")).toBeInTheDocument());
  });

  test("empty state when a workspace has no skills", () => {
    render(SkillsPanel, { client: client(), onclose: vi.fn() });
    expect(screen.getByText(/No skills discovered/)).toBeInTheDocument();
  });
});
