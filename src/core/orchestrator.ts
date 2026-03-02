/**
 * 全体フローの制御
 * CLIから呼び出され、分割提案の生成 → PR作成 → ワークフロー生成を実行する
 */

import path from "node:path";
import type { AIModel } from "../ai/client.js";
import type { SplitPart, SplitProposal } from "../ai/prompt.js";
import type { CreatedPR } from "../github/pr.js";
import type { DiffFile } from "../utils/diff.js";
import { getAIClient } from "../ai/client.js";
import {
  generateSplitProposal,
  suggestFilesForBuildRepair,
  validateProposal,
} from "../ai/splitter.js";
import {
  parsePRIdentifier,
  getRepoFromRemote,
} from "../github/client.js";
import {
  getPRInfo,
  getPRFiles,
  createDraftPR,
  closePRs,
  updatePRMetadata,
} from "../github/pr.js";
import {
  createBranch,
  getBranchSha,
  commitFilesToBranch,
  validateRelativeJsImportsOnRef,
} from "../github/branch.js";
import { waitForBuildAndTest } from "../github/actions.js";
import {
  generateWorkflowYaml,
  generateCloseOriginalWorkflowYaml,
  commitWorkflows,
} from "../github/workflow.js";

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
    headBranch: prInfo.head,
    baseBranch: prInfo.base,
    files: diffFiles,
  };
}

/**
 * 分割提案をもとにPRを作成する
 */
export async function executeSplit(
  model: AIModel,
  proposal: SplitProposal,
  owner: string,
  repo: string,
  originalPRNumber: number,
  headBranch: string,
  baseBranch: string,
  files: DiffFile[],
  callbacks: OrchestratorCallbacks
): Promise<CreatedPR[]> {
  const createdPRs: CreatedPR[] = [];
  const createdEntries: Array<{ pr: CreatedPR; part: SplitPart }> = [];
  const collapsedParts: SplitPart[] = [];
  const fileMap = new Map(files.map((f) => [f.filename, f]));

  try {
    const aiClient = await getAIClient(model);
    let previousBranch = baseBranch;

    for (let index = 0; index < proposal.parts.length; index++) {
      const part = proposal.parts[index];
      const partFiles = resolvePartFiles(part.files, fileMap);
      if (partFiles.length === 0) {
        collapsedParts.push(part);
        callbacks.onProgress(
          `[${part.order}/${proposal.parts.length}] Auto-collapsed "${part.branchName}" because it has no files after repair.`
        );
        continue;
      }

      callbacks.onProgress(
        `[${part.order}/${proposal.parts.length}] Creating branch "${part.branchName}"...`
      );

      // ベースブランチのSHAを取得
      const baseSha = await getBranchSha(owner, repo, previousBranch);

      // ブランチを作成
      const resolvedBranchName = await createBranch(
        owner,
        repo,
        part.branchName,
        baseSha
      );

      if (resolvedBranchName !== part.branchName) {
        callbacks.onProgress(
          `[${part.order}/${proposal.parts.length}] Branch "${part.branchName}" already exists; using "${resolvedBranchName}".`
        );
      }

      // ファイルをコミット（初回）
      let currentCommitSha = baseSha;
      if (partFiles.length > 0) {
        currentCommitSha = await commitFilesToBranch(
          owner,
          repo,
          resolvedBranchName,
          partFiles,
          part.title,
          baseSha,
          headBranch
        );

        currentCommitSha = await ensurePrecheckResolvableWithAutoMove({
          owner,
          repo,
          branchName: resolvedBranchName,
          proposal,
          partIndex: index,
          headBranch,
          currentCommitSha,
          fileMap,
          callbacks,
        });
      }

      // PR作成前に build-and-test を実行し、失敗時はLLMで最大3回リカバリ
      currentCommitSha = await ensureBuildAndTestBeforePR({
        owner,
        repo,
        branchName: resolvedBranchName,
        proposal,
        partIndex: index,
        headBranch,
        currentCommitSha,
        fileMap,
        callbacks,
        aiClient,
      });

      // PR説明文を構築
      const description = buildPRDescription(
        part.description,
        part.order,
        proposal.parts.length,
        originalPRNumber,
        headBranch,
        part.rationale
      );

      // ドラフトPRを作成
      callbacks.onProgress(
        `[${part.order}/${proposal.parts.length}] Creating PR "${part.title}"...`
      );

      const pr = await createDraftPR(
        owner,
        repo,
        buildPRTitle(part.title, part.order, proposal.parts.length),
        description,
        resolvedBranchName,
        previousBranch
      );

      createdPRs.push(pr);
      createdEntries.push({ pr, part });
      previousBranch = resolvedBranchName;
    }

    if (createdEntries.length === 0) {
      throw new Error("No split PRs could be created after auto-collapse.");
    }

    if (collapsedParts.length > 0) {
      const collapsedPartLabels = collapsedParts.map(
        (part) => `#${part.order} ${part.branchName}`
      );
      callbacks.onProgress(
        `Auto-collapsed ${collapsedParts.length} empty part(s): ${collapsedPartLabels.join(", ")}`
      );
    }

    await relabelEffectivePRs(
      owner,
      repo,
      originalPRNumber,
      headBranch,
      proposal.parts.length,
      createdEntries,
      callbacks
    );

    // ワークフローファイルを生成
    callbacks.onProgress("Generating GitHub Actions workflows...");
    const workflows = generateChainWorkflows(
      createdPRs,
      originalPRNumber,
      baseBranch
    );

    if (workflows.length > 0) {
      // 最初の分割PRブランチにワークフローをコミット
      await commitWorkflows(
        owner,
        repo,
        createdPRs[0].branchName,
        workflows
      );
    }

    return createdPRs;
  } catch (error) {
    // エラー時はすでに作成したPRとブランチをクリーンアップ
    if (createdPRs.length > 0) {
      callbacks.onProgress("Error occurred; cleaning up created PRs...");
      await closePRs(owner, repo, createdPRs);
    }
    throw error;
  }
}

