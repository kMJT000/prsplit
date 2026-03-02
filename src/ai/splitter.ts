/**
 * diff分割・統合ロジック
 * diffをAIに送信して分割提案を取得する
 */

import type { AIClient } from "./client.js";
import type { DiffFile } from "../utils/diff.js";
import { chunkDiffFiles } from "../utils/diff.js";
import {
  buildSystemPrompt,
  buildSplitPrompt,
  buildMergePrompt,
  parseAIResponse,
  type SplitProposal,
} from "./prompt.js";

export interface SplitOptions {
  prTitle: string;
  prBody: string | null;
  files: DiffFile[];
  additionalInstruction?: string;
}

export interface BuildRepairOptions {
  failingPartOrder: number;
  failingPartTitle: string;
  currentPartFiles: string[];
  candidateFilesByPart: Array<{
    order: number;
    title: string;
    files: string[];
  }>;
  failureSummary: string;
}

/**
 * AIを使ってPRの分割提案を生成する
 * diffが大きい場合は自動でチャンク分割して複数回AIに投げ、結果を統合する
 */
export async function generateSplitProposal(
  client: AIClient,
  options: SplitOptions,
  onProgress?: (message: string) => void
): Promise<SplitProposal> {
  const { prTitle, prBody, files, additionalInstruction } = options;
  const systemPrompt = buildSystemPrompt();

  // diffのチャンク分割を判定
  const chunks = chunkDiffFiles(files);

  if (chunks.length === 1) {
    // 1チャンクの場合：直接送信
    onProgress?.("Sending diff to AI...");
    const userPrompt = buildSplitPrompt(
      prTitle,
      prBody,
      files,
      additionalInstruction
    );
    const response = await client.complete(systemPrompt, userPrompt);
    return parseAIResponse(response);
  }

  // 複数チャンクの場合：分割送信 → 統合
  onProgress?.(
    `Diff is large, splitting into ${chunks.length} chunks...`
  );

  const chunkResults: SplitProposal[] = [];

  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(`Processing chunk ${i + 1}/${chunks.length}...`);
    const userPrompt = buildSplitPrompt(
      prTitle,
      prBody,
      chunks[i],
      additionalInstruction
    );
    const response = await client.complete(systemPrompt, userPrompt);
    chunkResults.push(parseAIResponse(response));
  }

  // 結果の統合
  onProgress?.("Merging split results...");
  const mergePrompt = buildMergePrompt(prTitle, prBody, chunkResults);
  const mergedResponse = await client.complete(systemPrompt, mergePrompt);
  return parseAIResponse(mergedResponse);
}

/**
 * 分割提案のバリデーション
 * 全ファイルが漏れなくカバーされているか確認する
 */
export function validateProposal(
  proposal: SplitProposal,
  originalFiles: DiffFile[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const originalFilenames = new Set(originalFiles.map((f) => f.filename));
  const proposedFilenames = new Set(
    proposal.parts.flatMap((p) => p.files)
  );

  // 元のファイルがすべてカバーされているか
  for (const filename of originalFilenames) {
    if (!proposedFilenames.has(filename)) {
      errors.push(`File "${filename}" is missing from the split proposal.`);
    }
  }

  // 重複チェック
  const seen = new Set<string>();
  for (const part of proposal.parts) {
    for (const filename of part.files) {
      if (seen.has(filename)) {
        errors.push(
          `File "${filename}" appears in multiple split PRs.`
        );
      }
      seen.add(filename);
    }
  }

  // 分割案にあるが元PRにないファイル
  for (const filename of proposedFilenames) {
    if (!originalFilenames.has(filename)) {
      errors.push(
        `File "${filename}" is in the split proposal but not in the original PR.`
      );
    }
  }

  // order の連番チェック
  const orders = proposal.parts.map((p) => p.order).sort((a, b) => a - b);
  for (let i = 0; i < orders.length; i++) {
    if (orders[i] !== i + 1) {
      errors.push(`Review order is not sequential: ${orders.join(", ")}`);
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * build-and-test 失敗時に、後続PRから前倒しすべきファイルをAIに提案させる
 */
export async function suggestFilesForBuildRepair(
  client: AIClient,
  options: BuildRepairOptions
): Promise<string[]> {
  const systemPrompt = `You are an expert at fixing split pull-request chains.
Your task is to choose the MINIMUM set of files to move from later split PR parts into the current failing part so that build-and-test can pass.

Rules:
1. Only choose files that exist in candidate parts.
2. Keep the move minimal and dependency-focused.
3. Prefer moving foundational files (types, utilities, interfaces, services) before tests.
4. Return JSON only. No markdown, no explanation.

Output JSON schema:
{
  "filesToMove": ["path/to/file.ts"]
}`;

  const userPrompt = [
    `Current failing part: #${options.failingPartOrder} ${options.failingPartTitle}`,
    "",
    "Files already in current part:",
    ...options.currentPartFiles.map((filePath) => `- ${filePath}`),
    "",
    "Candidate files from later parts:",
    ...options.candidateFilesByPart.flatMap((part) => [
      `Part #${part.order} ${part.title}`,
      ...part.files.map((filePath) => `- ${filePath}`),
    ]),
    "",
    "Failure summary:",
    options.failureSummary,
    "",
    "Return JSON only.",
  ].join("\n");

  const response = await client.complete(systemPrompt, userPrompt);
  const parsed = parseJsonObject(response);
  const filesToMove = readStringArray(parsed, "filesToMove");
  return Array.from(new Set(filesToMove));
}

function parseJsonObject(response: string): Record<string, unknown> {
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : response.trim();
  const parsed = JSON.parse(jsonStr);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI build repair response must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function readStringArray(
  parsed: Record<string, unknown>,
  key: string
): string[] {
  const value = parsed[key];
  if (!Array.isArray(value)) {
    throw new Error(`AI build repair response must include "${key}" array.`);
  }
  const nonString = value.find((item) => typeof item !== "string");
  if (nonString !== undefined) {
    throw new Error(`AI build repair response "${key}" must contain strings.`);
  }
  return value as string[];
}
