/**
 * プロンプト定義
 */

import type { DiffFile } from "../utils/diff.js";

export interface SplitProposal {
  /** 分割PR一覧（レビュー順） */
  parts: SplitPart[];
}

export interface SplitPart {
  /** レビュー順序（1始まり） */
  order: number;
  /** ブランチ名（例: feat/xxx-db-layer） */
  branchName: string;
  /** PRタイトル */
  title: string;
  /** PR説明文 */
  description: string;
  /** この分割に含まれるファイルパス一覧 */
  files: string[];
  /** 分割理由 */
  rationale: string;
}

/**
 * diff分割用のシステムプロンプト
 */
export function buildSystemPrompt(): string {
  return `You are an expert in optimizing pull request review workflows.
Analyze a large pull request diff and propose a split plan into review-friendly units.

## Splitting Rules
1. Default strategy is layer-based: DB (migrations/models) -> business logic -> API/controllers -> UI/frontend
2. If layer structure is unclear, fall back to:
   - feature-based grouping (independent features)
   - dependency order (dependencies first)
   - change type order (refactor -> feature -> test)
3. Make split PRs a chain where each PR depends on the previous PR
4. Combined diffs of all split PRs must exactly match the original PR diff
5. Each file must belong to exactly one split PR (file-level split)
6. Each PR should be buildable on its own whenever possible
7. All generated "title", "description", and "rationale" values must be in English, even if the input PR or instructions are in another language

## Output Format
Return JSON in the following format. Do not output any text outside JSON.

{
  "parts": [
    {
      "order": 1,
      "branchName": "feat/xxx-db-layer",
      "title": "feat: add database migrations and models",
      "description": "This PR introduces...",
      "files": ["path/to/file1.ts", "path/to/file2.ts"],
      "rationale": "Reviewing DB layer changes first reduces downstream ambiguity..."
    }
  ]
}`;
}

/**
 * diff分割用のユーザープロンプトを構築する
 */
export function buildSplitPrompt(
  prTitle: string,
  prBody: string | null,
  files: DiffFile[],
  additionalInstruction?: string
): string {
  const fileList = files
    .map(
      (f) =>
        `- ${f.filename} (${f.status}, ${f.patch.split("\n").length} lines)`
    )
    .join("\n");

  const diffContent = files
    .map((f) => `=== ${f.filename} (${f.status}) ===\n${f.patch}`)
    .join("\n\n");

  let prompt = `## Original PR Information
Title: ${prTitle}
Description: ${prBody ?? "(none)"}

## Changed Files (${files.length} files)
${fileList}

## Diff Content
${diffContent}

Please split this PR into review-friendly units.
All generated "title", "description", and "rationale" fields must be written in English.`;

  if (additionalInstruction) {
    prompt += `\n\n## Additional Instructions\n${additionalInstruction}`;
  }

  return prompt;
}

/**
 * 複数チャンクの分割結果を統合するためのプロンプト
 */
export function buildMergePrompt(
  prTitle: string,
  prBody: string | null,
  chunkResults: SplitProposal[]
): string {
  const allParts = chunkResults.flatMap((r) => r.parts);
  const partsJson = JSON.stringify(allParts, null, 2);

  return `## Original PR Information
Title: ${prTitle}
Description: ${prBody ?? "(none)"}

## Split Results From Each Chunk
The following are split results generated from multiple chunks of a large diff.
Merge them into one consistent split proposal.

${partsJson}

## Merge Rules
1. Merge parts with the same layer/purpose
2. Rebuild review order (DB -> Logic -> API -> UI)
3. Normalize branch naming consistently
4. Ensure there are no duplicate files
5. Consolidate descriptions appropriately
6. All generated "title", "description", and "rationale" fields must be in English`;
}

/**
 * AIレスポンスからJSONをパースする
 */
export function parseAIResponse(response: string): SplitProposal {
  // コードブロック内のJSONを抽出
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : response.trim();

  try {
    const parsed = JSON.parse(jsonStr);

    // バリデーション
    if (!parsed.parts || !Array.isArray(parsed.parts)) {
      throw new Error("AI response does not include a 'parts' array.");
    }

    for (const part of parsed.parts) {
      if (!part.order || !part.branchName || !part.title || !part.files) {
        throw new Error(
          `Split part "${part.branchName ?? "unknown"}" is missing required fields.`
        );
      }
    }

    return parsed as SplitProposal;
  } catch (e: unknown) {
    if (e instanceof SyntaxError) {
      throw new Error(
        `Failed to parse JSON from AI response.\n` +
          `Response (first 500 chars): ${response.slice(0, 500)}`
      );
    }
    throw e;
  }
}
