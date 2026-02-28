/**
 * ブランチ操作
 */

import path from "node:path";
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
  const maxRetries = 20;

  for (let suffix = 0; suffix <= maxRetries; suffix++) {
    const candidateBranchName =
      suffix === 0 ? branchName : `${branchName}-${suffix}`;

    try {
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${candidateBranchName}`,
        sha: baseSha,
      });
      return candidateBranchName;
    } catch (error) {
      if (isReferenceAlreadyExistsError(error) && suffix < maxRetries) {
        continue;
      }

      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to create branch "${candidateBranchName}". (${reason})`
      );
    }
  }

  throw new Error(
    `Failed to create a unique branch name from "${branchName}" after ${maxRetries + 1} attempts.`
  );
}

function isReferenceAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const status = "status" in error ? error.status : undefined;
  const message = "message" in error ? error.message : undefined;

  return (
    status === 422 &&
    typeof message === "string" &&
    message.toLowerCase().includes("reference already exists")
  );
}

/**
 * 指定ref上で、変更対象TSファイルの相対.js import が解決できるか検証する
 * PR作成前に、分割順やブランチ基準の不整合を早期検出するために使う
 */
export async function validateRelativeJsImportsOnRef(
  owner: string,
  repo: string,
  ref: string,
  filePaths: string[]
): Promise<void> {
  const octokit = getOctokit();
  const targets = filePaths.filter(
    (filePath) => filePath.endsWith(".ts") || filePath.endsWith(".tsx")
  );

  for (const filePath of targets) {
    const content = await readUtf8FileFromRef(owner, repo, ref, filePath);
    const importSpecifiers = extractRelativeImportSpecifiers(content);

    for (const specifier of importSpecifiers) {
      if (!specifier.endsWith(".js")) {
        continue;
      }

      const expectedTsPath = toRepoPath(
        path.posix.join(path.posix.dirname(filePath), specifier)
      ).replace(/\.js$/, ".ts");
      const expectedTsxPath = expectedTsPath.replace(/\.ts$/, ".tsx");
      const expectedIndexTsPath = expectedTsPath.replace(/\.ts$/, "/index.ts");
      const expectedIndexTsxPath = expectedTsPath.replace(
        /\.ts$/,
        "/index.tsx"
      );

      const exists = await fileExistsOnRef(
        owner,
        repo,
        ref,
        expectedTsPath,
        expectedTsxPath,
        expectedIndexTsPath,
        expectedIndexTsxPath
      );

      if (!exists) {
        throw new Error(
          `Build precheck failed: "${filePath}" imports "${specifier}", but no matching source file exists on "${ref}".`
        );
      }
    }
  }

  async function readUtf8FileFromRef(
    ownerArg: string,
    repoArg: string,
    refArg: string,
    filePathArg: string
  ): Promise<string> {
    let data: Awaited<ReturnType<typeof octokit.rest.repos.getContent>>["data"];
    try {
      const response = await octokit.rest.repos.getContent({
        owner: ownerArg,
        repo: repoArg,
        path: filePathArg,
        ref: refArg,
      });
      data = response.data;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Build precheck failed: unable to read "${filePathArg}" on "${refArg}". (${reason})`
      );
    }

    if (!("content" in data) || data.type !== "file") {
      throw new Error(
        `Build precheck failed: expected "${filePathArg}" on "${refArg}" to be a file.`
      );
    }

    return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString(
      "utf-8"
    );
  }

  async function fileExistsOnRef(
    ownerArg: string,
    repoArg: string,
    refArg: string,
    ...candidatePaths: string[]
  ): Promise<boolean> {
    for (const candidatePath of candidatePaths) {
      try {
        const response = await octokit.rest.repos.getContent({
          owner: ownerArg,
          repo: repoArg,
          path: candidatePath,
          ref: refArg,
        });
        const data = response.data;
        if (!Array.isArray(data) && data.type === "file") {
          return true;
        }
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "status" in error &&
          error.status === 404
        ) {
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Build precheck failed while checking "${candidatePath}" on "${refArg}". (${reason})`
        );
      }
    }
    return false;
  }
}

function extractRelativeImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const importPattern =
    /^\s*(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["'](\.[^"']+)["']/gm;

  let match: RegExpExecArray | null = null;
  while ((match = importPattern.exec(content)) !== null) {
    specifiers.push(match[1]);
  }

  return specifiers;
}

function toRepoPath(candidatePath: string): string {
  return path.posix.normalize(candidatePath).replace(/^\.?\//, "");
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
  const { data } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  return data.object.sha;
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

  // Treeを作成
  const { data: tree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseSha,
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
