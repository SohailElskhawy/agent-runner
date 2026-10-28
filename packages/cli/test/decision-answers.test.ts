import { describe, expect, it } from "vitest";
import { scanDecisionBlocks } from "../src/application/planning/decision-answers.js";

describe("decision answer scanner", () => {
  it("normalizes multiline answers and preserves block and answer offsets across CRLF and EOF", () => {
    const text = "header\r\n### A: prompt\r\nAnswer: inline  \r\n  first\r\n\t\r\n \r\n    nested\r\n  ### looks like a heading\r\n  Question ID: fake\r\n  Answer: fake\r\n\r\nWhy: done\r\nQuestion ID: B\r\nAnswer:\r\n \r\n  body\r\n\r\n  next";
    const { blocks } = scanDecisionBlocks(text, { truncated: false });
    expect(blocks.map(({ id, form, readerEligible }) => ({ id, form, readerEligible }))).toEqual([
      { id: "A", form: "heading", readerEligible: true }, { id: "B", form: "question-id", readerEligible: true },
    ]);
    expect(blocks[0]?.answers[0]?.value).toBe("inline\nfirst\n\n\n  nested\n### looks like a heading\nQuestion ID: fake\nAnswer: fake");
    expect(blocks[1]?.answers[0]?.value).toBe("body\n\nnext");
    expect(blocks.map((block) => text.slice(block.start, block.end)).join("")).toBe(text.slice(text.indexOf("### A")));
    expect(text.slice(blocks[1]!.answers[0]!.start, blocks[1]!.answers[0]!.end)).toBe("Answer:\r\n \r\n  body\r\n\r\n  next");
    expect(blocks.every((block) => !block.open)).toBe(true);
  });

  it("treats legacy indented markers outside answers as boundaries and tracks every occurrence", () => {
    const text = "  ### _x: prompt\nAnswer: hidden\n\tQuestion ID: X\nAnswer: first\n\tcontent ends answer\n Answer: second\n ### X: again\nAnswer:\nOther: end\nAnswer: later\n### empty:\nAnswer: ignored\n";
    const { blocks } = scanDecisionBlocks(text, { truncated: false });
    expect(blocks.map((block) => [block.id, block.readerEligible, block.answers.map((answer) => answer.value)])).toEqual([
      ["_x", false, ["hidden"]], ["X", true, ["first", "second"]], ["X", true, ["", "later"]], ["empty", false, ["ignored"]],
    ]);
  });

  it("recognizes broader heading IDs and optional prompts without widening legacy eligibility", () => {
    const text = "### OLD: prompt\n### _hidden: prompt\nAnswer: secret\n### café: prompt\nAnswer: unicode\n### EMPTY:\nAnswer: no prompt\nQuestion ID: _id\nAnswer: valid\n";
    const { blocks } = scanDecisionBlocks(text, { truncated: false });
    expect(blocks.map((block) => [block.id, block.form, block.readerEligible])).toEqual([
      ["OLD", "heading", true], ["_hidden", "heading", false], ["café", "heading", false],
      ["EMPTY", "heading", false], ["_id", "question-id", true],
    ]);
    expect(blocks[0]?.answers).toEqual([]);
    expect(blocks.map((block) => text.slice(block.start, block.end)).join("")).toBe(text);
  });

  it("keeps writer IDs and legacy reader IDs separately", () => {
    const text = "## id-é: x\nAnswer: one\n## foo—bar: x\nAnswer: two\nQuestion ID: _id\nAnswer: three\n## _hidden: x\nAnswer: hidden\n";
    const { blocks } = scanDecisionBlocks(text, { truncated: false });
    expect(blocks.map((block) => [block.id, block.readerId, block.readerEligible])).toEqual([
      ["id-é", "id", true], ["foo—bar", "foo", true], ["_id", "_id", true], ["_hidden", undefined, false],
    ]);
    expect(blocks.map((block) => text.slice(block.start, block.end)).join("")).toBe(text);
  });

  it("re-examines one-space and tab-indented markers after an answer, but keeps two-space markers as content", () => {
    const text = "### A: prompt\nAnswer: a\n  ### fake: content\n ### B: prompt\nAnswer: b\n\tQuestion ID: C\nAnswer: c\n";
    const { blocks } = scanDecisionBlocks(text, { truncated: false });
    expect(blocks.map((block) => [block.id, block.answers[0]?.value])).toEqual([["A", "a\n### fake: content"], ["B", "b"], ["C", "c"]]);
    expect(text.slice(0, blocks[0]?.start) + blocks.map((block) => text.slice(block.start, block.end)).join("")).toBe(text);
  });

  it("marks only an answer still active at a truncated end as open", () => {
    for (const tail of ["Answer:", "Answer: value\n", "Answer: value\n \n\t\n  more\n"]) {
      expect(scanDecisionBlocks(`Question ID: X\n${tail}`, { truncated: true }).blocks[0]?.open).toBe(true);
      expect(scanDecisionBlocks(`Question ID: X\n${tail}`, { truncated: false }).blocks[0]?.open).toBe(false);
    }
    expect(scanDecisionBlocks("### X: prompt\nAnswer: value\n\tcontent", { truncated: true }).blocks[0]?.open).toBe(false);
    expect(scanDecisionBlocks("### X: prompt\n", { truncated: true }).blocks[0]?.open).toBe(false);
  });
});
