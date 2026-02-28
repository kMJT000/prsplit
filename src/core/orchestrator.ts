/**
 * 全体フローの制御
 * CLIから呼び出され、分割提案の生成 → PR作成 → ワークフロー生成を実行する
 */

import type { AIModel } from "../ai/client.js";
import type { SplitProposal } from "../ai/prompt.js";
import type { CreatedPR } from "../github/pr.js";
import type { DiffFile } from "../utils/diff.js";
import { getAIClient } from "../ai/client.js";
import { generateSplitProposal, validateProposal } from "../ai/splitter.js";
import {
  parsePRIdentifier,
  getRepoFromRemote,
} from "../github/client.js";
import { getPRInfo, getPRFiles, createDraftPR, deletePRs } from "../github/pr.js";
import {
  createBranch,
  getBranchSha,
  commitFilesToBranch,
} from "../github/branch.js";

export interface OrchestratorOptions {
  prIdentifier: string;
  model: AIModel;
  dryRun: boolean;
  additionalPrompt?: string;
}

export interface OrchestratorCallbacks {
  onProgress: (message: string) => void;
  onProposal: (proposal: SplitProposal) => void;
  onPRCreated: (prs: CreatedPR[]) => void;
  onError: (error: Error) => void;
}

/**
 * 分割提案を生成する（dry-runモードでも使う共通処理）
 */
export async function generateProposal(
  options: OrchestratorOptions,
  callbacks: OrchestratorCallbacks
): Promise<{
  proposal: SplitProposal;
  owner: string;
  repo: string;
  prNumber: number;
  originalPRTitle: string;
  headBranch: string;
  baseBranch: string;
  files: DiffFile[];
} | null> {
  const { prIdentifier, model, additionalPrompt } = options;

  // 1. PR情報を解析
  let { owner, repo, number: prNumber } = parsePRIdentifier(prIdentifier);

  if (!owner || !repo) {
    callbacks.onProgress("Reading repository info from git remote...");
    const remote = await getRepoFromRemote();
    owner = remote.owner;
    repo = remote.repo;
  }

  // 2. PR情報を取得
  callbacks.onProgress(`Fetching PR #${prNumber}...`);
  const prInfo = await getPRInfo(owner, repo, prNumber);

  if (prInfo.state !== "open") {
    callbacks.onError(new Error(`PR #${prNumber} is not open (state: ${prInfo.state}).`));
    return null;
  }

  // 3. ファイル一覧を取得
  callbacks.onProgress("Fetching changed files...");
  const prFiles = await getPRFiles(owner, repo, prNumber);

  const diffFiles: DiffFile[] = prFiles.map((f) => ({
    filename: f.filename,
    patch: f.patch,
    status: f.status,
    previousFilename: f.previousFilename,
  }));

  callbacks.onProgress(`Detected changes in ${diffFiles.length} files.`);

  // 4. AIクライアントを初期化
  callbacks.onProgress(`Initializing AI model (${model})...`);
  const aiClient = await getAIClient(model);

  // 5. 分割提案を生成
  const proposal = await generateSplitProposal(
    aiClient,
    {
      prTitle: prInfo.title,
      prBody: prInfo.body,
      files: diffFiles,
      additionalInstruction: additionalPrompt,
    },
    callbacks.onProgress
  );

  // 6. バリデーション
  const validation = validateProposal(proposal, diffFiles);
  if (!validation.valid) {
    callbacks.onError(
      new Error(
        `Split proposal validation failed:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`
      )
    );
    return null;
  }

  // 順序でソート
  proposal.parts.sort((a, b) => a.order - b.order);
  callbacks.onProposal(proposal);

  return {
    proposal,
    owner,
    repo,
    prNumber,
    originalPRTitle: prInfo.title,
    headBranch: prInfo.head,
    baseBranch: prInfo.base,
    files: diffFiles,
  };
}

/**
 * 分割提案をもとにPRを作成する
 */
