import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SplitProposal } from "../../src/ai/prompt.js";

const spinner = {
  text: "",
  isSpinning: false,
  start: vi.fn(function start(message?: string) {
    if (message) {
      spinner.text = message;
    }
    spinner.isSpinning = true;
    return spinner;
  }),
  stop: vi.fn(function stop() {
    spinner.isSpinning = false;
    return spinner;
  }),
  succeed: vi.fn(function succeed() {
    spinner.isSpinning = false;
    return spinner;
  }),
  fail: vi.fn(function fail() {
    spinner.isSpinning = false;
    return spinner;
  }),
};

const { mockGenerateProposal, mockExecuteSplit } = vi.hoisted(() => ({
  mockGenerateProposal: vi.fn(),
  mockExecuteSplit: vi.fn(),
}));

vi.mock("ora", () => ({
  default: () => spinner,
}));

vi.mock("../../src/core/orchestrator.js", () => ({
  generateProposal: mockGenerateProposal,
  executeSplit: mockExecuteSplit,
}));

import { runSplitLoop } from "../../src/cli/index.js";

describe("runSplitLoop (integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spinner.text = "";
    spinner.isSpinning = false;
  });

  it("--dry-run のときは PR 作成を実行しない", async () => {
    const proposal: SplitProposal = {
      parts: [
        {
          order: 1,
          branchName: "feat/part-1",
          title: "feat: one",
          description: "desc",
          files: ["src/a.ts"],
          rationale: "reason",
        },
      ],
    };

    mockGenerateProposal.mockResolvedValue({
      proposal,
      owner: "acme",
      repo: "repo",
      prNumber: 123,
      headBranch: "feature/original",
      baseBranch: "main",
      originalPRTitle: "Original PR",
      files: [{ filename: "src/a.ts", patch: "+a", status: "modified" }],
    });

    const exitCode = await runSplitLoop("123", "claude", true);

    expect(exitCode).toBe(0);
    expect(mockGenerateProposal).toHaveBeenCalledTimes(1);
    expect(mockExecuteSplit).not.toHaveBeenCalled();
  });
});