async function relabelEffectivePRs(
  owner: string,
  repo: string,
  originalPRNumber: number,
  headBranch: string,
  originalPartCount: number,
  createdEntries: Array<{ pr: CreatedPR; part: SplitPart }>,
  callbacks: OrchestratorCallbacks
): Promise<void> {
  const effectiveTotal = createdEntries.length;
  const requiresRelabel =
    effectiveTotal !== originalPartCount ||
    createdEntries.some((entry, index) => entry.part.order !== index + 1);

  if (!requiresRelabel) {
    return;
  }

  callbacks.onProgress(
    `Re-labeling PR review order to 1/${effectiveTotal}..${effectiveTotal}/${effectiveTotal} after auto-collapse...`
  );

  for (let index = 0; index < createdEntries.length; index++) {
    const entry = createdEntries[index];
    const effectiveOrder = index + 1;
    const nextTitle = buildPRTitle(entry.part.title, effectiveOrder, effectiveTotal);
    const nextDescription = buildPRDescription(
      entry.part.description,
      effectiveOrder,
      effectiveTotal,
      originalPRNumber,
      headBranch,
      entry.part.rationale
    );

    await updatePRMetadata(
      owner,
      repo,
      entry.pr.number,
      nextTitle,
      nextDescription
    );
    entry.pr.title = nextTitle;
  }
}

