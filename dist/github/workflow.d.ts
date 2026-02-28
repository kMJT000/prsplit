/**
 * GitHub Actionsワークフロー生成
 * 前のPRがマージされたら次のPRのdraftを解除するワークフローを生成する
 */
interface WorkflowChainItem {
    /** マージを監視するPR番号 */
    watchPRNumber: number;
    /** マージ後にdraft解除するPR番号 */
    nextPRNumber: number;
    /** ワークフロー識別用の名前 */
    name: string;
}
/**
 * チェーンPRのマージ監視ワークフローを生成する
 */
export declare function generateWorkflowYaml(item: WorkflowChainItem): string;
/**
 * 最終PRがマージされたら元PRをcloseするワークフロー
 */
export declare function generateCloseOriginalWorkflowYaml(lastPRNumber: number, originalPRNumber: number): string;
/**
 * ワークフローファイルをリポジトリにコミットする
 */
export declare function commitWorkflows(owner: string, repo: string, branchName: string, workflows: Array<{
    filename: string;
    content: string;
}>): Promise<void>;
export {};
//# sourceMappingURL=workflow.d.ts.map