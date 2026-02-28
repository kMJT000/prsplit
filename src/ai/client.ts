/**
 * Claude/OpenAI切り替えクライアント
 */

export type AIModel = "claude" | "openai";

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
      "ANTHROPIC_API_KEY is not set.\n" +
        "Set it with: export ANTHROPIC_API_KEY=sk-ant-xxxxx"
    );
  }

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  return {
    async complete(systemPrompt: string, userPrompt: string): Promise<string> {
      const message = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });

      const textBlock = message.content.find((block) => block.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("AI response does not contain text content.");
      }
      return textBlock.text;
    },
  };
}

/**
 * OpenAI クライアント
 */
async function createOpenAIClient(): Promise<AIClient> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set.\n" +
        "Set it with: export OPENAI_API_KEY=sk-xxxxx"
    );
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  return {
    async complete(systemPrompt: string, userPrompt: string): Promise<string> {
      const response = await client.responses.create({
        model: "gpt-5.3-codex",
        max_output_tokens: 8192,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });

      const content = response.output_text;
      if (!content) {
        throw new Error("AI response does not contain text content.");
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
    case "openai":
      return createOpenAIClient();
    default:
      throw new Error(`Unsupported model: ${model}`);
  }
}