async function ensureBuildAndTestBeforePR(params: {
  owner: string;
  repo: string;
  branchName: string;
  proposal: SplitProposal;
  partIndex: number;
  headBranch: string;
  currentCommitSha: string;
  fileMap: Map<string, DiffFile>;
  callbacks: OrchestratorCallbacks;
  aiClient: Awaited<ReturnType<typeof getAIClient>>;
}): Promise<string> {
  const maxRepairAttempts = 3;
  const {
    owner,
    repo,
    branchName,
    proposal,
    partIndex,
    headBranch,
    fileMap,
    callbacks,
    aiClient,
  } = params;

  const part = proposal.parts[partIndex];
  let currentCommitSha = params.currentCommitSha;

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
    callbacks.onProgress(
      `[${part.order}/${proposal.parts.length}] Running build-and-test (${attempt + 1}/${maxRepairAttempts + 1})...`
    );

    const buildResult = await waitForBuildAndTest(owner, repo, {
      branchName,
      commitSha: currentCommitSha,
      workflowName: "CI",
    });

    if (buildResult.success) {
      callbacks.onProgress(
        `[${part.order}/${proposal.parts.length}] build-and-test passed.`
      );
      return currentCommitSha;
    }

    if (attempt === maxRepairAttempts) {
      throw new Error(
        `[${part.order}/${proposal.parts.length}] build-and-test failed after ${maxRepairAttempts} repair attempts.\n` +
          `${buildResult.summary}\n` +
          `Run: ${buildResult.runUrl}`
      );
    }

    const candidateFilesByPart = collectCandidateFilesByPart(
      proposal,
      partIndex,
      fileMap
    );
    if (candidateFilesByPart.length === 0) {
      throw new Error(
        `[${part.order}/${proposal.parts.length}] build-and-test failed and no candidate files remain for AI repair.\n` +
          `${buildResult.summary}\n` +
          `Run: ${buildResult.runUrl}`
      );
    }

    const annotationCandidatePaths = parseFailureAnnotationCandidatePaths(
      buildResult.summary
    );
    const deterministicFilesToMove = collectFilesToMoveByCandidates(
      proposal,
      partIndex,
      annotationCandidatePaths
    );

    if (deterministicFilesToMove.length > 0) {
      moveFilesIntoCurrentPart(proposal, partIndex, deterministicFilesToMove);
      const movedFiles = resolvePartFiles(deterministicFilesToMove, fileMap);
      if (movedFiles.length > 0) {
        callbacks.onProgress(
          `[${part.order}/${proposal.parts.length}] Auto-repairing build-and-test by moving failure-annotated files: ${deterministicFilesToMove.join(", ")}.`
        );

        const parentSha = await getBranchSha(owner, repo, branchName);
        currentCommitSha = await commitFilesToBranch(
          owner,
          repo,
          branchName,
          movedFiles,
          "fix: include files referenced by failure annotations",
          parentSha,
          headBranch
        );

        currentCommitSha = await ensurePrecheckResolvableWithAutoMove({
          owner,
          repo,
          branchName,
          proposal,
          partIndex,
          headBranch,
          currentCommitSha,
          fileMap,
          callbacks,
        });
        continue;
      }
    }

    callbacks.onProgress(
      `[${part.order}/${proposal.parts.length}] build-and-test failed, asking AI to repair split (${attempt + 1}/${maxRepairAttempts})...`
    );

    const suggestedFiles = await suggestFilesForBuildRepair(aiClient, {
      failingPartOrder: part.order,
      failingPartTitle: part.title,
      currentPartFiles: [...part.files],
      candidateFilesByPart,
      failureSummary: `${buildResult.summary}\nRun: ${buildResult.runUrl}`,
    });

    const candidateSet = new Set(
      candidateFilesByPart.flatMap((candidatePart) => candidatePart.files)
    );
    let filesToMove = suggestedFiles.filter((filePath) =>
      candidateSet.has(filePath)
    );

    if (filesToMove.length === 0) {
      // AIが空応答・不正応答を返しても進めるため、最短で次のpartを丸ごと前倒しする
      filesToMove = [...candidateFilesByPart[0].files];
    }

    moveFilesIntoCurrentPart(proposal, partIndex, filesToMove);

    const movedFiles = resolvePartFiles(filesToMove, fileMap);
    if (movedFiles.length === 0) {
      throw new Error(
        `[${part.order}/${proposal.parts.length}] AI repair selected files that cannot be resolved in diff map.`
      );
    }

    const parentSha = await getBranchSha(owner, repo, branchName);
    currentCommitSha = await commitFilesToBranch(
      owner,
      repo,
      branchName,
      movedFiles,
      `fix: include files for build-and-test (attempt ${attempt + 1})`,
      parentSha,
      headBranch
    );

    currentCommitSha = await ensurePrecheckResolvableWithAutoMove({
      owner,
      repo,
      branchName,
      proposal,
      partIndex,
      headBranch,
      currentCommitSha,
      fileMap,
      callbacks,
    });
  }

  return currentCommitSha;
}

