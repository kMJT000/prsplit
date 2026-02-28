/**
 * 全体フローの制御
 * CLIから呼び出され、分割提案の生成 → PR作成 → ワークフロー生成を実行する
 */
import { getAIClient } from "../ai/client.js";
import { generateSplitProposal, validateProposal } from "../ai/splitter.js";
import { parsePRIdentifier, getRepoFromRemote, } from "../github/client.js";
import { getPRInfo, getPRFiles, createDraftPR, deletePRs } from "../github/pr.js";
import { createBranch, getBranchSha, commitFilesToBranch, } from "../github/branch.js";
import { generateWorkflowYaml, generateCloseOriginalWorkflowYaml, commitWorkflows, } from "../github/workflow.js";
/**
 * 分割提案を生成する（dry-runモードでも使う共通処理）
 */
export async function generateProposal(options, callbacks) {
    const { prIdentifier, model, additionalPrompt } = options;
    // 1. PR情報を解析
    let { owner, repo, number: prNumber } = parsePRIdentifier(prIdentifier);
    if (!owner || !repo) {
        callbacks.onProgress("git remoteからリポジトリ情報を取得中...");
        const remote = await getRepoFromRemote();
        owner = remote.owner;
        repo = remote.repo;
    }
    // 2. PR情報を取得
    callbacks.onProgress(`PR #${prNumber} の情報を取得中...`);
    const prInfo = await getPRInfo(owner, repo, prNumber);
    if (prInfo.state !== "open") {
        callbacks.onError(new Error(`PR #${prNumber} はオープン状態ではありません (${prInfo.state})。`));
        return null;
    }
    // 3. ファイル一覧を取得
    callbacks.onProgress("変更ファイル一覧を取得中...");
    const prFiles = await getPRFiles(owner, repo, prNumber);
    const diffFiles = prFiles.map((f) => ({
        filename: f.filename,
        patch: f.patch,
        status: f.status,
    }));
    callbacks.onProgress(`${diffFiles.length} ファイルの変更を検出しました。`);
    // 4. AIクライアントを初期化
    callbacks.onProgress(`AIモデル (${model}) を初期化中...`);
    const aiClient = await getAIClient(model);
    // 5. 分割提案を生成
    const proposal = await generateSplitProposal(aiClient, {
        prTitle: prInfo.title,
        prBody: prInfo.body,
        files: diffFiles,
        additionalInstruction: additionalPrompt,
    }, callbacks.onProgress);
    // 6. バリデーション
    const validation = validateProposal(proposal, diffFiles);
    if (!validation.valid) {
        callbacks.onError(new Error(`分割案の検証に失敗しました:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`));
        return null;
    }
    // 順序でソート
    proposal.parts.sort((a, b) => a.order - b.order);
    callbacks.onProposal(proposal);
    return {
        proposal,
        owner,
        repo,
        prNumber,
        headBranch: prInfo.head,
        baseBranch: prInfo.base,
        files: diffFiles,
    };
}
/**
 * 分割提案をもとにPRを作成する
 */
export async function executeSplit(proposal, owner, repo, originalPRNumber, headBranch, baseBranch, files, callbacks) {
    const createdPRs = [];
    const fileMap = new Map(files.map((f) => [f.filename, f]));
    try {
        let previousBranch = baseBranch;
        for (const part of proposal.parts) {
            callbacks.onProgress(`[${part.order}/${proposal.parts.length}] ブランチ "${part.branchName}" を作成中...`);
            // ベースブランチのSHAを取得
            const baseSha = await getBranchSha(owner, repo, previousBranch);
            // ブランチを作成
            await createBranch(owner, repo, part.branchName, baseSha);
            // ファイルをコミット
            const partFiles = part.files
                .map((filename) => fileMap.get(filename))
                .filter((f) => f !== undefined);
            if (partFiles.length > 0) {
                await commitFilesToBranch(owner, repo, part.branchName, partFiles, part.title, baseSha, headBranch);
            }
            // PR説明文を構築
            const description = buildPRDescription(part.description, part.order, proposal.parts.length, originalPRNumber, headBranch, part.rationale);
            // ドラフトPRを作成
            callbacks.onProgress(`[${part.order}/${proposal.parts.length}] PR "${part.title}" を作成中...`);
            const pr = await createDraftPR(owner, repo, `[${part.order}/${proposal.parts.length}] ${part.title}`, description, part.branchName, previousBranch);
            createdPRs.push(pr);
            previousBranch = part.branchName;
        }
        // ワークフローファイルを生成
        callbacks.onProgress("GitHub Actionsワークフローを生成中...");
        const workflows = generateChainWorkflows(createdPRs, originalPRNumber);
        if (workflows.length > 0) {
            // 最初の分割PRブランチにワークフローをコミット
            await commitWorkflows(owner, repo, createdPRs[0].branchName, workflows);
        }
        return createdPRs;
    }
    catch (error) {
        // エラー時はすでに作成したPRとブランチをクリーンアップ
        if (createdPRs.length > 0) {
            callbacks.onProgress("エラーが発生したため、作成済みPRを削除中...");
            await deletePRs(owner, repo, createdPRs);
        }
        throw error;
    }
}
/**
 * 作成済みの分割PRを削除する
 */
export async function cleanupPRs(owner, repo, prs, callbacks) {
    callbacks.onProgress("ドラフトPRを削除中...");
    await deletePRs(owner, repo, prs);
}
/**
 * PR説明文を構築する
 */
function buildPRDescription(description, order, total, originalPRNumber, originalBranch, rationale) {
    return `${description}

---

## 🔗 prsplit チェーンPR情報

| 項目 | 値 |
|---|---|
| レビュー順序 | ${order} / ${total} |
| 元PR | #${originalPRNumber} |
| 元ブランチ | \`${originalBranch}\` |

### 分割理由
${rationale}

---
*このPRは [prsplit](https://github.com/prsplit/prsplit) によって自動生成されました。*`;
}
/**
 * チェーンPR用のワークフローを生成する
 */
function generateChainWorkflows(prs, originalPRNumber) {
    const workflows = [];
    // チェーンPR間のワークフロー
    for (let i = 0; i < prs.length - 1; i++) {
        const current = prs[i];
        const next = prs[i + 1];
        workflows.push({
            filename: `chain-${current.number}-to-${next.number}.yml`,
            content: generateWorkflowYaml({
                watchPRNumber: current.number,
                nextPRNumber: next.number,
                name: `#${current.number} → #${next.number}`,
            }),
        });
    }
    // 最終PRマージ後の元PRクローズ
    if (prs.length > 0) {
        const lastPR = prs[prs.length - 1];
        workflows.push({
            filename: `close-original-${originalPRNumber}.yml`,
            content: generateCloseOriginalWorkflowYaml(lastPR.number, originalPRNumber),
        });
    }
    return workflows;
}
//# sourceMappingURL=orchestrator.js.map