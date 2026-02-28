/**
 * diff分割ユーティリティ
 * 大きなdiffをAIに送信可能なサイズに分割する
 */
/** 1チャンクの最大トークン数（概算: 1トークン ≈ 4文字） */
const MAX_CHUNK_CHARS = 80_000; // ≈ 20,000 tokens
/**
 * PRのdiffをファイル単位に分解する
 */
export function parseDiffFiles(rawDiff) {
    const files = [];
    const filePattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
    const matches = [...rawDiff.matchAll(filePattern)];
    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const nextMatch = matches[i + 1];
        const start = match.index;
        const end = nextMatch ? nextMatch.index : rawDiff.length;
        const patch = rawDiff.slice(start, end).trim();
        const filename = match[2];
        let status = "modified";
        if (patch.includes("new file mode"))
            status = "added";
        else if (patch.includes("deleted file mode"))
            status = "removed";
        else if (match[1] !== match[2])
            status = "renamed";
        files.push({ filename, patch, status });
    }
    return files;
}
/**
 * diffファイルをAIのコンテキストウィンドウに収まるチャンクに分割する
 */
export function chunkDiffFiles(files, maxChars = MAX_CHUNK_CHARS) {
    const chunks = [];
    let current = [];
    let currentSize = 0;
    for (const file of files) {
        const fileSize = file.patch.length;
        // 1ファイルで上限を超える場合はそのファイルだけで1チャンク
        if (fileSize > maxChars) {
            if (current.length > 0) {
                chunks.push(current);
                current = [];
                currentSize = 0;
            }
            chunks.push([file]);
            continue;
        }
        if (currentSize + fileSize > maxChars && current.length > 0) {
            chunks.push(current);
            current = [];
            currentSize = 0;
        }
        current.push(file);
        currentSize += fileSize;
    }
    if (current.length > 0) {
        chunks.push(current);
    }
    return chunks;
}
/**
 * diffの統計情報を取得
 */
export function getDiffStats(files) {
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
        const lines = file.patch.split("\n");
        for (const line of lines) {
            if (line.startsWith("+") && !line.startsWith("+++"))
                additions++;
            if (line.startsWith("-") && !line.startsWith("---"))
                deletions++;
        }
    }
    return { totalFiles: files.length, additions, deletions };
}
//# sourceMappingURL=diff.js.map