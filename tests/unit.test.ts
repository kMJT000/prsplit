import { describe, it, expect } from "vitest";
import {
  parseDiffFiles,
  chunkDiffFiles,
  getDiffStats,
  type DiffFile,
} from "../src/utils/diff.js";
import { parseAIResponse, buildSplitPrompt } from "../src/ai/prompt.js";
import {
  suggestFilesForBuildRepair,
  validateProposal,
} from "../src/ai/splitter.js";
import { parsePRIdentifier } from "../src/github/client.js";

describe("parseDiffFiles", () => {
  it("複数ファイルのdiffをパースする", () => {
    const raw = `diff --git a/src/model.ts b/src/model.ts
index abc..def 100644
--- a/src/model.ts
+++ b/src/model.ts
@@ -1,3 +1,5 @@
+import { z } from "zod";
 export interface User {
   id: string;
+  email: string;
 }
diff --git a/src/api.ts b/src/api.ts
new file mode 100644
--- /dev/null
+++ b/src/api.ts
@@ -0,0 +1,3 @@
+export function getUser() {
+  return {};
+}`;

    const files = parseDiffFiles(raw);
    expect(files).toHaveLength(2);
    expect(files[0].filename).toBe("src/model.ts");
    expect(files[0].status).toBe("modified");
    expect(files[1].filename).toBe("src/api.ts");
    expect(files[1].status).toBe("added");
  });

  it("削除されたファイルを検出する", () => {
    const raw = `diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export const old = true;`;

    const files = parseDiffFiles(raw);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe("removed");
  });

  it("renameされたファイルで旧パスを保持する", () => {
    const raw = `diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts`;

    const files = parseDiffFiles(raw);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe("renamed");
    expect(files[0].previousFilename).toBe("src/old.ts");
    expect(files[0].filename).toBe("src/new.ts");
  });

  it("空のdiffは空配列を返す", () => {
    expect(parseDiffFiles("")).toHaveLength(0);
  });
});

