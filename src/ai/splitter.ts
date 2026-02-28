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
    onProgress?.("AIにdiffを送信中...");
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
    `diffが大きいため ${chunks.length} チャンクに分割して処理します...`
  );

  const chunkResults: SplitProposal[] = [];

  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(`チャンク ${i + 1}/${chunks.length} を処理中...`);
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
  onProgress?.("分割結果を統合中...");
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
      errors.push(`ファイル "${filename}" が分割案に含まれていません。`);
    }
  }

  // 重複チェック
  const seen = new Set<string>();
  for (const part of proposal.parts) {
    for (const filename of part.files) {
      if (seen.has(filename)) {
        errors.push(
          `ファイル "${filename}" が重複して複数の分割PRに含まれています。`
        );
      }
      seen.add(filename);
    }
  }

  // 分割案にあるが元PRにないファイル
  for (const filename of proposedFilenames) {
    if (!originalFilenames.has(filename)) {
      errors.push(
        `ファイル "${filename}" は元PRに含まれていませんが、分割案に存在します。`
      );
    }
  }

  // order の連番チェック
  const orders = proposal.parts.map((p) => p.order).sort((a, b) => a - b);
  for (let i = 0; i < orders.length; i++) {
    if (orders[i] !== i + 1) {
      errors.push(`レビュー順序が連番になっていません: ${orders.join(", ")}`);
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}
