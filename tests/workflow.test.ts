import { describe, expect, it } from "vitest";
import {
  generateCloseOriginalWorkflowYaml,
  generateWorkflowYaml,
} from "../src/github/workflow.js";

describe("generateWorkflowYaml", () => {
  it("次PRのbaseを元PRのbaseへ更新し、最新差分を取り込んでからReady化する", () => {
    const yaml = generateWorkflowYaml({
      watchPRNumber: 10,
      nextPRNumber: 11,
      originalBaseBranch: "main",
      name: "#10 -> #11",
    });

    expect(yaml).toContain("github.event.pull_request.number == 10");
    expect(yaml).toContain('const originalBaseBranch = "main";');
    expect(yaml).toContain("await github.rest.pulls.update({");
    expect(yaml).toContain("pull_number: nextPRNumber,");
    expect(yaml).toContain("base: originalBaseBranch,");
    expect(yaml).toContain("await github.rest.pulls.updateBranch({");
    expect(yaml).toContain("expected_head_sha: nextPR.head.sha,");
    expect(yaml).toContain("error.status === 422");
    expect(yaml).toContain("markPullRequestReadyForReview");
  });
});

describe("generateCloseOriginalWorkflowYaml", () => {
  it("最終PRマージ時に元PRをcloseし、生成したworkflowを自動削除するyamlを生成する", () => {
    const yaml = generateCloseOriginalWorkflowYaml(20, 5, "main", [
      "chain-20-to-21.yml",
      "close-original-5.yml",
    ]);

    expect(yaml).toContain("github.event.pull_request.number == 20");
    expect(yaml).toContain("pull_number: 5");
    expect(yaml).toContain("state: 'closed'");
    expect(yaml).toContain("contents: write");
    expect(yaml).toContain('const originalBaseBranch = "main";');
    expect(yaml).toContain("chain-20-to-21.yml");
    expect(yaml).toContain("close-original-5.yml");
    expect(yaml).toContain("await github.rest.repos.getContent({");
    expect(yaml).toContain("await github.rest.repos.deleteFile({");
    expect(yaml).toContain("error.status === 404");
  });
});
