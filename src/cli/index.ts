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
  type OrchestratorCallbacks,
} from "../core/orchestrator.js";
import type { AIModel } from "../ai/client.js";
import type { SplitProposal } from "../ai/prompt.js";
import {
  closePRs,
  findDraftSplitPRsByOriginalPR,
  type CreatedPR,
} from "../github/pr.js";
import {
  getRepoFromRemote,
  parsePRIdentifier,
} from "../github/client.js";

const program = new Command();

program
  .name("prsplit")
  .description("CLI tool to split large PRs into chained PRs with AI")
  .version("0.1.0");

program
  .command("split <pr>", { isDefault: true })
  .description("Split the target PR into chained draft PRs")
  .option("--prompt <instruction>", "Additional split guidance")
  .option("--model <model>", "AI model to use (claude|codex)", "claude")
  .option("--dry-run", "Show split plan only; do not create PRs", false)
  .action(async (prIdentifier: string, opts: Record<string, unknown>) => {
    const model = opts.model as AIModel;
    const dryRun = opts.dryRun as boolean;
    let additionalPrompt = opts.prompt as string | undefined;

    // モデルのバリデーション
    if (!["claude", "codex"].includes(model)) {
      console.error(
        chalk.red(`Error: invalid model "${model}". Use "claude" or "codex".`)
      );
      process.exit(1);
    }

    await runSplitLoop(prIdentifier, model, dryRun, additionalPrompt);
  });

program
  .command("cleanup <pr>")
  .description("Close draft split PRs generated from the specified original PR")
  .action(async (prIdentifier: string) => {
    try {
      await runCleanup(prIdentifier);
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\nError: ${error.message}`));
        if (process.env.DEBUG) {
          console.error(error.stack);
        }
      } else {
        console.error(chalk.red("\nAn unexpected error occurred."));
      }
      process.exit(1);
    }
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
      spinner.start("Generating split proposal...");

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

      spinner.succeed(
        chalk.green(`Generated split proposal (${result.proposal.parts.length} PRs)`)
      );

      // 分割案を表示
      displayProposal(result.proposal);

      if (dryRun) {
        console.log(
          chalk.dim("\nSkipping PR creation because --dry-run is enabled.")
        );
        process.exit(0);
      }

      // ユーザーに確認
      const confirmed = await askConfirmation("Do you want to proceed? (y/n): ");

      if (confirmed) {
        // PRを作成
        spinner.start("Creating draft PRs...");

        const createdPRs = await executeSplit(
          result.proposal,
          result.owner,
          result.repo,
          result.prNumber,
          result.originalPRTitle,
          result.headBranch,
          result.baseBranch,
          result.files,
          callbacks
        );

        spinner.succeed(chalk.green("Created draft PRs"));
        displayCreatedPRs(createdPRs);
        process.exit(0);
      }

      // 再実行の指示を取得
      additionalPrompt = await askInput(
        "Enter instructions to regenerate the split: "
      );

      if (!additionalPrompt) {
        console.log(chalk.dim("Cancelled."));
        process.exit(0);
      }
    } catch (error) {
      spinner.stop();
      if (error instanceof Error) {
        console.error(chalk.red(`\nError: ${error.message}`));
        if (process.env.DEBUG) {
          console.error(error.stack);
        }
      } else {
        console.error(chalk.red("\nAn unexpected error occurred."));
      }
      process.exit(1);
    }
  }
}

async function runCleanup(prIdentifier: string): Promise<void> {
  const spinner = ora();
  spinner.start("Resolving repository and PR info...");

  const parsed = parsePRIdentifier(prIdentifier);
  let { owner, repo, number: originalPRNumber } = parsed;

  if (!owner || !repo) {
    const remote = await getRepoFromRemote();
    owner = remote.owner;
    repo = remote.repo;
  }

  spinner.text = `Searching draft split PRs from original PR #${originalPRNumber}...`;
  const targets = await findDraftSplitPRsByOriginalPR(owner, repo, originalPRNumber);
  spinner.stop();

  if (targets.length === 0) {
    console.log(
      chalk.dim(
        `No prsplit draft PRs found for original PR #${originalPRNumber}.`
      )
    );
    return;
  }

  displayCleanupTargets(targets);
  const confirmed = await askConfirmation(
    `Close ${targets.length} draft PR(s) and delete their branches? (y/n): `
  );
  if (!confirmed) {
    console.log(chalk.dim("Cancelled."));
    return;
  }

  spinner.start("Closing draft PRs...");
  await closePRs(owner, repo, targets);
  spinner.succeed(chalk.green(`Closed ${targets.length} draft PR(s).`));
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
        chalk.dim(`       ... and ${part.files.length - 3} more files`)
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

function displayCleanupTargets(prs: CreatedPR[]): void {
  console.log();
  console.log(chalk.yellow("Draft PRs to close:"));
  for (const pr of prs) {
    console.log(`  #${pr.number} ${pr.title}`);
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
