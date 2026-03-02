import { expect } from "vitest";
import type { SplitProposal } from "../../src/ai/prompt.js";
import type { DiffFile } from "../../src/utils/diff.js";

const NON_ENGLISH_CHAR_REGEX = /[ぁ-んァ-ン一-龠々〆ヵヶ]/;

export function assertSplitProposalInvariants(
  proposal: SplitProposal,
  originalFiles: DiffFile[]
): void {
  expect(Array.isArray(proposal.parts)).toBe(true);
  expect(proposal.parts.length).toBeGreaterThan(0);

  const expectedOrder = [...proposal.parts]
    .map((part) => part.order)
    .sort((a, b) => a - b);
  for (let i = 0; i < expectedOrder.length; i++) {
    expect(expectedOrder[i]).toBe(i + 1);
  }

  const originalFileSet = new Set(originalFiles.map((file) => file.filename));
  const seen = new Set<string>();

  for (const part of proposal.parts) {
    expect(part.branchName.length).toBeGreaterThan(0);
    expect(part.title.length).toBeGreaterThan(0);
    expect(Array.isArray(part.files)).toBe(true);
    expect(part.files.length).toBeGreaterThan(0);

    assertEnglishOutput(part.title);
    assertEnglishOutput(part.description);
    assertEnglishOutput(part.rationale);

    for (const filename of part.files) {
      expect(originalFileSet.has(filename)).toBe(true);
      expect(seen.has(filename)).toBe(false);
      seen.add(filename);
    }
  }

  expect(seen.size).toBe(originalFileSet.size);
  for (const originalFilename of originalFileSet) {
    expect(seen.has(originalFilename)).toBe(true);
  }
}

function assertEnglishOutput(text: string): void {
  expect(text.trim().length).toBeGreaterThan(0);
  expect(NON_ENGLISH_CHAR_REGEX.test(text)).toBe(false);
}
