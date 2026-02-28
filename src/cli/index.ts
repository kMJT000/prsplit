#!/usr/bin/env node

/**
 * CLIエントリーポイント・コマンド定義
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createInterface } from "readline";
import {
  generateProposal,
  executeSplit,
  cleanupPRs,
  type OrchestratorCallbacks,
} from "../core/orchestrator.js";
import type { AIModel } from "../ai/client.js";
import type { SplitProposal } from "../ai/prompt.js";
import type { CreatedPR } from "../github/pr.js";
import type { DiffFile } from "../utils/diff.js";

const program = new Command();

program
  .name("prsplit")
  .description("大きなPRをAIで分割してチェーンPRを作成するCLIツール")
  .version("0.1.0")
  .argument("<pr>", "PR番号 または PR URL")
  .option("--prompt <instruction>", "追加指示（分割の方向性など）")
  .option(
    "--model <model>",
    "使用するAIモデル (claude|codex)",
    "claude"
  )
  .option("--dry-run", "分割案のみ表示、PR作成はしない", false)
  .action(async (prIdentifier: string, opts: Record<string, unknown>) => {
    const model = opts.model as AIModel;
    const dryRun = opts.dryRun as boolean;
    let additionalPrompt = opts.prompt as string | undefined;

    // モデルのバリデーション
    if (!["claude", "codex"].includes(model)) {
      console.error(
        chalk.red(`エラー: 無効なモデル "${model}"。claude または codex を指定してください。`)
      );
      process.exit(1);
    }

    await runSplitLoop(prIdentifier, model, dryRun, additionalPrompt);
  });

/**
 * 分割 → 確認 → 再実行のインタラクティブループ
 */
async function runSplitLoop(
  prIdentifier: string,
  model: AIModel,
  dryRun: boolean,
  additionalPrompt?: string
): Promise<void> {
  const spinner = ora();
  let createdPRs: CreatedPR[] | null = null;
  let context: {
    owner: string;
    repo: string;
    prNumber: number;
    headBranch: string;
    baseBranch: string;
    files: DiffFile[];
  } | null = null;

  const callbacks: OrchestratorCallbacks = {
    onProgress: (msg) => {
      spinner.text = msg;
      if (!spinner.isSpinning) spinner.start();
    },
    onProposal: () => {},
    onPRCreated: () => {},
    onError: (err) => {
      spinner.fail(err.message);
    },
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // 分割提案を生成
      spinner.start("分割案を生成中...");

      const result = await generateProposal(
        {
          prIdentifier,
          model,
          dryRun,
          additionalPrompt,
        },
        callbacks
      );

      if (!result) {
        process.exit(1);
      }

      context = {
        owner: result.owner,
        repo: result.repo,
        prNumber: result.prNumber,
        headBranch: result.headBranch,
        baseBranch: result.baseBranch,
        files: result.files,
      };

      spinner.succeed(
        chalk.green(`分割案を生成しました（${result.proposal.parts.length}PR）`)
      );

      // 分割案を表示
      displayProposal(result.proposal);

      if (dryRun) {
        console.log(
          chalk.dim("\n--dry-run モードのためPR作成はスキップします。")
        );
        process.exit(0);
      }

      // ユーザーに確認
      const confirmed = await askConfirmation("気に入りましたか？(y/n): ");

      if (confirmed) {
        // PRを作成
        spinner.start("ドラフトPRを作成中...");

        createdPRs = await executeSplit(
          result.proposal,
          result.owner,
          result.repo,
          result.prNumber,
          result.headBranch,
          result.baseBranch,
          result.files,
          callbacks
        );

        spinner.succeed(chalk.green("ドラフトPRを作成しました"));
        displayCreatedPRs(createdPRs);
        process.exit(0);
      }

      // 拒否された場合
      if (createdPRs) {
        spinner.start("ドラフトPRを削除中...");
        await cleanupPRs(
          context.owner,
          context.repo,
          createdPRs,
          callbacks
        );
        spinner.succeed(chalk.yellow("ドラフトPRを削除しました"));
        createdPRs = null;
      }

      // 再実行の指示を取得
      additionalPrompt = await askInput(
        "再実行の指示を入力してください: "
      );

      if (!additionalPrompt) {
        console.log(chalk.dim("キャンセルしました。"));
        process.exit(0);
      }
    } catch (error) {
      spinner.stop();
      if (error instanceof Error) {
        console.error(chalk.red(`\nエラー: ${error.message}`));
        if (process.env.DEBUG) {
          console.error(error.stack);
        }
      } else {
        console.error(chalk.red("\n予期しないエラーが発生しました。"));
      }
      process.exit(1);
    }
  }
}

/**
 * 分割提案を表示する
 */
function displayProposal(proposal: SplitProposal): void {
  console.log();
  for (const part of proposal.parts) {
    const orderLabel = chalk.cyan(`  ${part.order}.`);
    const branchLabel = chalk.bold(part.branchName);
    const fileCount = chalk.dim(`(${part.files.length} files)`);

    console.log(`${orderLabel} ${branchLabel} ${fileCount}`);
    console.log(chalk.dim(`     ${part.title}`));

    if (part.files.length <= 5) {
      for (const file of part.files) {
        console.log(chalk.dim(`       - ${file}`));
      }
    } else {
      for (const file of part.files.slice(0, 3)) {
        console.log(chalk.dim(`       - ${file}`));
      }
      console.log(
        chalk.dim(`       ... 他 ${part.files.length - 3} ファイル`)
      );
    }
  }
  console.log();
}

/**
 * 作成されたPR一覧を表示する
 */
function displayCreatedPRs(prs: CreatedPR[]): void {
  console.log();
  for (const pr of prs) {
    console.log(
      `  ${chalk.green("✓")} #${pr.number} ${pr.title}`
    );
    console.log(chalk.dim(`    ${pr.htmlUrl}`));
  }
  console.log();
}

/**
 * Y/N確認
 */
function askConfirmation(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(prompt, (answer) => {
      rl.close();
      resolve(
        answer.trim().toLowerCase() === "y" ||
          answer.trim().toLowerCase() === "yes"
      );
    });
  });
}

/**
 * テキスト入力
 */
function askInput(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

program.parse();
