import { describe, expect, it } from "vitest";
import { isOnlyToolMarkup, stripToolMarkup } from "./toolMarkup";

describe("stripToolMarkup (S16)", () => {
  it("leaves normal text untouched", () => {
    const text = "Here is a table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nUse `a < b` and <b>.";
    expect(stripToolMarkup(text)).toBe(text);
  });

  it("removes a DeepSeek DSML function_calls block", () => {
    const text =
      'Let me check.\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="fs_read">\n<｜DSML｜parameter name="path" string="true">/a.txt</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>\nDone.';
    expect(stripToolMarkup(text)).toBe("Let me check.\n\nDone.");
  });

  it("removes DeepSeek tool-call token blocks (fullwidth and ascii variants)", () => {
    const full =
      "Ok<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>fs_list\n```json\n{}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜> after";
    expect(stripToolMarkup(full)).toBe("Ok after");
    const ascii = "Ok<|tool_calls_begin|><|tool_call_begin|>x<|tool_call_end|><|tool_calls_end|>";
    expect(stripToolMarkup(ascii)).toBe("Ok");
  });

  it("removes <tool_call> and function_calls blocks", () => {
    expect(stripToolMarkup('A<tool_call>{"name":"x","arguments":{}}</tool_call>B')).toBe("AB");
    expect(stripToolMarkup("A<function_calls><invoke/></function_calls>B")).toBe("AB");
  });

  it("removes an unterminated trailing block while streaming", () => {
    const streaming = { streaming: true };
    expect(stripToolMarkup('Working on it.\n<tool_call>{"name": "fs_wr', streaming)).toBe("Working on it.");
    expect(stripToolMarkup("Hi <｜DSML｜function_calls>\n<｜DSML｜inv", streaming)).toBe("Hi");
  });

  it("always removes unterminated model-native token blocks", () => {
    expect(stripToolMarkup("Hi <｜DSML｜function_calls>\n<｜DSML｜inv")).toBe("Hi");
    expect(stripToolMarkup("Ok<｜tool▁calls▁begin｜>function")).toBe("Ok");
  });

  it("keeps prose that merely mentions plain tool tags in a finished answer", () => {
    const text = "Qwen emits `<tool_call>` tags, then the arguments as JSON.";
    expect(stripToolMarkup(text)).toBe(text);
    expect(stripToolMarkup("x <f")).toBe("x <f");
  });

  it("hides a half-received opening token at the end of a draft", () => {
    const streaming = { streaming: true };
    expect(stripToolMarkup("Sure <｜DSM", streaming)).toBe("Sure");
    expect(stripToolMarkup("Sure <tool_ca", streaming)).toBe("Sure");
    expect(stripToolMarkup("Sure <|tool", streaming)).toBe("Sure");
  });

  it("does not eat a lone < in prose", () => {
    expect(stripToolMarkup("x <", { streaming: true })).toBe("x <");
    expect(stripToolMarkup("if a <b then", { streaming: true })).toBe("if a <b then");
  });

  it("removes stray tokens", () => {
    expect(stripToolMarkup("Hello<｜end▁of▁sentence｜>")).toBe("Hello");
    expect(stripToolMarkup("A</｜DSML｜invoke>B")).toBe("AB");
  });

  it("detects content that is only markup", () => {
    expect(isOnlyToolMarkup("<tool_call>{}</tool_call>")).toBe(true);
    expect(isOnlyToolMarkup("text")).toBe(false);
    expect(isOnlyToolMarkup("")).toBe(false);
  });
});
