/**
 * Claude/Codex切り替えクライアント
 */
export type AIModel = "claude" | "codex";
export interface AIClient {
    complete(systemPrompt: string, userPrompt: string): Promise<string>;
}
/**
 * 指定モデルのAIクライアントを取得する
 */
export declare function getAIClient(model: AIModel): Promise<AIClient>;
//# sourceMappingURL=client.d.ts.map