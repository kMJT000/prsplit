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
export declare function buildSystemPrompt(): string;
/**
 * diff分割用のユーザープロンプトを構築する
 */
export declare function buildSplitPrompt(prTitle: string, prBody: string | null, files: DiffFile[], additionalInstruction?: string): string;
/**
 * 複数チャンクの分割結果を統合するためのプロンプト
 */
export declare function buildMergePrompt(prTitle: string, prBody: string | null, chunkResults: SplitProposal[]): string;
/**
 * AIレスポンスからJSONをパースする
 */
export declare function parseAIResponse(response: string): SplitProposal;
//# sourceMappingURL=prompt.d.ts.map