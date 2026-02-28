import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOctokit = {
  rest: {
    actions: {
      listWorkflowRunsForRepo: vi.fn(),
      getWorkflowRun: vi.fn(),
      listJobsForWorkflowRun: vi.fn(),
    },
    checks: {
      listForRef: vi.fn(),
      listAnnotations: vi.fn(),
    },
  },
};

vi.mock("../src/github/client.js", () => ({
  getOctokit: () => mockOctokit,
}));

import { waitForBuildAndTest } from "../src/github/actions.js";

describe("waitForBuildAndTest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("成功したCI実行を検知してsuccessを返す", async () => {
    mockOctokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 100,
            name: "CI",
            head_sha: "abc123",
            html_url: "https://example.com/run/100",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    });

    const result = await waitForBuildAndTest("acme", "repo", {
      branchName: "feat/part-1",
      commitSha: "abc123",
      timeoutMs: 1000,
      pollIntervalMs: 1,
    });

    expect(result.success).toBe(true);
    expect(result.summary).toBe("build-and-test passed.");
  });

  it("失敗時はjob/stepに加えてannotation情報を要約に含める", async () => {
    mockOctokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 200,
            name: "CI",
            head_sha: "def456",
            html_url: "https://example.com/run/200",
            status: "completed",
            conclusion: "failure",
          },
        ],
      },
    });

    mockOctokit.rest.actions.listJobsForWorkflowRun.mockResolvedValue({
      data: {
        jobs: [
          {
            name: "build-and-test",
            conclusion: "failure",
            steps: [{ name: "Build", conclusion: "failure" }],
          },
        ],
      },
    });

    mockOctokit.rest.checks.listForRef.mockResolvedValue({
      data: {
        check_runs: [{ id: 999, conclusion: "failure" }],
      },
    });

    mockOctokit.rest.checks.listAnnotations.mockResolvedValue({
      data: [
        {
          path: "src/core/orchestrator.ts",
          start_line: 292,
          end_line: 292,
          annotation_level: "failure",
          message:
            "Argument of type '{ watchPRNumber: number; nextPRNumber: number; name: string; }' is not assignable.",
        },
      ],
    });

    const result = await waitForBuildAndTest("acme", "repo", {
      branchName: "feat/part-1",
      commitSha: "def456",
      timeoutMs: 1000,
      pollIntervalMs: 1,
    });

    expect(result.success).toBe(false);
    expect(result.summary).toContain('Job "build-and-test" failed');
    expect(result.summary).toContain('Step "Build" failed');
    expect(result.summary).toContain("Failure annotations:");
    expect(result.summary).toContain("src/core/orchestrator.ts:292");
  });

  it("annotation取得に失敗してもjob/step要約で継続する", async () => {
    mockOctokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 201,
            name: "CI",
            head_sha: "ghi789",
            html_url: "https://example.com/run/201",
            status: "completed",
            conclusion: "failure",
          },
        ],
      },
    });

    mockOctokit.rest.actions.listJobsForWorkflowRun.mockResolvedValue({
      data: {
        jobs: [
          {
            name: "build-and-test",
            conclusion: "failure",
            steps: [{ name: "Build", conclusion: "failure" }],
          },
        ],
      },
    });

    mockOctokit.rest.checks.listForRef.mockRejectedValue(new Error("forbidden"));

    const result = await waitForBuildAndTest("acme", "repo", {
      branchName: "feat/part-1",
      commitSha: "ghi789",
      timeoutMs: 1000,
      pollIntervalMs: 1,
    });

    expect(result.success).toBe(false);
    expect(result.summary).toContain('Job "build-and-test" failed');
    expect(result.summary).not.toContain("Failure annotations:");
  });
});
