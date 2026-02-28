import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffFile } from "../src/utils/diff.js";

const mockOctokit = {
  rest: {
    repos: {
      getContent: vi.fn(),
    },
    git: {
      createBlob: vi.fn(),
      createTree: vi.fn(),
      createCommit: vi.fn(),
      updateRef: vi.fn(),
    },
  },
};

vi.mock("../src/github/client.js", () => ({
  getOctokit: () => mockOctokit,
}));

import { commitFilesToBranch } from "../src/github/branch.js";

describe("commitFilesToBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOctokit.rest.git.createTree.mockResolvedValue({ data: { sha: "tree-sha" } });
    mockOctokit.rest.git.createCommit.mockResolvedValue({
      data: { sha: "commit-sha" },
    });
    mockOctokit.rest.git.updateRef.mockResolvedValue({});
    mockOctokit.rest.git.createBlob.mockResolvedValue({
      data: { sha: "blob-sha" },
    });
  });

  it("renamedファイルを旧パス削除 + 新パス追加としてコミットする", async () => {
    mockOctokit.rest.repos.getContent.mockResolvedValue({
      data: {
        type: "file",
        content: "bmV3LWNvbnRlbnQ=",
      },
    });

    const files: DiffFile[] = [
      {
        filename: "src/new-name.ts",
        previousFilename: "src/old-name.ts",
        patch: "",
        status: "renamed",
      },
    ];

    await commitFilesToBranch(
      "acme",
      "repo",
      "feat/part-1",
      files,
      "feat: rename file",
      "base-sha",
      "feature/source"
    );

    expect(mockOctokit.rest.git.createTree).toHaveBeenCalledWith(
      expect.objectContaining({
        tree: [
          {
            path: "src/old-name.ts",
            mode: "100644",
            type: "blob",
            sha: null,
          },
          {
            path: "src/new-name.ts",
            mode: "100644",
            type: "blob",
            sha: "blob-sha",
          },
        ],
      })
    );
  });

  it("バイナリ内容をbase64のままblob化して破損を防ぐ", async () => {
    const binaryBase64 = "AAEC/w==";
    mockOctokit.rest.repos.getContent.mockResolvedValue({
      data: {
        type: "file",
        content: binaryBase64,
      },
    });

    const files: DiffFile[] = [
      { filename: "assets/icon.bin", patch: "", status: "modified" },
    ];

    await commitFilesToBranch(
      "acme",
      "repo",
      "feat/part-2",
      files,
      "feat: add binary",
      "base-sha",
      "feature/source"
    );

    expect(mockOctokit.rest.git.createBlob).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
      content: binaryBase64,
      encoding: "base64",
    });
  });

  it("sourceRef からの取得失敗時はスキップせずに失敗させる", async () => {
    mockOctokit.rest.repos.getContent.mockRejectedValue(new Error("Not Found"));

    const files: DiffFile[] = [
      { filename: "src/missing.ts", patch: "", status: "modified" },
    ];

    await expect(
      commitFilesToBranch(
        "acme",
        "repo",
        "feat/part-3",
        files,
        "feat: missing file",
        "base-sha",
        "feature/source"
      )
    ).rejects.toThrow('Failed to fetch "src/missing.ts" from "feature/source"');

    expect(mockOctokit.rest.git.createTree).not.toHaveBeenCalled();
  });
});