describe("chunkDiffFiles", () => {
  it("小さいファイルは1チャンクにまとめる", () => {
    const files: DiffFile[] = [
      { filename: "a.ts", patch: "x".repeat(100), status: "modified" },
      { filename: "b.ts", patch: "x".repeat(100), status: "modified" },
    ];

    const chunks = chunkDiffFiles(files, 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  it("大きいファイルは別チャンクに分割する", () => {
    const files: DiffFile[] = [
      { filename: "a.ts", patch: "x".repeat(300), status: "modified" },
      { filename: "b.ts", patch: "x".repeat(300), status: "modified" },
    ];

    const chunks = chunkDiffFiles(files, 400);
    expect(chunks).toHaveLength(2);
  });

  it("1ファイルで上限超えの場合はそのファイルだけで1チャンク", () => {
    const files: DiffFile[] = [
      { filename: "small.ts", patch: "x".repeat(10), status: "modified" },
      { filename: "huge.ts", patch: "x".repeat(1000), status: "modified" },
      { filename: "small2.ts", patch: "x".repeat(10), status: "modified" },
    ];

    const chunks = chunkDiffFiles(files, 100);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(1);
    expect(chunks[0][0].filename).toBe("small.ts");
    expect(chunks[1]).toHaveLength(1);
    expect(chunks[1][0].filename).toBe("huge.ts");
    expect(chunks[2]).toHaveLength(1);
    expect(chunks[2][0].filename).toBe("small2.ts");
  });
});

describe("getDiffStats", () => {
  it("追加・削除行数をカウントする", () => {
    const files: DiffFile[] = [
      {
        filename: "a.ts",
        patch: `--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
+const c = 3;
-const old = 0;`,
        status: "modified",
      },
    ];

    const stats = getDiffStats(files);
    expect(stats.totalFiles).toBe(1);
    expect(stats.additions).toBe(2);
    expect(stats.deletions).toBe(1);
  });
});

describe("parseAIResponse", () => {
  it("正常なJSONをパースする", () => {
    const response = `{
      "parts": [
        {
          "order": 1,
          "branchName": "feat/db-layer",
          "title": "DB変更",
          "description": "DBマイグレーション",
          "files": ["migration.sql"],
          "rationale": "DB先行"
        }
      ]
    }`;

    const result = parseAIResponse(response);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].branchName).toBe("feat/db-layer");
  });

  it("コードブロック内のJSONをパースする", () => {
    const response = `分析結果:
\`\`\`json
{
  "parts": [
    {
      "order": 1,
      "branchName": "feat/api",
      "title": "API追加",
      "description": "API",
      "files": ["api.ts"],
      "rationale": "API先行"
    }
  ]
}
\`\`\``;

    const result = parseAIResponse(response);
    expect(result.parts).toHaveLength(1);
  });

  it("不正なJSONでエラーを投げる", () => {
    expect(() => parseAIResponse("not json")).toThrow();
  });

  it("parts配列がない場合エラーを投げる", () => {
    expect(() => parseAIResponse('{"data": []}')).toThrow(
      "parts"
    );
  });
});

describe("validateProposal", () => {
  const originalFiles: DiffFile[] = [
    { filename: "a.ts", patch: "", status: "modified" },
    { filename: "b.ts", patch: "", status: "added" },
    { filename: "c.ts", patch: "", status: "modified" },
  ];

  it("正常な分割案をバリデーションする", () => {
    const result = validateProposal(
      {
        parts: [
          {
            order: 1,
            branchName: "feat/part1",
            title: "Part1",
            description: "",
            files: ["a.ts"],
            rationale: "",
          },
          {
            order: 2,
            branchName: "feat/part2",
            title: "Part2",
            description: "",
            files: ["b.ts", "c.ts"],
            rationale: "",
          },
        ],
      },
      originalFiles
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("ファイルが欠けている場合エラーを返す", () => {
    const result = validateProposal(
      {
        parts: [
          {
            order: 1,
            branchName: "feat/part1",
            title: "Part1",
            description: "",
            files: ["a.ts"],
            rationale: "",
          },
        ],
      },
      originalFiles
    );

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("ファイルが重複している場合エラーを返す", () => {
    const result = validateProposal(
      {
        parts: [
          {
            order: 1,
            branchName: "feat/part1",
            title: "Part1",
            description: "",
            files: ["a.ts", "b.ts"],
            rationale: "",
          },
          {
            order: 2,
            branchName: "feat/part2",
            title: "Part2",
            description: "",
            files: ["b.ts", "c.ts"],
            rationale: "",
          },
        ],
      },
      originalFiles
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("multiple split PRs"))).toBe(true);
  });
});

describe("parsePRIdentifier", () => {
  it("PR URLをパースする", () => {
    const result = parsePRIdentifier(
      "https://github.com/owner/repo/pull/123"
    );
    expect(result.owner).toBe("owner");
    expect(result.repo).toBe("repo");
    expect(result.number).toBe(123);
  });

  it("PR番号のみをパースする", () => {
    const result = parsePRIdentifier("456");
    expect(result.number).toBe(456);
    expect(result.owner).toBe("");
    expect(result.repo).toBe("");
  });

  it("無効な入力でエラーを投げる", () => {
    expect(() => parsePRIdentifier("invalid")).toThrow("Invalid PR identifier");
  });
});

describe("buildSplitPrompt", () => {
  it("プロンプトにPR情報とdiffを含む", () => {
    const files: DiffFile[] = [
      { filename: "test.ts", patch: "+line1\n-line2", status: "modified" },
    ];

    const prompt = buildSplitPrompt("Test PR", "Test body", files);
    expect(prompt).toContain("Test PR");
    expect(prompt).toContain("Test body");
    expect(prompt).toContain("test.ts");
  });

  it("追加指示を含める", () => {
    const files: DiffFile[] = [
      { filename: "test.ts", patch: "", status: "modified" },
    ];

    const prompt = buildSplitPrompt(
      "Test PR",
      null,
      files,
      "ロジック層を細かく"
    );
    expect(prompt).toContain("Additional Instructions");
    expect(prompt).toContain("ロジック層を細かく");
  });
});

describe("suggestFilesForBuildRepair", () => {
  it("AIレスポンスのfilesToMoveを配列として返す", async () => {
    const mockClient = {
      complete: async () => '{"filesToMove":["src/types/user.ts","src/services/user.ts"]}',
    };

    const result = await suggestFilesForBuildRepair(mockClient, {
      failingPartOrder: 2,
      failingPartTitle: "feat: service layer",
      currentPartFiles: ["src/services/order.ts"],
      candidateFilesByPart: [
        {
          order: 3,
          title: "feat: api layer",
          files: ["src/types/user.ts", "src/services/user.ts"],
        },
      ],
      failureSummary: "build-and-test failed",
    });

    expect(result).toEqual(["src/types/user.ts", "src/services/user.ts"]);
  });

  it("コードブロック内JSONもパースできる", async () => {
    const mockClient = {
      complete: async () =>
        '```json\n{"filesToMove":["src/shared/errors.ts"]}\n```',
    };

    const result = await suggestFilesForBuildRepair(mockClient, {
      failingPartOrder: 1,
      failingPartTitle: "feat: db layer",
      currentPartFiles: ["src/db/migration.ts"],
      candidateFilesByPart: [
        {
          order: 2,
          title: "feat: logic layer",
          files: ["src/shared/errors.ts"],
        },
      ],
      failureSummary: "tests failed",
    });

    expect(result).toEqual(["src/shared/errors.ts"]);
  });
});
