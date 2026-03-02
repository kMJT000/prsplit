import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SplitProposal } from "../../src/ai/prompt.js";
import type { DiffFile } from "../../src/utils/diff.js";

const {
  mockGetAIClient,
  mockGenerateSplitProposal,
  mockValidateProposal,
  mockParsePRIdentifier,
  mockGetRepoFromRemote,
  mockGetPRInfo,
  mockGetPRFiles,
  mockCreateDraftPR,
  mockClosePRs,
  mockCreateBranch,
  mockGetBranchSha,
  mockCommitFilesToBranch,
  mockValidateRelativeJsImportsOnRef,
  mockGenerateWorkflowYaml,
  mockGenerateCloseOriginalWorkflowYaml,
  mockCommitWorkflows,
} = vi.hoisted(() => ({
  mockGetAIClient: vi.fn(),
  mockGenerateSplitProposal: vi.fn(),
  mockValidateProposal: vi.fn(),
  mockParsePRIdentifier: vi.fn(),
  mockGetRepoFromRemote: vi.fn(),
  mockGetPRInfo: vi.fn(),
  mockGetPRFiles: vi.fn(),
  mockCreateDraftPR: vi.fn(),
  mockClosePRs: vi.fn(),
  mockCreateBranch: vi.fn(),
  mockGetBranchSha: vi.fn(),
  mockCommitFilesToBranch: vi.fn(),
  mockValidateRelativeJsImportsOnRef: vi.fn(),
  mockGenerateWorkflowYaml: vi.fn(),
  mockGenerateCloseOriginalWorkflowYaml: vi.fn(),
  mockCommitWorkflows: vi.fn(),
}));

vi.mock("../../src/ai/client.js", () => ({
  getAIClient: mockGetAIClient,
}));

vi.mock("../../src/ai/splitter.js", () => ({
  generateSplitProposal: mockGenerateSplitProposal,
  validateProposal: mockValidateProposal,
}));

vi.mock("../../src/github/client.js", () => ({
  parsePRIdentifier: mockParsePRIdentifier,
  getRepoFromRemote: mockGetRepoFromRemote,
}));

vi.mock("../../src/github/pr.js", () => ({
  getPRInfo: mockGetPRInfo,
  getPRFiles: mockGetPRFiles,
  createDraftPR: mockCreateDraftPR,
  closePRs: mockClosePRs,
}));

vi.mock("../../src/github/branch.js", () => ({
  createBranch: mockCreateBranch,
  getBranchSha: mockGetBranchSha,
  commitFilesToBranch: mockCommitFilesToBranch,
  validateRelativeJsImportsOnRef: mockValidateRelativeJsImportsOnRef,
}));

vi.mock("../../src/github/workflow.js", () => ({
  generateWorkflowYaml: mockGenerateWorkflowYaml,
  generateCloseOriginalWorkflowYaml: mockGenerateCloseOriginalWorkflowYaml,
  commitWorkflows: mockCommitWorkflows,
}));

import { executeSplit, generateProposal } from "../../src/core/orchestrator.js";

function createCallbacks() {
  return {
    onProgress: vi.fn(),
    onProposal: vi.fn(),
    onPRCreated: vi.fn(),
    onError: vi.fn(),
  };
}

