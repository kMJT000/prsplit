/**
 * Octokit初期化・共通処理
 */
import { Octokit } from "octokit";
export declare function getOctokit(): Octokit;
/**
 * PR URLまたは番号からowner/repo/numberを取得
 */
export declare function parsePRIdentifier(input: string): {
    owner: string;
    repo: string;
    number: number;
};
/**
 * git remoteからowner/repoを取得
 */
export declare function getRepoFromRemote(): Promise<{
    owner: string;
    repo: string;
}>;
//# sourceMappingURL=client.d.ts.map