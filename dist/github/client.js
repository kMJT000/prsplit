/**
 * Octokit初期化・共通処理
 */
import { Octokit } from "octokit";
let octokitInstance = null;
export function getOctokit() {
    if (octokitInstance)
        return octokitInstance;
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error("GITHUB_TOKEN が設定されていません。\n" +
            "export GITHUB_TOKEN=ghp_xxxxx で設定してください。");
    }
    octokitInstance = new Octokit({ auth: token });
    return octokitInstance;
}
/**
 * PR URLまたは番号からowner/repo/numberを取得
 */
export function parsePRIdentifier(input) {
    // URL形式: https://github.com/owner/repo/pull/123
    const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (urlMatch) {
        return {
            owner: urlMatch[1],
            repo: urlMatch[2],
            number: parseInt(urlMatch[3], 10),
        };
    }
    // 番号のみの場合、git remoteから取得
    const num = parseInt(input, 10);
    if (!isNaN(num)) {
        return { owner: "", repo: "", number: num };
    }
    throw new Error(`無効なPR指定: ${input}\n` +
        "PR番号 または https://github.com/owner/repo/pull/123 形式で指定してください。");
}
/**
 * git remoteからowner/repoを取得
 */
export async function getRepoFromRemote() {
    const { execSync } = await import("child_process");
    try {
        const remote = execSync("git remote get-url origin", {
            encoding: "utf-8",
        }).trim();
        // SSH: git@github.com:owner/repo.git
        const sshMatch = remote.match(/git@github\.com:([^/]+)\/([^/.]+)/);
        if (sshMatch) {
            return { owner: sshMatch[1], repo: sshMatch[2] };
        }
        // HTTPS: https://github.com/owner/repo.git
        const httpsMatch = remote.match(/github\.com\/([^/]+)\/([^/.]+)/);
        if (httpsMatch) {
            return { owner: httpsMatch[1], repo: httpsMatch[2] };
        }
        throw new Error("GitHub以外のリモートは対応していません。");
    }
    catch (e) {
        if (e instanceof Error && e.message.includes("GitHub以外"))
            throw e;
        throw new Error("git remoteからリポジトリ情報を取得できませんでした。\n" +
            "PR URLをフルで指定してください。");
    }
}
//# sourceMappingURL=client.js.map