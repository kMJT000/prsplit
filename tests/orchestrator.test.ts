import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SplitProposal } from "../src/ai/prompt.js";
import type { DiffFile } from "../src/utils/diff.js";

const mocks = vi.hoisted(() => ({
  getAIClient: vi.fn(),
  suggestFilesForBuildRepair: vi.fn(),
  getBranchSha: vi.fn(),
  createBranch: vi.fn(),
  commitFilesToBranch: vi.fn(),
  validateRelativeJsImportsOnRef: vi.fn(),
  waitForBuildAndTest: vi.fn(),
  createDraftPR: vi.fn(),
  closePRs: vi.fn(),
  updatePRMetadata: vi.fn(),
  commitWorkflows: vi.fn(),
  generateWorkflowYaml: vi.fn(),
  generateCloseOriginalWorkflowYaml: vi.fn(),
}));

vi.mock("../src/ai/client.js", () => ({
  getAIClient: mocks.getAIClient,
}));

vi.mock("../src/ai/splitter.js", () => ({
  generateSplitProposal: vi.fn(),
  suggestFilesForBuildRepair: mocks.suggestFilesForBuildRepair,
  validateProposal: vi.fn(),
}));

vi.mock("../src/github/branch.js", () => ({
  getBranchSha: mocks.getBranchSha,
  createBranch: mocks.createBranch,
  commitFilesToBranch: mocks.commitFilesToBranch,
  validateRelativeJsImportsOnRef: mocks.validateRelativeJsImportsOnRef,
}));

vi.mock("../src/github/actions.js", () => ({
  waitForBuildAndTest: mocks.waitForBuildAndTest,
}));

vi.mock("../src/github/pr.js", () => ({
  getPRInfo: vi.fn(),
  getPRFiles: vi.fn(),
  createDraftPR: mocks.createDraftPR,
  closePRs: mocks.closePRs,
  updatePRMetadata: mocks.updatePRMetadata,
}));

vi.mock("../src/github/workflow.js", () => ({
  generateWorkflowYaml: mocks.generateWorkflowYaml,
  generateCloseOriginalWorkflowYaml: mocks.generateCloseOriginalWorkflowYaml,
  commitWorkflows: mocks.commitWorkflows,
}));

import { executeSplit } from "../src/core/orchestrator.js";

