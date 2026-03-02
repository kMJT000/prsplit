import { beforeAll, describe, expect, it } from "vitest";
import { getAIClient, type AIModel } from "../../src/ai/client.js";
import { generateSplitProposal } from "../../src/ai/splitter.js";
import { parsePRIdentifier, getRepoFromRemote } from "../../src/github/client.js";
import { getPRFiles, getPRInfo } from "../../src/github/pr.js";
import type { DiffFile } from "../../src/utils/diff.js";
import { assertSplitProposalInvariants } from "../helpers/proposal-invariants.js";

const shouldRun = process.env.RUN_REAL_LLM_TESTS === "1";
const testSuite = shouldRun ? describe : describe.skip;

type E2EContext = {
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  prBody: string | null;
  diffFiles: DiffFile[];
};

let context: E2EContext;

testSuite("real LLM split proposal e2e", () => {
  beforeAll(async () => {
    expect(process.env.GITHUB_TOKEN).toBeTruthy();
    expect(process.env.ANTHROPIC_API_KEY).toBeTruthy();
    expect(process.env.OPENAI_API_KEY).toBeTruthy();
    expect(process.env.PRSPLIT_TEST_PR).toBeTruthy();

    const input = process.env.PRSPLIT_TEST_PR as string;
    let { owner, repo, number: prNumber } = parsePRIdentifier(input);

    if (!owner || !repo) {
      const remote = await getRepoFromRemote();
      owner = remote.owner;
      repo = remote.repo;
    }

    const prInfo = await getPRInfo(owner, repo, prNumber);
    expect(prInfo.state).toBe("open");

    const prFiles = await getPRFiles(owner, repo, prNumber);
    expect(prFiles.length).toBeGreaterThan(0);

    context = {
      owner,
      repo,
      prNumber,
      prTitle: prInfo.title,
      prBody: prInfo.body,
      diffFiles: prFiles.map((file) => ({
        filename: file.filename,
        status: file.status,
        patch: file.patch,
        previousFilename: file.previousFilename,
      })),
    };
  }, 120000);

  for (const model of ["claude", "codex"] as AIModel[]) {
    it(
      `${model} で split proposal の不変条件を満たす`,
      async () => {
        const client = await getAIClient(model);
        const proposal = await generateSplitProposal(
          client,
          {
            prTitle: context.prTitle,
            prBody: context.prBody,
            files: context.diffFiles,
          },
          () => {}
        );

        assertSplitProposalInvariants(proposal, context.diffFiles);
      },
      180000
    );
  }
});
