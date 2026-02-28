/**
 * diff分割ユーティリティ
 * 大きなdiffをAIに送信可能なサイズに分割する
 */
export interface DiffFile {
    filename: string;
    patch: string;
    status: string;
}
/**
 * PRのdiffをファイル単位に分解する
 */
export declare function parseDiffFiles(rawDiff: string): DiffFile[];
/**
 * diffファイルをAIのコンテキストウィンドウに収まるチャンクに分割する
 */
export declare function chunkDiffFiles(files: DiffFile[], maxChars?: number): DiffFile[][];
/**
 * diffの統計情報を取得
 */
export declare function getDiffStats(files: DiffFile[]): {
    totalFiles: number;
    additions: number;
    deletions: number;
};
//# sourceMappingURL=diff.d.ts.map