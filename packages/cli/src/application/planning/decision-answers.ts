type DecisionAnswer = { value: string; start: number; end: number };
type DecisionBlock = {
  id: string;
  readerId: string | undefined;
  form: "heading" | "question-id";
  readerEligible: boolean;
  start: number;
  end: number;
  answers: DecisionAnswer[];
  open: boolean;
};

export function scanDecisionBlocks(text: string, { truncated }: { truncated: boolean }): { blocks: DecisionBlock[] } {
  const blocks: DecisionBlock[] = [];
  let block: DecisionBlock | undefined;
  let answer: DecisionAnswer | undefined;
  let values: string[] = [];
  let blanks = 0;
  let offset = 0;
  for (const raw of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const start = offset;
    offset += raw.length;
    const line = raw.endsWith("\n") ? raw.slice(0, raw.endsWith("\r\n") ? -2 : -1) : raw;
    if (answer !== undefined) {
      if (/^[ \t]*$/.test(line)) {
        blanks += 1;
        answer.end = offset;
        continue;
      }
      if (line.startsWith("  ")) {
        if (values.length > 0) for (let index = 0; index < blanks; index += 1) values.push("");
        blanks = 0;
        values.push(line.slice(2));
        answer.end = offset;
        continue;
      }
      answer.value = values.join("\n").trimEnd();
      answer = undefined;
    }
    const question = /^\s*Question ID:\s*(\S+)\s*$/.exec(line);
    const heading = /^\s*#{1,6}\s+([^\s:]+)\s*(?::|—|-)\s*/.exec(line);
    const id = question?.[1] ?? heading?.[1];
    const readerId = question?.[1] ?? /^\s*#{1,6}\s+([A-Za-z0-9][A-Za-z0-9_.-]*)\s*(?::|—|-)\s*.+$/.exec(line)?.[1];
    if (id !== undefined) {
      if (block !== undefined) block.end = start;
      block = {
        id, readerId, form: question ? "question-id" : "heading",
        readerEligible: readerId !== undefined,
        start, end: text.length, answers: [], open: false,
      };
      blocks.push(block);
      continue;
    }
    const match = /^\s*Answer:(.*)$/.exec(line);
    if (block !== undefined && match !== null) {
      const inline = (match[1] ?? "").trim();
      values = inline ? [inline] : [];
      blanks = 0;
      answer = { value: inline, start, end: offset };
      block.answers.push(answer);
    }
  }
  if (answer !== undefined) answer.value = values.join("\n").trimEnd();
  if (truncated && answer !== undefined && block !== undefined) block.open = true;
  return { blocks };
}
