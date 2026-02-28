/**
 * 全体フローの制御
 * CLIから呼び出され、分割提案の生成 → PR作成 → ワークフロー生成を実行する
 */
import type { AIModel } from "../ai/client.js";
import type { SplitProposal } from "../ai/prompt.js";
import type { CreatedPR } from "../github/pr.js";
import type { DiffFile } from "../utils/diff.js";
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
export declare function generateProposal(options: OrchestratorOptions, callbacks: OrchestratorCallbacks): Promise<{
    proposal: SplitProposal;
    owner: string;
    repo: string;
    prNumber: number;
    headBranch: string;
    baseBranch: string;
    files: DiffFile[];
} | null>;
/**
 * 分割提案をもとにPRを作成する
 */
export declare function executeSplit(proposal: SplitProposal, owner: string, repo: string, originalPRNumber: number, headBranch: string, baseBranch: string, files: DiffFile[], callbacks: OrchestratorCallbacks): Promise<CreatedPR[]>;
/**
 * 作成済みの分割PRを削除する
 */
export declare function cleanupPRs(owner: string, repo: string, prs: CreatedPR[], callbacks: OrchestratorCallbacks): Promise<void>;
//# sourceMappingURL=orchestrator.d.ts.map