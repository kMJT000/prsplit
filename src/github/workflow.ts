/**
 * GitHub Actions workflow 生成・コミット
 */

import { getOctokit } from "./client.js";

export interface ChainWorkflowOptions {
  watchPRNumber: number;
  nextPRNumber: number;
  name: string;
}

/**
 * 指定PRのマージを検知して、次のPRをReady for reviewにするワークフローを生成する
 */
export function generateWorkflowYaml(options: ChainWorkflowOptions): string {
  const { watchPRNumber, nextPRNumber, name } = options;
  const condition =
    "${{ github.event.pull_request.merged == true && github.event.pull_request.number == " +
    watchPRNumber +
    " }}";

  return [
    `name: prsplit chain ${name}`,
    "",
    "on:",
    "  pull_request:",
    "    types: [closed]",
    "",
    "permissions:",
    "  pull-requests: write",
    "  contents: read",
    "",
    "jobs:",
    "  undraft-next-pr:",
    `    if: ${condition}`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Mark next PR ready for review",
    "        uses: actions/github-script@v7",
    "        with:",
    "          script: |",
    `            const nextPRNumber = ${nextPRNumber};`,
    "            const { data: nextPR } = await github.rest.pulls.get({",
    "              owner: context.repo.owner,",
    "              repo: context.repo.repo,",
    "              pull_number: nextPRNumber,",
    "            });",
    "",
    "            await github.graphql(",
    "              `mutation($pullRequestId: ID!) {",
    "                markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {",
    "                  pullRequest {",
    "                    number",
    "                    isDraft",
    "                  }",
    "                }",
    "              }`,",
    "              { pullRequestId: nextPR.node_id }",
    "            );",
  ].join("\n");
}

/**
 * 最終PRのマージを検知して、元PRをcloseするワークフローを生成する
 */
export function generateCloseOriginalWorkflowYaml(
  watchPRNumber: number,
  originalPRNumber: number
): string {
  const condition =
    "${{ github.event.pull_request.merged == true && github.event.pull_request.number == " +
    watchPRNumber +
    " }}";

  return [
    `name: prsplit close original #${originalPRNumber}`,
    "",
    "on:",
    "  pull_request:",
    "    types: [closed]",
    "",
    "permissions:",
    "  pull-requests: write",
    "  contents: read",
    "",
    "jobs:",
    "  close-original-pr:",
    `    if: ${condition}`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Close original PR",
    "        uses: actions/github-script@v7",
    "        with:",
    "          script: |",
    "            await github.rest.pulls.update({",
    "              owner: context.repo.owner,",
    "              repo: context.repo.repo,",
    `              pull_number: ${originalPRNumber},`,
    "              state: 'closed',",
    "            });",
  ].join("\n");
}

/**
 * 生成したワークフロー群を指定ブランチへ1コミットで反映する
 */
export async function commitWorkflows(
  owner: string,
  repo: string,
  branchName: string,
  workflows: Array<{ filename: string; content: string }>
): Promise<void> {
  if (workflows.length === 0) {
    return;
  }

  const octokit = getOctokit();
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branchName}`,
  });
  const baseSha = ref.object.sha;

  const tree = await Promise.all(
    workflows.map(async (workflow) => {
      const { data: blob } = await octokit.rest.git.createBlob({
        owner,
        repo,
        content: workflow.content,
        encoding: "utf-8",
      });

      return {
        path: `.github/workflows/${workflow.filename}`,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
      };
    })
  );

  const { data: createdTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseSha,
    tree,
  });

  const { data: commit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: "chore: add prsplit chain workflows",
    tree: createdTree.sha,
    parents: [baseSha],
  });

  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branchName}`,
    sha: commit.sha,
  });
}
