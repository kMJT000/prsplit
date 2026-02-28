/**
 * ブランチ操作
 */

import { getOctokit } from "./client.js";
import type { DiffFile } from "../utils/diff.js";

/**
 * ブランチを作成する（指定のベースブランチから）
 */
export async function createBranch(
  owner: string,
  repo: string,
  branchName: string,
  baseSha: string
): Promise<string> {
  const octokit = getOctokit();
  const maxRetry = 20;
  let attempt = 0;
  let candidate = branchName;

  while (attempt <= maxRetry) {
    try {
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${candidate}`,
        sha: baseSha,
      });
      return candidate;
    } catch (error) {
      if (!isReferenceAlreadyExistsError(error)) {
        throw error;
      }

      attempt += 1;
      if (attempt > maxRetry) {
        throw new Error(
          `Failed to create a unique branch from "${branchName}" after ${maxRetry} retries.`
        );
      }
      candidate = `${branchName}-${attempt}`;
    }
  }

  throw new Error(`Failed to create branch "${branchName}".`);
}

/**
 * ブランチを削除する
 */
export async function deleteBranch(
  owner: string,
  repo: string,
  branchName: string
): Promise<void> {
  const octokit = getOctokit();
  try {
    await octokit.rest.git.deleteRef({
      owner,
      repo,
      ref: `heads/${branchName}`,
    });
  } catch {
    // ブランチが存在しない場合は無視
  }
}

/**
 * 指定ブランチのHEAD SHAを取得する
 */
export async function getBranchSha(
  owner: string,
  repo: string,
  branch: string
): Promise<string> {
  const octokit = getOctokit();
  try {
    const { data } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    return data.object.sha;
  } catch (error) {
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : undefined;
    const reason = error instanceof Error ? error.message : String(error);

    if (status === 404) {
      throw new Error(
        `Base branch "${branch}" was not found in ${owner}/${repo}.\n` +
          `Create/push it first, or use an existing branch via --base.\n` +
          `Original error: ${reason}`
      );
    }

    throw new Error(
      `Failed to resolve branch "${branch}" in ${owner}/${repo}. (${reason})`
    );
  }
}

/**
 * ファイル変更をコミットする
 * diffの内容をTree APIで一括コミット
 */
export async function commitFilesToBranch(
  owner: string,
  repo: string,
  branchName: string,
  files: DiffFile[],
  commitMessage: string,
  baseSha: string,
  sourceRef: string
): Promise<string> {
  const octokit = getOctokit();

  // Tree blobsを作成
  const treeItems: Array<{
    path: string;
    mode: "100644";
    type: "blob";
    sha: string | null;
  }> = [];

  for (const file of files) {
    if (file.status === "removed") {
      // 削除ファイル: sha を null にして削除を表現
      treeItems.push({
        path: file.filename,
        mode: "100644",
        type: "blob",
        sha: null,
      });
      continue;
    }

    if (file.status === "renamed") {
      if (!file.previousFilename) {
        throw new Error(
          `Renamed file "${file.filename}" is missing previous filename metadata.`
        );
      }

      // rename は旧パス削除 + 新パス追加として表現する
      treeItems.push({
        path: file.previousFilename,
        mode: "100644",
        type: "blob",
        sha: null,
      });
    }

    const blobSha = await createBlobFromSourceRef(
      owner,
      repo,
      file.filename,
      sourceRef
    );
    treeItems.push({
      path: file.filename,
      mode: "100644",
      type: "blob",
      sha: blobSha,
    });
  }

  if (treeItems.length === 0) {
    return baseSha;
  }

  const { data: baseCommit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: baseSha,
  });

  // Treeを作成
  const { data: tree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree: treeItems,
  });

  // コミットを作成
  const { data: commit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: commitMessage,
    tree: tree.sha,
    parents: [baseSha],
  });

  // ブランチを更新
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branchName}`,
    sha: commit.sha,
  });

  return commit.sha;
}

/**
 * sourceRef上のファイル内容をblob化し、そのSHAを返す
 * base64のままblobを作ることでバイナリも破損させない
 */
async function createBlobFromSourceRef(
  owner: string,
  repo: string,
  path: string,
  sourceRef: string
): Promise<string> {
  const octokit = getOctokit();
  let data: Awaited<
    ReturnType<typeof octokit.rest.repos.getContent>
  >["data"];

  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: sourceRef,
    });
    data = response.data;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch "${path}" from "${sourceRef}". (${reason})`);
  }

  if (!("content" in data) || data.type !== "file") {
    throw new Error(
      `Expected "${path}" on "${sourceRef}" to be a file content response.`
    );
  }

  const normalizedBase64 = data.content.replace(/\n/g, "");
  if (!normalizedBase64) {
    throw new Error(`Received empty content for "${path}" on "${sourceRef}".`);
  }

  const { data: blob } = await octokit.rest.git.createBlob({
    owner,
    repo,
    content: normalizedBase64,
    encoding: "base64",
  });

  return blob.sha;
}

function isReferenceAlreadyExistsError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const maybeError = error as { status?: unknown; message?: unknown };
  if (maybeError.status !== 422 || typeof maybeError.message !== "string") {
    return false;
  }

  return maybeError.message.includes("Reference already exists");
}
