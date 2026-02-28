/**
 * Octokit初期化・共通処理
 */

import { Octokit } from "octokit";

let octokitInstance: Octokit | null = null;

export function getOctokit(): Octokit {
  if (octokitInstance) return octokitInstance;

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not set.\n" +
        "Set it with: export GITHUB_TOKEN=ghp_xxxxx"
    );
  }

  octokitInstance = new Octokit({ auth: token });
  return octokitInstance;
}

/**
 * PR URLまたは番号からowner/repo/numberを取得
 */
export function parsePRIdentifier(input: string): {
  owner: string;
  repo: string;
  number: number;
} {
  // URL形式: https://github.com/owner/repo/pull/123
  const urlMatch = input.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      number: parseInt(urlMatch[3], 10),
    };
  }

  // 番号のみの場合、git remoteから取得
  const num = parseInt(input, 10);
  if (!isNaN(num)) {
    return { owner: "", repo: "", number: num };
  }

  throw new Error(
    `Invalid PR identifier: ${input}\n` +
      "Specify a PR number or a URL like https://github.com/owner/repo/pull/123."
  );
}

/**
 * git remoteからowner/repoを取得
 */
export async function getRepoFromRemote(): Promise<{
  owner: string;
  repo: string;
}> {
  const { execSync } = await import("child_process");
  try {
    const remote = execSync("git remote get-url origin", {
      encoding: "utf-8",
    }).trim();

    // SSH: git@github.com:owner/repo.git
    const sshMatch = remote.match(/git@github\.com:([^/]+)\/([^/.]+)/);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }

    // HTTPS: https://github.com/owner/repo.git
    const httpsMatch = remote.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }

    throw new Error("Only GitHub remotes are supported.");
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Only GitHub remotes")) throw e;
    throw new Error(
      "Failed to read repository information from git remote.\n" +
        "Please pass the full PR URL."
    );
  }
}
