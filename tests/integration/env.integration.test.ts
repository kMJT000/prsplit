import { afterEach, describe, expect, it } from "vitest";
import { getAIClient } from "../../src/ai/client.js";
import { getOctokit } from "../../src/github/client.js";

const ORIGINAL_ENV = { ...process.env };

describe("environment guard rails", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("GITHUB_TOKEN が未設定なら明確なエラーを返す", () => {
    delete process.env.GITHUB_TOKEN;
    expect(() => getOctokit()).toThrow("GITHUB_TOKEN is not set.");
  });

  it("claude選択時に ANTHROPIC_API_KEY が未設定なら失敗する", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(getAIClient("claude")).rejects.toThrow(
      "ANTHROPIC_API_KEY is not set."
    );
  });

  it("codex選択時に OPENAI_API_KEY が未設定なら失敗する", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(getAIClient("codex")).rejects.toThrow(
      "OPENAI_API_KEY is not set."
    );
  });
});