export async function executeSplit(
  proposal: SplitProposal,
  owner: string,
  repo: string,
  originalPRNumber: number,
  originalPRTitle: string,
  model: AIModel,
  headBranch: string,
  baseBranch: string,
  files: DiffFile[],
  callbacks: OrchestratorCallbacks
): Promise<CreatedPR[]> {
  const createdPRs: CreatedPR[] = [];
  const fileMap = new Map(files.map((f) => [f.filename, f]));
  const aiClient = await getAIClient(model);

  try {
    let previousBranch = baseBranch;

    for (const part of proposal.parts) {
      callbacks.onProgress(
        `[${part.order}/${proposal.parts.length}] Creating branch "${part.branchName}"...`
      );

      // ベースブランチのSHAを取得
      const baseSha = await getBranchSha(owner, repo, previousBranch);

      // ブランチを作成
      await createBranch(owner, repo, part.branchName, baseSha);

      // ファイルをコミット
      const partFiles = part.files
        .map((filename) => fileMap.get(filename))
        .filter((f): f is DiffFile => f !== undefined);

      if (partFiles.length > 0) {
        await commitFilesToBranch(
          owner,
          repo,
          part.branchName,
          partFiles,
          part.title,
          baseSha,
          headBranch
        );
      }

      // PR説明文を構築
      callbacks.onProgress(
        `[${part.order}/${proposal.parts.length}] Generating verification steps...`
      );
      const verificationSteps = await generateVerificationSteps(
        aiClient,
        originalPRTitle,
        part.title,
        part.description,
        part.files
      );

      const description = buildPRDescription(
        part.description,
        part.order,
        proposal.parts.length,
        originalPRNumber,
        headBranch,
        part.rationale,
        verificationSteps
      );

      // ドラフトPRを作成
      callbacks.onProgress(
        `[${part.order}/${proposal.parts.length}] Creating PR "${part.title}"...`
      );

      const splitPRTitle = `${originalPRTitle} [${part.order}/${proposal.parts.length}] ${part.title}`;

      const pr = await createDraftPR(
        owner,
        repo,
        splitPRTitle,
        description,
        part.branchName,
        previousBranch
      );

      createdPRs.push(pr);
      previousBranch = part.branchName;
    }

    return createdPRs;
  } catch (error) {
    // エラー時はすでに作成したPRとブランチをクリーンアップ
    if (createdPRs.length > 0) {
      callbacks.onProgress("Error occurred; cleaning up created PRs...");
      await deletePRs(owner, repo, createdPRs);
    }
    throw error;
  }
}

/**
 * 作成済みの分割PRを削除する
 */
export async function cleanupPRs(
  owner: string,
  repo: string,
  prs: CreatedPR[],
  callbacks: OrchestratorCallbacks
): Promise<void> {
  callbacks.onProgress("Deleting draft PRs...");
  await deletePRs(owner, repo, prs);
}

/**
 * PR説明文を構築する
 */
function buildPRDescription(
  description: string,
  order: number,
  total: number,
  originalPRNumber: number,
  originalBranch: string,
  rationale: string,
  verificationSteps: string
): string {
  return `${description}

---

## 🔗 prsplit Chain PR Info

| Item | Value |
|---|---|
| Review order | ${order} / ${total} |
| Original PR | #${originalPRNumber} |
| Original branch | \`${originalBranch}\` |

### Rationale
${rationale}

### Verification Steps
${verificationSteps}

---
*This PR was automatically generated by [prsplit](https://github.com/prsplit/prsplit).*`;
}

async function generateVerificationSteps(
  client: Awaited<ReturnType<typeof getAIClient>>,
  originalPRTitle: string,
  splitPRTitle: string,
  splitDescription: string,
  changedFiles: string[]
): Promise<string> {
  const systemPrompt = `You are a senior software QA engineer.
Generate practical verification steps for a pull request.

Rules:
- Return only markdown bullet points.
- Keep it concise: 3-6 bullets.
- Use concrete actions and expected outcomes.
- Do not use code fences.
- Write all bullets in English.`;

  const userPrompt = `Original PR title:
${originalPRTitle}

Split PR title:
${splitPRTitle}

Split PR description:
${splitDescription}

Changed files:
${changedFiles.map((file) => `- ${file}`).join("\n")}

Write verification steps for reviewers.`;

  const response = await client.complete(systemPrompt, userPrompt);
  return response.trim();
}

