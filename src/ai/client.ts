/**
 * Claude/Codex切り替えクライアント
 */

export type AIModel = "claude" | "codex";

export interface AIClient {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

/**
 * Claudeクライアント
 */
async function createClaudeClient(): Promise<AIClient> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY が設定されていません。\n" +
        "export ANTHROPIC_API_KEY=sk-ant-xxxxx で設定してください。"
    );
  }

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  return {
    async complete(systemPrompt: string, userPrompt: string): Promise<string> {
      const message = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });

      const textBlock = message.content.find((block) => block.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("AIからのレスポンスにテキストが含まれていません。");
      }
      return textBlock.text;
    },
  };
}

/**
 * Codex (OpenAI) クライアント
 */
async function createCodexClient(): Promise<AIClient> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY が設定されていません。\n" +
        "export OPENAI_API_KEY=sk-xxxxx で設定してください。"
    );
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  return {
    async complete(systemPrompt: string, userPrompt: string): Promise<string> {
      const response = await client.chat.completions.create({
        model: "gpt-4o",
        max_tokens: 8192,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("AIからのレスポンスにテキストが含まれていません。");
      }
      return content;
    },
  };
}

/**
 * 指定モデルのAIクライアントを取得する
 */
export async function getAIClient(model: AIModel): Promise<AIClient> {
  switch (model) {
    case "claude":
      return createClaudeClient();
    case "codex":
      return createCodexClient();
    default:
      throw new Error(`未対応のモデル: ${model}`);
  }
}
