/**
 * PR作成・close・draft制御
 */

import { getOctokit } from "./client.js";

export interface PRInfo {
  number: number;
  title: string;
  body: string | null;
  head: string; // headブランチ名
  base: string; // baseブランチ名
  diff: string;
  state: string;
  htmlUrl: string;
}

export interface CreatedPR {
  number: number;
  title: string;
  htmlUrl: string;
  branchName: string;
}

/**
 * PRの情報を取得する
 */
export async function getPRInfo(
  owner: string,
  repo: string,
  prNumber: number
): Promise<PRInfo> {
  const octokit = getOctokit();

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  // diffを取得
  const { data: diff } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    head: pr.head.ref,
    base: pr.base.ref,
    diff: diff as unknown as string,
    state: pr.state,
    htmlUrl: pr.html_url,
  };
}

/**
 * PRのファイル一覧を取得する
 */
export async function getPRFiles(
  owner: string,
  repo: string,
  prNumber: number
): Promise<
  Array<{
    filename: string;
    status: string;
    patch: string;
    additions: number;
    deletions: number;
  }>
> {
  const octokit = getOctokit();
  const files: Array<{
    filename: string;
    status: string;
    patch: string;
    additions: number;
    deletions: number;
  }> = [];

  // ページネーション対応
  for await (const response of octokit.paginate.iterator(
    octokit.rest.pulls.listFiles,
    { owner, repo, pull_number: prNumber, per_page: 100 }
  )) {
    for (const file of response.data) {
      files.push({
        filename: file.filename,
        status: file.status,
        patch: file.patch ?? "",
        additions: file.additions,
        deletions: file.deletions,
      });
    }
  }

  return files;
}

/**
 * ドラフトPRを作成する
 */
export async function createDraftPR(
  owner: string,
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string
): Promise<CreatedPR> {
  const octokit = getOctokit();

  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    title,
    body,
    head,
    base,
    draft: true,
  });

  return {
    number: pr.number,
    title: pr.title,
    htmlUrl: pr.html_url,
    branchName: head,
  };
}

/**
 * PRをcloseする
 */
export async function closePR(
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  const octokit = getOctokit();
  await octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    state: "closed",
  });
}

/**
 * 複数のPRを削除（close + ブランチ削除）する
 */
export async function deletePRs(
  owner: string,
  repo: string,
  prs: CreatedPR[]
): Promise<void> {
  const octokit = getOctokit();

  for (const pr of prs) {
    try {
      await octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: pr.number,
        state: "closed",
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`Warning: Failed to close PR #${pr.number}. (${reason})`);
    }

    try {
      await octokit.rest.git.deleteRef({
        owner,
        repo,
        ref: `heads/${pr.branchName}`,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `Warning: Failed to delete branch "${pr.branchName}". (${reason})`
      );
    }
  }
}

/**
 * PRのdraft状態を解除する
 */
export async function markPRReady(
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  const octokit = getOctokit();

  // GraphQL APIを使用（REST APIではdraft解除不可）
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  await octokit.graphql(
    `
    mutation($pullRequestId: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
        pullRequest {
          isDraft
        }
      }
    }
  `,
    { pullRequestId: pr.node_id }
  );
}