describe("generateProposal (integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closed PR の場合は提案生成を中断し onError を呼ぶ", async () => {
    mockParsePRIdentifier.mockReturnValue({ owner: "", repo: "", number: 123 });
    mockGetRepoFromRemote.mockResolvedValue({ owner: "acme", repo: "repo" });
    mockGetPRInfo.mockResolvedValue({
      number: 123,
      title: "Sample",
      body: null,
      head: "feature/x",
      base: "main",
      state: "closed",
      htmlUrl: "https://example.com/pr/123",
    });

    const callbacks = createCallbacks();
    const result = await generateProposal(
      {
        prIdentifier: "123",
        model: "claude",
        dryRun: true,
      },
      callbacks
    );

    expect(result).toBeNull();
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(mockGetAIClient).not.toHaveBeenCalled();
  });

  it("分割案バリデーション失敗時は null を返す", async () => {
    const files: DiffFile[] = [
      { filename: "src/a.ts", patch: "+a", status: "modified" },
      { filename: "src/b.ts", patch: "+b", status: "modified" },
    ];
    const proposal: SplitProposal = {
      parts: [
        {
          order: 1,
          branchName: "feat/one",
          title: "feat: one",
          description: "desc",
          files: ["src/a.ts"],
          rationale: "reason",
        },
      ],
    };

    mockParsePRIdentifier.mockReturnValue({ owner: "acme", repo: "repo", number: 1 });
    mockGetPRInfo.mockResolvedValue({
      number: 1,
      title: "Sample",
      body: null,
      head: "feature/head",
      base: "main",
      state: "open",
      htmlUrl: "https://example.com/pr/1",
    });
    mockGetPRFiles.mockResolvedValue(
      files.map((file) => ({
        filename: file.filename,
        status: file.status,
        patch: file.patch,
        additions: 1,
        deletions: 0,
      }))
    );
    mockGetAIClient.mockResolvedValue({ complete: vi.fn() });
    mockGenerateSplitProposal.mockResolvedValue(proposal);
    mockValidateProposal.mockReturnValue({
      valid: false,
      errors: ['File "src/b.ts" is missing from the split proposal.'],
    });

    const callbacks = createCallbacks();
    const result = await generateProposal(
      {
        prIdentifier: "https://github.com/acme/repo/pull/1",
        model: "claude",
        dryRun: true,
      },
      callbacks
    );

    expect(result).toBeNull();
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(callbacks.onProposal).not.toHaveBeenCalled();
  });
});

describe("executeSplit (integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBranchSha.mockResolvedValue("base-sha");
    mockCreateBranch
      .mockResolvedValueOnce("feat/part-1")
      .mockResolvedValueOnce("feat/part-2");
    mockValidateRelativeJsImportsOnRef.mockResolvedValue(undefined);
    mockGenerateWorkflowYaml.mockReturnValue("workflow");
    mockGenerateCloseOriginalWorkflowYaml.mockReturnValue("close-workflow");
  });

  it("途中失敗時は作成済みPRをクリーンアップする", async () => {
    const files: DiffFile[] = [
      { filename: "src/a.ts", patch: "+a", status: "modified" },
      { filename: "src/b.ts", patch: "+b", status: "modified" },
    ];
    const proposal: SplitProposal = {
      parts: [
        {
          order: 1,
          branchName: "feat/part-1",
          title: "feat: part one",
          description: "desc-1",
          files: ["src/a.ts"],
          rationale: "reason-1",
        },
        {
          order: 2,
          branchName: "feat/part-2",
          title: "feat: part two",
          description: "desc-2",
          files: ["src/b.ts"],
          rationale: "reason-2",
        },
      ],
    };

    mockCommitFilesToBranch
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("failed to commit second part"));
    mockCreateDraftPR.mockResolvedValue({
      number: 101,
      title: "PR 1",
      htmlUrl: "https://example.com/pr/101",
      branchName: "feat/part-1",
    });

    const callbacks = createCallbacks();
    await expect(
      executeSplit(
        proposal,
        "acme",
        "repo",
        10,
        "Original title",
        "feature/original",
        "main",
        files,
        callbacks
      )
    ).rejects.toThrow("failed to commit second part");

    expect(mockClosePRs).toHaveBeenCalledTimes(1);
    expect(mockClosePRs).toHaveBeenCalledWith("acme", "repo", [
      {
        number: 101,
        title: "PR 1",
        htmlUrl: "https://example.com/pr/101",
        branchName: "feat/part-1",
      },
    ]);
  });
});
