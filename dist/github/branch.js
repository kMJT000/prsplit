/**
 * ブランチ操作
 */
import { getOctokit } from "./client.js";
/**
 * ブランチを作成する（指定のベースブランチから）
 */
export async function createBranch(owner, repo, branchName, baseSha) {
    const octokit = getOctokit();
    await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branchName}`,
        sha: baseSha,
    });
}
/**
 * ブランチを削除する
 */
export async function deleteBranch(owner, repo, branchName) {
    const octokit = getOctokit();
    try {
        await octokit.rest.git.deleteRef({
            owner,
            repo,
            ref: `heads/${branchName}`,
        });
    }
    catch {
        // ブランチが存在しない場合は無視
    }
}
/**
 * 指定ブランチのHEAD SHAを取得する
 */
export async function getBranchSha(owner, repo, branch) {
    const octokit = getOctokit();
    const { data } = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
    });
    return data.object.sha;
}
/**
 * ファイル変更をコミットする
 * diffの内容をTree APIで一括コミット
 */
export async function commitFilesToBranch(owner, repo, branchName, files, commitMessage, baseSha) {
    const octokit = getOctokit();
    // Tree blobsを作成
    const treeItems = [];
    for (const file of files) {
        if (file.status === "removed") {
            // 削除ファイル: sha を null にして削除を表現
            treeItems.push({
                path: file.filename,
                mode: "100644",
                type: "blob",
                sha: null,
            });
        }
        else {
            // 追加・変更: diffからファイル内容を復元するのは困難なため、
            // 元PRのブランチからファイル内容を取得する
            try {
                const { data } = await octokit.rest.repos.getContent({
                    owner,
                    repo,
                    path: file.filename,
                    ref: branchName,
                });
                if ("content" in data && data.type === "file") {
                    treeItems.push({
                        path: file.filename,
                        mode: "100644",
                        type: "blob",
                        content: Buffer.from(data.content, "base64").toString("utf-8"),
                    });
                }
            }
            catch {
                // ファイルが取得できない場合はスキップ
                console.warn(`警告: ${file.filename} の取得に失敗しました。スキップします。`);
            }
        }
    }
    if (treeItems.length === 0) {
        return baseSha;
    }
    // Treeを作成
    const { data: tree } = await octokit.rest.git.createTree({
        owner,
        repo,
        base_tree: baseSha,
        tree: treeItems,
    });
    // コミットを作成
    const { data: commit } = await octokit.rest.git.createCommit({
        owner,
        repo,
        message: commitMessage,
        tree: tree.sha,
        parents: [baseSha],
    });
    // ブランチを更新
    await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${branchName}`,
        sha: commit.sha,
    });
    return commit.sha;
}
//# sourceMappingURL=branch.js.map