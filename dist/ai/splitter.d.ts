/**
 * diff分割・統合ロジック
 * diffをAIに送信して分割提案を取得する
 */
import type { AIClient } from "./client.js";
import type { DiffFile } from "../utils/diff.js";
import { type SplitProposal } from "./prompt.js";
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
export declare function generateSplitProposal(client: AIClient, options: SplitOptions, onProgress?: (message: string) => void): Promise<SplitProposal>;
/**
 * 分割提案のバリデーション
 * 全ファイルが漏れなくカバーされているか確認する
 */
export declare function validateProposal(proposal: SplitProposal, originalFiles: DiffFile[]): {
    valid: boolean;
    errors: string[];
};
//# sourceMappingURL=splitter.d.ts.map