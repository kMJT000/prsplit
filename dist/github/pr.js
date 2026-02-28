/**
 * PR作成・close・draft制御
 */
import { getOctokit } from "./client.js";
/**
 * PRの情報を取得する
 */
export async function getPRInfo(owner, repo, prNumber) {
    const octokit = getOctokit();
    const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
    });
    return {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        head: pr.head.ref,
        base: pr.base.ref,
        state: pr.state,
        htmlUrl: pr.html_url,
    };
}
/**
 * PRのファイル一覧を取得する
 */
export async function getPRFiles(owner, repo, prNumber) {
    const octokit = getOctokit();
    const files = [];
    // ページネーション対応
    for await (const response of octokit.paginate.iterator(octokit.rest.pulls.listFiles, { owner, repo, pull_number: prNumber, per_page: 100 })) {
        for (const file of response.data) {
            files.push({
                filename: file.filename,
                status: file.status,
                patch: file.patch ?? "",
                additions: file.additions,
                deletions: file.deletions,
            });
        }
    }
    return files;
}
/**
 * ドラフトPRを作成する
 */
export async function createDraftPR(owner, repo, title, body, head, base) {
    const octokit = getOctokit();
    const { data: pr } = await octokit.rest.pulls.create({
        owner,
        repo,
        title,
        body,
        head,
        base,
        draft: true,
    });
    return {
        number: pr.number,
        title: pr.title,
        htmlUrl: pr.html_url,
        branchName: head,
    };
}
/**
 * PRをcloseする
 */
export async function closePR(owner, repo, prNumber) {
    const octokit = getOctokit();
    await octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: prNumber,
        state: "closed",
    });
}
/**
 * 複数のPRを削除（close + ブランチ削除）する
 */
export async function deletePRs(owner, repo, prs) {
    const octokit = getOctokit();
    for (const pr of prs) {
        try {
            await octokit.rest.pulls.update({
                owner,
                repo,
                pull_number: pr.number,
                state: "closed",
            });
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`警告: PR #${pr.number} のクローズに失敗しました。(${reason})`);
        }
        try {
            await octokit.rest.git.deleteRef({
                owner,
                repo,
                ref: `heads/${pr.branchName}`,
            });
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`警告: ブランチ "${pr.branchName}" の削除に失敗しました。(${reason})`);
        }
    }
}
/**
 * PRのdraft状態を解除する
 */
export async function markPRReady(owner, repo, prNumber) {
    const octokit = getOctokit();
    // GraphQL APIを使用（REST APIではdraft解除不可）
    const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
    });
    await octokit.graphql(`
    mutation($pullRequestId: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
        pullRequest {
          isDraft
        }
      }
    }
  `, { pullRequestId: pr.node_id });
}
//# sourceMappingURL=pr.js.map