describe("executeSplit", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.getAIClient.mockResolvedValue({ complete: vi.fn() });
    mocks.createBranch.mockImplementation(
      async (_owner: string, _repo: string, branchName: string) => branchName
    );
    mocks.commitFilesToBranch.mockResolvedValue("commit-sha");
    mocks.validateRelativeJsImportsOnRef.mockResolvedValue(undefined);
    mocks.closePRs.mockResolvedValue(undefined);
    mocks.commitWorkflows.mockResolvedValue(undefined);
    mocks.generateWorkflowYaml.mockReturnValue("chain-workflow");
    mocks.generateCloseOriginalWorkflowYaml.mockReturnValue("close-workflow");
  });

  it("空partを自動畳み込みし、有効PRを再採番してチェーンを維持する", async () => {
    const proposal: SplitProposal = {
      parts: [
        {
          order: 1,
          branchName: "feat/part-1",
          title: "feat: part 1",
          description: "part 1 description",
          files: ["a.ts"],
          rationale: "rationale 1",
        },
        {
          order: 2,
          branchName: "feat/part-2",
          title: "feat: part 2",
          description: "part 2 description",
          files: ["b.ts"],
          rationale: "rationale 2",
        },
        {
          order: 3,
          branchName: "feat/part-3",
          title: "feat: part 3",
          description: "part 3 description",
          files: ["c.ts"],
          rationale: "rationale 3",
        },
      ],
    };

    const files: DiffFile[] = [
      { filename: "a.ts", patch: "", status: "modified" },
      { filename: "b.ts", patch: "", status: "modified" },
      { filename: "c.ts", patch: "", status: "modified" },
    ];

    mocks.getBranchSha.mockImplementation(
      async (_owner: string, _repo: string, branchName: string) => {
        if (branchName === "main") return "sha-main";
        if (branchName === "feat/part-1") return "sha-part-1-head";
        if (branchName === "feat/part-3") return "sha-part-3-head";
        return "sha-unknown";
      }
    );

    mocks.commitFilesToBranch
      .mockResolvedValueOnce("sha-part-1-initial")
      .mockResolvedValueOnce("sha-part-1-repair")
      .mockResolvedValueOnce("sha-part-3-initial");

    mocks.waitForBuildAndTest
      .mockResolvedValueOnce({
        success: false,
        summary: "build failed at step Build",
        runUrl: "https://example.com/run/1",
      })
      .mockResolvedValueOnce({
        success: true,
        summary: "ok",
        runUrl: "https://example.com/run/2",
      })
      .mockResolvedValueOnce({
        success: true,
        summary: "ok",
        runUrl: "https://example.com/run/3",
      });

    mocks.suggestFilesForBuildRepair.mockResolvedValue(["b.ts"]);

    mocks.createDraftPR
      .mockResolvedValueOnce({
        number: 101,
        title: "[1/3] feat: part 1",
        htmlUrl: "https://example.com/pr/101",
        branchName: "feat/part-1",
      })
      .mockResolvedValueOnce({
        number: 103,
        title: "[3/3] feat: part 3",
        htmlUrl: "https://example.com/pr/103",
        branchName: "feat/part-3",
      });

    const progressMessages: string[] = [];
    const created = await executeSplit(
      "claude",
      proposal,
      "acme",
      "repo",
      20,
      "feature/original",
      "main",
      files,
      {
        onProgress: (message) => {
          progressMessages.push(message);
        },
        onProposal: vi.fn(),
        onPRCreated: vi.fn(),
        onError: vi.fn(),
      }
    );

    expect(created).toHaveLength(2);
    expect(created.map((pr) => pr.title)).toEqual([
      "[1/2] feat: part 1",
      "[2/2] feat: part 3",
    ]);

    expect(mocks.createDraftPR).toHaveBeenNthCalledWith(
      1,
      "acme",
      "repo",
      "[1/3] feat: part 1",
      expect.stringContaining("| Review order | 1 / 3 |"),
      "feat/part-1",
      "main"
    );
    expect(mocks.createDraftPR).toHaveBeenNthCalledWith(
      2,
      "acme",
      "repo",
      "[3/3] feat: part 3",
      expect.stringContaining("| Review order | 3 / 3 |"),
      "feat/part-3",
      "feat/part-1"
    );

    expect(mocks.updatePRMetadata).toHaveBeenCalledTimes(2);
    expect(mocks.updatePRMetadata).toHaveBeenNthCalledWith(
      1,
      "acme",
      "repo",
      101,
      "[1/2] feat: part 1",
      expect.stringContaining("| Review order | 1 / 2 |")
    );
    expect(mocks.updatePRMetadata).toHaveBeenNthCalledWith(
      2,
      "acme",
      "repo",
      103,
      "[2/2] feat: part 3",
      expect.stringContaining("| Review order | 2 / 2 |")
    );

    expect(progressMessages.some((msg) => msg.includes('Auto-collapsed "feat/part-2"'))).toBe(
      true
    );
    expect(progressMessages.some((msg) => msg.includes("Auto-collapsed 1 empty part(s)"))).toBe(
      true
    );

    expect(mocks.commitWorkflows).toHaveBeenCalledWith(
      "acme",
      "repo",
      "feat/part-1",
      expect.any(Array)
    );
  });

  it("precheckで不足依存が見つかったら候補partから自動前倒しして継続する", async () => {
    const proposal: SplitProposal = {
      parts: [
        {
          order: 1,
          branchName: "feat/part-1",
          title: "feat: part 1",
          description: "part 1 description",
          files: ["a.ts"],
          rationale: "rationale 1",
        },
        {
          order: 2,
          branchName: "feat/part-2",
          title: "feat: part 2",
          description: "part 2 description",
          files: ["src/core/orchestrator.ts", "src/github/actions.ts"],
          rationale: "rationale 2",
        },
      ],
    };

    const files: DiffFile[] = [
      { filename: "a.ts", patch: "", status: "modified" },
      { filename: "src/core/orchestrator.ts", patch: "", status: "modified" },
      { filename: "src/github/actions.ts", patch: "", status: "modified" },
    ];

    mocks.getBranchSha.mockResolvedValue("sha-main");
    mocks.commitFilesToBranch
      .mockResolvedValueOnce("sha-part-1-initial")
      .mockResolvedValueOnce("sha-part-1-repair")
      .mockResolvedValueOnce("sha-part-1-precheck-auto-move");

    mocks.waitForBuildAndTest
      .mockResolvedValueOnce({
        success: false,
        summary: "build failed",
        runUrl: "https://example.com/run/1",
      })
      .mockResolvedValueOnce({
        success: true,
        summary: "ok",
        runUrl: "https://example.com/run/2",
      });

    mocks.suggestFilesForBuildRepair.mockResolvedValue([
      "src/core/orchestrator.ts",
    ]);

    mocks.validateRelativeJsImportsOnRef
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new Error(
          'Build precheck failed: "src/core/orchestrator.ts" imports "../github/actions.js", but no matching source file exists on "feat/part-1".'
        )
      )
      .mockResolvedValueOnce(undefined);

    mocks.createDraftPR.mockResolvedValueOnce({
      number: 110,
      title: "[1/2] feat: part 1",
      htmlUrl: "https://example.com/pr/110",
      branchName: "feat/part-1",
    });

    const progressMessages: string[] = [];
    const created = await executeSplit(
      "claude",
      proposal,
      "acme",
      "repo",
      20,
      "feature/original",
      "main",
      files,
      {
        onProgress: (message) => {
          progressMessages.push(message);
        },
        onProposal: vi.fn(),
        onPRCreated: vi.fn(),
        onError: vi.fn(),
      }
    );

    expect(created).toHaveLength(1);
    expect(created[0].title).toBe("[1/1] feat: part 1");
    expect(mocks.commitFilesToBranch).toHaveBeenCalledTimes(3);
    expect(mocks.commitFilesToBranch).toHaveBeenNthCalledWith(
      3,
      "acme",
      "repo",
      "feat/part-1",
      [expect.objectContaining({ filename: "src/github/actions.ts" })],
      "fix: include dependency files for precheck",
      "sha-main",
      "feature/original"
    );
    expect(
      progressMessages.some((message) =>
        message.includes("Auto-repairing precheck by moving dependency files")
      )
    ).toBe(true);
  });

  it("build失敗アノテーションの対象ファイルをAI前に自動前倒しできる", async () => {
    const proposal: SplitProposal = {
      parts: [
        {
          order: 1,
          branchName: "feat/part-1",
          title: "feat: part 1",
          description: "part 1 description",
          files: ["dist/utils/diff.js"],
          rationale: "rationale 1",
        },
        {
          order: 2,
          branchName: "feat/part-2",
          title: "feat: part 2",
          description: "part 2 description",
          files: ["src/cli/index.ts"],
          rationale: "rationale 2",
        },
      ],
    };

    const files: DiffFile[] = [
      { filename: "dist/utils/diff.js", patch: "", status: "removed" },
      { filename: "src/cli/index.ts", patch: "", status: "modified" },
    ];

    mocks.getBranchSha.mockResolvedValue("sha-main");
    mocks.commitFilesToBranch
      .mockResolvedValueOnce("sha-part-1-initial")
      .mockResolvedValueOnce("sha-part-1-auto-move");

    mocks.waitForBuildAndTest
      .mockResolvedValueOnce({
        success: false,
        summary:
          'build-and-test failed (conclusion: failure).\nFailure annotations:\n- src/cli/index.ts:114 Expected 9 arguments, but got 8.',
        runUrl: "https://example.com/run/1",
      })
      .mockResolvedValueOnce({
        success: true,
        summary: "ok",
        runUrl: "https://example.com/run/2",
      });

    mocks.createDraftPR.mockResolvedValueOnce({
      number: 120,
      title: "[1/2] feat: part 1",
      htmlUrl: "https://example.com/pr/120",
      branchName: "feat/part-1",
    });

    const progressMessages: string[] = [];
    const created = await executeSplit(
      "claude",
      proposal,
      "acme",
      "repo",
      20,
      "feature/original",
      "main",
      files,
      {
        onProgress: (message) => {
          progressMessages.push(message);
        },
        onProposal: vi.fn(),
        onPRCreated: vi.fn(),
        onError: vi.fn(),
      }
    );

    expect(created).toHaveLength(1);
    expect(mocks.suggestFilesForBuildRepair).not.toHaveBeenCalled();
    expect(mocks.commitFilesToBranch).toHaveBeenCalledTimes(2);
    expect(mocks.commitFilesToBranch).toHaveBeenNthCalledWith(
      2,
      "acme",
      "repo",
      "feat/part-1",
      [expect.objectContaining({ filename: "src/cli/index.ts" })],
      "fix: include files referenced by failure annotations",
      "sha-main",
      "feature/original"
    );
    expect(
      progressMessages.some((message) =>
        message.includes("Auto-repairing build-and-test by moving failure-annotated files")
      )
    ).toBe(true);
  });
});
