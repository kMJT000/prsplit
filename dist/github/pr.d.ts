/**
 * PR作成・close・draft制御
 */
export interface PRInfo {
    number: number;
    title: string;
    body: string | null;
    head: string;
    base: string;
    diff: string;
    state: string;
    htmlUrl: string;
}
export interface CreatedPR {
    number: number;
    title: string;
    htmlUrl: string;
    branchName: string;
}
/**
 * PRの情報を取得する
 */
export declare function getPRInfo(owner: string, repo: string, prNumber: number): Promise<PRInfo>;
/**
 * PRのファイル一覧を取得する
 */
export declare function getPRFiles(owner: string, repo: string, prNumber: number): Promise<Array<{
    filename: string;
    status: string;
    patch: string;
    additions: number;
    deletions: number;
}>>;
/**
 * ドラフトPRを作成する
 */
export declare function createDraftPR(owner: string, repo: string, title: string, body: string, head: string, base: string): Promise<CreatedPR>;
/**
 * PRをcloseする
 */
export declare function closePR(owner: string, repo: string, prNumber: number): Promise<void>;
/**
 * 複数のPRを削除（close + ブランチ削除）する
 */
export declare function deletePRs(owner: string, repo: string, prs: CreatedPR[]): Promise<void>;
/**
 * PRのdraft状態を解除する
 */
export declare function markPRReady(owner: string, repo: string, prNumber: number): Promise<void>;
//# sourceMappingURL=pr.d.ts.map