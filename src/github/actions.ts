/**
 * GitHub Actions 実行監視
 */

import { getOctokit } from "./client.js";

export interface BuildAndTestResult {
  success: boolean;
  summary: string;
  runUrl: string;
}

interface WaitForBuildAndTestOptions {
  branchName: string;
  commitSha: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  workflowName?: string;
}

/**
 * 指定コミットに紐づく build-and-test（CI）実行完了を待機する
 */
export async function waitForBuildAndTest(
  owner: string,
  repo: string,
  options: WaitForBuildAndTestOptions
): Promise<BuildAndTestResult> {
  const octokit = getOctokit();
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const workflowName = options.workflowName ?? "CI";
  const deadline = Date.now() + timeoutMs;

  let runId: number | null = null;
  let runUrl = "";

  while (Date.now() < deadline) {
    if (runId === null) {
      const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        branch: options.branchName,
        event: "push",
        per_page: 100,
      });

      const run = data.workflow_runs.find(
        (candidate) =>
          candidate.head_sha === options.commitSha &&
          candidate.name === workflowName
      );

      if (run) {
        runId = run.id;
        runUrl = run.html_url;

        if (run.status === "completed") {
          return buildResult(owner, repo, runId, run.conclusion, runUrl);
        }
      }
    } else {
      const { data: run } = await octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: runId,
      });

      if (run.status === "completed") {
        return buildResult(owner, repo, runId, run.conclusion, runUrl);
      }
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for workflow "${workflowName}" on branch "${options.branchName}" (commit: ${options.commitSha}).`
  );
}

async function buildResult(
  owner: string,
  repo: string,
  runId: number,
  conclusion: string | null,
  runUrl: string
): Promise<BuildAndTestResult> {
  if (conclusion === "success") {
    return {
      success: true,
      summary: "build-and-test passed.",
      runUrl,
    };
  }

  const summary = await getFailureSummary(owner, repo, runId, conclusion);
  return {
    success: false,
    summary,
    runUrl,
  };
}

async function getFailureSummary(
  owner: string,
  repo: string,
  runId: number,
  conclusion: string | null
): Promise<string> {
  const octokit = getOctokit();
  const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: runId,
    per_page: 100,
  });

  const failedJobs = data.jobs.filter(
    (job) =>
      job.conclusion === "failure" ||
      job.conclusion === "cancelled" ||
      job.conclusion === "timed_out"
  );

  if (failedJobs.length === 0) {
    return `build-and-test failed (conclusion: ${conclusion ?? "unknown"}).`;
  }

  const lines: string[] = [
    `build-and-test failed (conclusion: ${conclusion ?? "unknown"}).`,
  ];

  for (const job of failedJobs) {
    lines.push(`- Job "${job.name}" failed (${job.conclusion ?? "unknown"}).`);

    const failedSteps = (job.steps ?? []).filter(
      (step) => step.conclusion === "failure"
    );
    for (const step of failedSteps) {
      lines.push(`  - Step "${step.name}" failed.`);
    }
  }

  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