async function ensurePrecheckResolvableWithAutoMove(params: {
  owner: string;
  repo: string;
  branchName: string;
  proposal: SplitProposal;
  partIndex: number;
  headBranch: string;
  currentCommitSha: string;
  fileMap: Map<string, DiffFile>;
  callbacks: OrchestratorCallbacks;
}): Promise<string> {
  const maxAutoMoves = 10;
  const {
    owner,
    repo,
    branchName,
    proposal,
    partIndex,
    headBranch,
    fileMap,
    callbacks,
  } = params;

  const part = proposal.parts[partIndex];
  let currentCommitSha = params.currentCommitSha;

  for (let movedCount = 0; movedCount <= maxAutoMoves; movedCount++) {
    const precheckTargets = resolvePrecheckTargets(part.files, fileMap);

    try {
      await validateRelativeJsImportsOnRef(
        owner,
        repo,
        branchName,
        precheckTargets
      );
      return currentCommitSha;
    } catch (error) {
      const missingImport = parseMissingImportPrecheckError(error);
      if (!missingImport || movedCount === maxAutoMoves) {
        throw error;
      }

      const candidatePaths = resolveMissingImportCandidatePaths(
        missingImport.importerPath,
        missingImport.specifier
      );
      const filesToMove = collectFilesToMoveByCandidates(
        proposal,
        partIndex,
        candidatePaths
      );

      if (filesToMove.length === 0) {
        throw error;
      }

      moveFilesIntoCurrentPart(proposal, partIndex, filesToMove);

      const movedFiles = resolvePartFiles(filesToMove, fileMap);
      if (movedFiles.length === 0) {
        throw error;
      }

      callbacks.onProgress(
        `[${part.order}/${proposal.parts.length}] Auto-repairing precheck by moving dependency files: ${filesToMove.join(", ")}.`
      );

      const parentSha = await getBranchSha(owner, repo, branchName);
      currentCommitSha = await commitFilesToBranch(
        owner,
        repo,
        branchName,
        movedFiles,
        `fix: include dependency files for precheck`,
        parentSha,
        headBranch
      );
    }
  }

  return currentCommitSha;
}

function resolvePartFiles(
  filenames: string[],
  fileMap: Map<string, DiffFile>
): DiffFile[] {
  return filenames
    .map((filename) => fileMap.get(filename))
    .filter((file): file is DiffFile => file !== undefined);
}

function resolvePrecheckTargets(
  filenames: string[],
  fileMap: Map<string, DiffFile>
): string[] {
  return resolvePartFiles(filenames, fileMap)
    .filter((file) => file.status !== "removed")
    .map((file) => file.filename);
}

function collectCandidateFilesByPart(
  proposal: SplitProposal,
  currentPartIndex: number,
  fileMap: Map<string, DiffFile>
): Array<{ order: number; title: string; files: string[] }> {
  const candidates: Array<{ order: number; title: string; files: string[] }> = [];

  for (let index = currentPartIndex + 1; index < proposal.parts.length; index++) {
    const part = proposal.parts[index];
    const files = part.files.filter((filePath) => fileMap.has(filePath));
    if (files.length > 0) {
      candidates.push({
        order: part.order,
        title: part.title,
        files,
      });
    }
  }

  return candidates;
}

function moveFilesIntoCurrentPart(
  proposal: SplitProposal,
  currentPartIndex: number,
  filesToMove: string[]
): void {
  const currentPart = proposal.parts[currentPartIndex];
  const uniqueFilesToMove = Array.from(new Set(filesToMove));

  for (const filePath of uniqueFilesToMove) {
    if (!currentPart.files.includes(filePath)) {
      currentPart.files.push(filePath);
    }
  }

  for (
    let targetPartIndex = currentPartIndex + 1;
    targetPartIndex < proposal.parts.length;
    targetPartIndex++
  ) {
    const targetPart = proposal.parts[targetPartIndex];
    targetPart.files = targetPart.files.filter(
      (filePath) => !uniqueFilesToMove.includes(filePath)
    );
  }
}

