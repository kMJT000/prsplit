import { describe, expect, it } from "vitest";
import { parsePRIdentifier } from "../../src/github/client.js";

const shouldRun = process.env.RUN_MANUAL_GITHUB_E2E === "1";
const suite = shouldRun ? describe : describe.skip;

suite("manual GitHub e2e preflight", () => {
  it("手動E2Eに必要な環境変数を満たす", () => {
    expect(process.env.GITHUB_TOKEN).toBeTruthy();
    expect(process.env.PRSPLIT_TEST_PR).toBeTruthy();
    expect(process.env.PRSPLIT_TEST_REPO_FULL_NAME).toBeTruthy();

    const parsed = parsePRIdentifier(process.env.PRSPLIT_TEST_PR as string);
    expect(parsed.number).toBeGreaterThan(0);
  });
});
