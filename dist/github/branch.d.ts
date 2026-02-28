/**
 * ブランチ操作
 */
import type { DiffFile } from "../utils/diff.js";
/**
 * ブランチを作成する（指定のベースブランチから）
 */
export declare function createBranch(owner: string, repo: string, branchName: string, baseSha: string): Promise<void>;
/**
 * ブランチを削除する
 */
export declare function deleteBranch(owner: string, repo: string, branchName: string): Promise<void>;
/**
 * 指定ブランチのHEAD SHAを取得する
 */
export declare function getBranchSha(owner: string, repo: string, branch: string): Promise<string>;
/**
 * ファイル変更をコミットする
 * diffの内容をTree APIで一括コミット
 */
export declare function commitFilesToBranch(owner: string, repo: string, branchName: string, files: DiffFile[], commitMessage: string, baseSha: string): Promise<string>;
//# sourceMappingURL=branch.d.ts.map