function parseMissingImportPrecheckError(error: unknown): {
  importerPath: string;
  specifier: string;
} | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const match = error.message.match(
    /Build precheck failed: "([^"]+)" imports "([^"]+)", but no matching source file exists on "[^"]+"\./
  );
  if (!match) {
    return null;
  }

  return {
    importerPath: match[1],
    specifier: match[2],
  };
}

function resolveMissingImportCandidatePaths(
  importerPath: string,
  specifier: string
): string[] {
  if (!specifier.startsWith(".") || !specifier.endsWith(".js")) {
    return [];
  }

  const basePath = normalizeRepoPath(
    path.posix.join(path.posix.dirname(importerPath), specifier)
  );
  const tsPath = basePath.replace(/\.js$/, ".ts");

  return [
    tsPath,
    tsPath.replace(/\.ts$/, ".tsx"),
    tsPath.replace(/\.ts$/, "/index.ts"),
    tsPath.replace(/\.ts$/, "/index.tsx"),
  ];
}

function collectFilesToMoveByCandidates(
  proposal: SplitProposal,
  currentPartIndex: number,
  candidatePaths: string[]
): string[] {
  if (candidatePaths.length === 0) {
    return [];
  }

  const currentPart = proposal.parts[currentPartIndex];
  const currentPartSet = new Set(currentPart.files);
  const candidateSet = new Set(candidatePaths);
  const result: string[] = [];

  for (
    let targetPartIndex = currentPartIndex + 1;
    targetPartIndex < proposal.parts.length;
    targetPartIndex++
  ) {
    const part = proposal.parts[targetPartIndex];
    for (const filePath of part.files) {
      if (currentPartSet.has(filePath)) {
        continue;
      }
      if (candidateSet.has(filePath) && !result.includes(filePath)) {
        result.push(filePath);
      }
    }
  }

  return result;
}

function parseFailureAnnotationCandidatePaths(summary: string): string[] {
  const lines = summary.split("\n");
  const result = new Set<string>();

  for (const line of lines) {
    const match = line.match(/^\s*-\s+([^:\s][^:]*?):\d+\s+/);
    if (!match) {
      continue;
    }
    result.add(normalizeRepoPath(match[1]));
  }

  return [...result];
}

function normalizeRepoPath(candidatePath: string): string {
  return path.posix.normalize(candidatePath).replace(/^\.?\//, "");
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
  callbacks.onProgress("Closing draft PRs...");
  await closePRs(owner, repo, prs);
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
  rationale: string
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

---
*This PR was automatically generated by [prsplit](https://github.com/prsplit/prsplit).*`;
}

function buildPRTitle(title: string, order: number, total: number): string {
  return `[${order}/${total}] ${title}`;
}

/**
 * チェーンPR用のワークフローを生成する
 */
function generateChainWorkflows(
  prs: CreatedPR[],
  originalPRNumber: number,
  originalBaseBranch: string
): Array<{ filename: string; content: string }> {
  const workflows: Array<{ filename: string; content: string }> = [];

  // チェーンPR間のワークフロー
  for (let i = 0; i < prs.length - 1; i++) {
    const current = prs[i];
    const next = prs[i + 1];

    workflows.push({
      filename: `chain-${current.number}-to-${next.number}.yml`,
      content: generateWorkflowYaml({
        watchPRNumber: current.number,
        nextPRNumber: next.number,
        originalBaseBranch,
        name: `#${current.number} → #${next.number}`,
      }),
    });
  }

  // 最終PRマージ後の元PRクローズ
  if (prs.length > 0) {
    const lastPR = prs[prs.length - 1];
    const closeOriginalFilename = `close-original-${originalPRNumber}.yml`;
    const cleanupWorkflowFilenames = [
      ...workflows.map((workflow) => workflow.filename),
      closeOriginalFilename,
    ];

    workflows.push({
      filename: closeOriginalFilename,
      content: generateCloseOriginalWorkflowYaml(
        lastPR.number,
        originalPRNumber,
        originalBaseBranch,
        cleanupWorkflowFilenames
      ),
    });
  }

  return workflows;
}
