//! Tool-call markup that leaks into assistant CONTENT (S16).
//!
//! Why this exists: the inference server is expected to parse the model's
//! native tool-call syntax into OpenAI `delta.tool_calls`. When the served
//! model's server-side tool parser is missing or does not match the model's
//! output format, the raw markup arrives as plain content instead, for
//! example DeepSeek's DSML:
//!
//! ```text
//! <|DSML|calls>
//!   <|DSML|invoke name="replace_file">
//!     <|DSML|parameter name="path" string="true">/a/b.html</|DSML|parameter>
//!   </|DSML|invoke>
//! </|DSML|calls>
//! ```
//!
//! The chat then showed that text to the user and never ran the tool. This
//! module makes tool calling work REGARDLESS of the server parser:
//! - [`MarkupFilter`] is a streaming filter over content deltas: DSML
//!   blocks are held back, never emitted as text, and converted into real
//!   tool calls ([`MarkupCall`]) when the block closes. Text around the
//!   block flows through unchanged. A possible tag start split across
//!   deltas is held until it can be decided (bounded).
//! - [`sanitize_for_ui`] is defense in depth for any UI-bound or persisted
//!   text: it strips residual DSML tags/blocks and DeepSeek's native
//!   `<｜tool▁…｜>` tokens.
//!
//! Grammar (whitespace-tolerant, `|` or fullwidth `｜`, `DSML` any case):
//! `<|DSML|calls>`, `<|DSML|invoke name="X">`,
//! `<|DSML|parameter name="Y" string="true|false">V</|DSML|parameter>`,
//! `</|DSML|invoke>`, `</|DSML|calls>`. `string="true"` values are taken
//! verbatim; `string="false"` values are parsed as JSON (falling back to the
//! raw string). Only COMPLETE invokes become calls: a truncated invoke is
//! dropped rather than executed with partial arguments.

/// A tool call recovered from content markup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkupCall {
    pub name: String,
    /// JSON object text, like OpenAI `function.arguments`.
    pub arguments: String,
}

/// Longest possible tag held back while undecided (bytes). A `<` that does
/// not resolve into a DSML tag within this window is emitted as text.
const MAX_PENDING_TAG: usize = 512;

fn is_bar(ch: char) -> bool {
    ch == '|' || ch == '｜'
}

/// Consumes one or two bar separators. DeepSeek's live DSML uses DOUBLED
/// fullwidth bars (`<｜｜DSML｜｜ calls>`, observed 2026-11-02 in the wild);
/// the compact single-ASCII form is the documented one. Whitespace around
/// the bars is tolerated. Returns false when no bar is present (NotTag),
/// true when at least one was consumed, and None when the input ended
/// inside the run (Partial).
fn skip_bars(c: &mut Cursor) -> Option<bool> {
    let mut bars = 0;
    loop {
        match c.peek() {
            None => return if bars > 0 { Some(true) } else { None },
            Some(ch) if is_bar(ch) => {
                c.bump();
                bars += 1;
            }
            Some(_) => break,
        }
        if bars >= 2 {
            break;
        }
    }
    Some(bars > 0)
}

/// One recognized DSML tag.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Tag {
    closing: bool,
    name: String,
    attrs: Vec<(String, String)>,
    /// Byte offset just past the closing `>`.
    end: usize,
}

impl Tag {
    fn attr(&self, key: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
    }

    fn is(&self, name: &str) -> bool {
        self.name.eq_ignore_ascii_case(name)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Scan {
    Tag(Tag),
    /// The text ends while still consistent with a DSML tag.
    Partial,
    NotTag,
}

struct Cursor<'a> {
    s: &'a str,
    pos: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<char> {
        self.s[self.pos..].chars().next()
    }
    fn bump(&mut self) {
        if let Some(ch) = self.peek() {
            self.pos += ch.len_utf8();
        }
    }
    fn skip_ws(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.bump();
        }
    }
}

/// Try to read a DSML tag starting at byte `start` (which holds `<`).
fn scan_tag(s: &str, start: usize) -> Scan {
    let mut c = Cursor { s, pos: start };
    if c.peek() != Some('<') {
        return Scan::NotTag;
    }
    c.bump();
    c.skip_ws();
    let mut closing = false;
    match c.peek() {
        None => return Scan::Partial,
        Some('/') => {
            closing = true;
            c.bump();
            c.skip_ws();
        }
        Some(_) => {}
    }
    match skip_bars(&mut c) {
        None => return Scan::Partial,
        Some(false) => return Scan::NotTag,
        Some(true) => {}
    }
    c.skip_ws();
    for expected in ['D', 'S', 'M', 'L'] {
        match c.peek() {
            None => return Scan::Partial,
            Some(ch) if ch.eq_ignore_ascii_case(&expected) => c.bump(),
            Some(_) => return Scan::NotTag,
        }
    }
    c.skip_ws();
    match skip_bars(&mut c) {
        None => return Scan::Partial,
        Some(false) => return Scan::NotTag,
        Some(true) => {}
    }
    c.skip_ws();
    if c.peek() == Some('/') {
        closing = true;
        c.bump();
        c.skip_ws();
    }
    let name_start = c.pos;
    while c
        .peek()
        .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        c.bump();
    }
    if c.peek().is_none() {
        return Scan::Partial;
    }
    let name = s[name_start..c.pos].to_string();
    if name.is_empty() {
        return Scan::NotTag;
    }
    let mut attrs = Vec::new();
    loop {
        c.skip_ws();
        match c.peek() {
            None => return Scan::Partial,
            Some('>') => {
                c.bump();
                return Scan::Tag(Tag {
                    closing,
                    name,
                    attrs,
                    end: c.pos,
                });
            }
            Some('/') => {
                // Self-closing `/>`: treated like an empty element.
                c.bump();
                c.skip_ws();
                return match c.peek() {
                    None => Scan::Partial,
                    Some('>') => {
                        c.bump();
                        Scan::Tag(Tag {
                            closing,
                            name,
                            attrs,
                            end: c.pos,
                        })
                    }
                    Some(_) => Scan::NotTag,
                };
            }
            Some(ch) if ch.is_ascii_alphabetic() || ch == '_' => {
                let key_start = c.pos;
                while c
                    .peek()
                    .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
                {
                    c.bump();
                }
                let key = s[key_start..c.pos].to_string();
                c.skip_ws();
                match c.peek() {
                    None => return Scan::Partial,
                    Some('=') => c.bump(),
                    Some(_) => return Scan::NotTag,
                }
                c.skip_ws();
                let quote = match c.peek() {
                    None => return Scan::Partial,
                    Some(q @ ('"' | '\'')) => q,
                    Some(_) => return Scan::NotTag,
                };
                c.bump();
                let value_start = c.pos;
                loop {
                    match c.peek() {
                        None => return Scan::Partial,
                        Some(ch) if ch == quote => break,
                        Some(_) => c.bump(),
                    }
                }
                let value = s[value_start..c.pos].to_string();
                c.bump();
                attrs.push((key, value));
            }
            Some(_) => return Scan::NotTag,
        }
    }
}

/// Next DSML tag start at or after `from`.
enum Found {
    Tag(usize, Tag),
    /// An undecided tag start at this byte offset (needs more text).
    Partial(usize),
    None,
}

fn find_tag(s: &str, from: usize) -> Found {
    let mut search = from;
    while let Some(offset) = s[search..].find('<') {
        let index = search + offset;
        match scan_tag(s, index) {
            Scan::Tag(tag) => return Found::Tag(index, tag),
            Scan::Partial if s.len() - index <= MAX_PENDING_TAG => return Found::Partial(index),
            Scan::Partial | Scan::NotTag => search = index + 1,
        }
    }
    Found::None
}

/// Whether an undecided tail clearly started as tool markup (`<` then a
/// bar), so it is dropped rather than shown when the stream ends.
fn looks_like_markup(tail: &str) -> bool {
    let rest = tail.trim_start_matches('<').trim_start();
    let rest = rest.strip_prefix('/').unwrap_or(rest).trim_start();
    rest.chars().next().is_some_and(is_bar)
}

/// Parse the calls out of one complete (or truncated) DSML block. Only
/// invokes with a closing tag become calls.
fn parse_block(block: &str) -> Vec<MarkupCall> {
    let mut calls = Vec::new();
    let mut invoke: Option<(String, serde_json::Map<String, serde_json::Value>)> = None;
    let mut param: Option<(String, bool, usize)> = None; // (name, is_string, value start)
    let mut search = 0;
    while let Found::Tag(index, tag) = find_tag(block, search) {
        search = tag.end;
        if tag.is("invoke") && !tag.closing {
            invoke = tag
                .attr("name")
                .map(|name| (name.trim().to_string(), serde_json::Map::new()));
            param = None;
        } else if tag.is("invoke") && tag.closing {
            if let Some((name, args)) = invoke.take()
                && !name.is_empty()
            {
                calls.push(MarkupCall {
                    name,
                    arguments: serde_json::Value::Object(args).to_string(),
                });
            }
            param = None;
        } else if tag.is("parameter") && !tag.closing {
            param = tag.attr("name").map(|name| {
                let is_string = !tag
                    .attr("string")
                    .is_some_and(|flag| flag.trim().eq_ignore_ascii_case("false"));
                (name.trim().to_string(), is_string, tag.end)
            });
        } else if tag.is("parameter")
            && tag.closing
            && let (Some((name, is_string, start)), Some((_, args))) =
                (param.take(), invoke.as_mut())
            && start <= index
        {
            let raw = &block[start..index];
            let value = if is_string {
                serde_json::Value::String(raw.to_string())
            } else {
                serde_json::from_str(raw.trim())
                    .unwrap_or_else(|_| serde_json::Value::String(raw.to_string()))
            };
            args.insert(name, value);
        }
    }
    calls
}

/// Streaming content filter: emits only user-facing text, turns DSML
/// blocks into [`MarkupCall`]s.
#[derive(Debug, Default)]
pub struct MarkupFilter {
    /// Text received but not yet emitted (outside any block).
    pending: String,
    /// Inside a block: (root tag name, buffered block text, resume offset).
    block: Option<(String, String, usize)>,
    calls: Vec<MarkupCall>,
}

impl MarkupFilter {
    /// Feed one content delta; returns the text that is safe to show now.
    pub fn push(&mut self, delta: &str) -> String {
        self.pending.push_str(delta);
        self.drain()
    }

    /// End of stream: the remaining visible text and every recovered call.
    /// An unterminated block still yields its COMPLETE invokes (models
    /// sometimes stop before the outer close tag); its text never shows.
    pub fn finish(mut self) -> (String, Vec<MarkupCall>) {
        let mut out = self.drain();
        if let Some((_, buffer, _)) = self.block.take() {
            self.calls.extend(parse_block(&buffer));
        }
        if !self.pending.is_empty() && !looks_like_markup(&self.pending) {
            out.push_str(&self.pending);
        }
        (out, self.calls)
    }

    fn drain(&mut self) -> String {
        let mut out = String::new();
        loop {
            if let Some((root, buffer, resume)) = self.block.as_mut() {
                buffer.push_str(&self.pending);
                self.pending.clear();
                let mut search = *resume;
                let close_end = loop {
                    match find_tag(buffer, search) {
                        Found::Tag(_, tag) if tag.closing && tag.is(root) => break Some(tag.end),
                        Found::Tag(_, tag) => search = tag.end,
                        Found::Partial(index) => {
                            *resume = index;
                            break None;
                        }
                        Found::None => {
                            *resume = buffer.len();
                            break None;
                        }
                    }
                };
                let Some(end) = close_end else {
                    return out;
                };
                let rest = buffer.split_off(end);
                let block = std::mem::take(buffer);
                self.block = None;
                self.calls.extend(parse_block(&block));
                self.pending = rest;
                continue;
            }
            match find_tag(&self.pending, 0) {
                Found::Tag(index, tag) => {
                    out.push_str(&self.pending[..index]);
                    let rest = self.pending.split_off(index);
                    self.pending.clear();
                    // `tag.end` is an offset into the old `pending`; make it
                    // relative to `rest`, which starts at `index`.
                    let tag_len = tag.end - index;
                    let self_closing = rest[..tag_len]
                        .trim_end_matches('>')
                        .trim_end()
                        .ends_with('/');
                    if tag.closing || self_closing {
                        // Stray closing / empty tag: drop it.
                        self.pending = rest[tag_len..].to_string();
                    } else {
                        self.block = Some((tag.name, rest, tag_len));
                    }
                }
                Found::Partial(index) => {
                    // Undecided tag start: hold it (finish() decides at the
                    // end of the stream).
                    out.push_str(&self.pending[..index]);
                    let rest = self.pending.split_off(index);
                    self.pending = rest;
                    return out;
                }
                Found::None => {
                    out.push_str(&self.pending);
                    self.pending.clear();
                    return out;
                }
            }
        }
    }
}

/// DeepSeek native tool-call tokens (`<｜tool▁calls▁begin｜>` …).
const NATIVE_BEGIN: &str = "<｜tool▁calls▁begin｜>";
const NATIVE_END: &str = "<｜tool▁calls▁end｜>";
const NATIVE_TOKEN_PREFIX: &str = "<｜tool▁";

/// Defense in depth for UI-bound and persisted text: removes DSML blocks
/// and stray DSML tags, and DeepSeek native tool-call spans/tokens. Plain
/// text (including ordinary HTML/markdown) is returned unchanged.
pub fn sanitize_for_ui(text: &str) -> String {
    let mut filter = MarkupFilter::default();
    let mut out = filter.push(text);
    let (tail, _) = filter.finish();
    out.push_str(&tail);
    strip_native_tokens(&out)
}

fn strip_native_tokens(text: &str) -> String {
    if !text.contains(NATIVE_TOKEN_PREFIX) {
        return text.to_string();
    }
    let mut rest = text;
    let mut out = String::with_capacity(text.len());
    // Whole begin…end spans first (the calls inside are not user text).
    while let Some(start) = rest.find(NATIVE_BEGIN) {
        out.push_str(&rest[..start]);
        match rest[start..].find(NATIVE_END) {
            Some(end) => rest = &rest[start + end + NATIVE_END.len()..],
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    // Then any remaining single token `<｜tool▁…｜>`.
    let mut cleaned = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(start) = rest.find(NATIVE_TOKEN_PREFIX) {
        cleaned.push_str(&rest[..start]);
        let after = &rest[start + NATIVE_TOKEN_PREFIX.len()..];
        match after.find("｜>") {
            Some(end) => rest = &after[end + "｜>".len()..],
            None => {
                rest = "";
            }
        }
    }
    cleaned.push_str(rest);
    cleaned
}

#[cfg(test)]
mod tests {

    /// The EXACT bytes observed in the wild 2026-11-02 (owner report): DOUBLED
    /// fullwidth bars, space after the last separator, two web_search invokes.
    /// Compact-ASCII tests above cannot catch this variant.
    #[test]
    fn parses_the_live_doubled_fullwidth_dsml_and_hides_it() {
        let leaks = "\u{2550}\u{2550}"; // placeholder guard so the literal below stays obvious
        let _ = leaks;
        let text = "<\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} calls>\n<\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} invoke name=\"web_search\">\n<\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} parameter name=\"query\" string=\"true\">Binance EIP-7702 hot wallet exploit</\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} parameter>\n</\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} invoke>\n<\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} invoke name=\"web_search\">\n<\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} parameter name=\"query\" string=\"true\">Binance hack regulatory reaction Europe</\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} parameter>\n</\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} invoke>\n</\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} calls>\n";
        let mut filter = MarkupFilter::default();
        let mut shown = filter.push(text);
        let (tail, calls) = filter.finish();
        shown.push_str(&tail);
        assert!(
            !shown.contains("DSML") && !shown.contains('\u{FF5C}'),
            "markup leaked to the UI: {shown:?}"
        );
        assert_eq!(
            calls.len(),
            2,
            "two web_search invokes recovered: {calls:?}"
        );
        assert_eq!(calls[0].name, "web_search");
        let args: serde_json::Value = serde_json::from_str(&calls[0].arguments).expect("args");
        assert!(
            args["query"]
                .as_str()
                .unwrap_or_default()
                .contains("Binance EIP-7702")
        );
    }

    use super::*;

    /// The EXACT leaked sample from log L18 item 4 (separators normalized
    /// to the real `<|DSML|` form, inter-tag spaces kept).
    const LEAKED: &str = "<|DSML|calls> <|DSML|invoke name=\"replace_file\"> <|DSML|parameter name=\"new\" string=\"true\">2026-09-21|34.40|Fathom|saas ...</|DSML|parameter> <|DSML|parameter name=\"old\" string=\"true\">...</|DSML|parameter> <|DSML|parameter name=\"path\" string=\"true\">/Users/barckcode/Downloads/helmcode/informe-gastos.html</|DSML|parameter> </|DSML|invoke> </|DSML|calls>";

    fn run_all(deltas: &[&str]) -> (String, Vec<MarkupCall>) {
        let mut filter = MarkupFilter::default();
        let mut shown = String::new();
        for delta in deltas {
            shown.push_str(&filter.push(delta));
        }
        let (tail, calls) = filter.finish();
        shown.push_str(&tail);
        (shown, calls)
    }

    fn args(call: &MarkupCall) -> serde_json::Value {
        serde_json::from_str(&call.arguments).expect("arguments are JSON")
    }

    #[test]
    fn leaked_l18_sample_becomes_a_tool_call_and_no_dsml_reaches_content() {
        let (shown, calls) = run_all(&[LEAKED]);
        assert!(!shown.contains("DSML"), "no markup shown: {shown:?}");
        assert!(shown.trim().is_empty(), "nothing else to show: {shown:?}");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "replace_file");
        let value = args(&calls[0]);
        assert_eq!(value["new"], "2026-09-21|34.40|Fathom|saas ...");
        assert_eq!(value["old"], "...");
        assert_eq!(
            value["path"],
            "/Users/barckcode/Downloads/helmcode/informe-gastos.html"
        );
    }

    #[test]
    fn leaked_sample_split_at_every_byte_boundary_still_parses() {
        // Stream it one char at a time: partial tags must be held back.
        let chars: Vec<String> = LEAKED.chars().map(String::from).collect();
        let deltas: Vec<&str> = chars.iter().map(String::as_str).collect();
        let (shown, calls) = run_all(&deltas);
        assert!(!shown.contains("DSML") && !shown.contains('<'), "{shown:?}");
        assert_eq!(calls.len(), 1);
        assert_eq!(
            args(&calls[0])["path"],
            "/Users/barckcode/Downloads/helmcode/informe-gastos.html"
        );
    }

    #[test]
    fn grammar_is_whitespace_and_fullwidth_tolerant() {
        let text = "Voy a leerlo.\n< ｜ dsml ｜ calls >\n  < ｜DSML｜ invoke  name = 'read_file' >\n    <|DSML|parameter name=\"path\" string=\"true\">/a/b.txt</ |DSML| parameter>\n  </|DSML|invoke>\n</｜DSML｜calls>\nListo.";
        let (shown, calls) = run_all(&[text]);
        assert_eq!(shown, "Voy a leerlo.\n\nListo.");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(args(&calls[0])["path"], "/a/b.txt");
    }

    #[test]
    fn non_string_parameters_are_json_and_multiple_invokes_are_kept_in_order() {
        let text = "<|DSML|calls><|DSML|invoke name=\"move_path\"><|DSML|parameter name=\"from\" string=\"true\">/a</|DSML|parameter><|DSML|parameter name=\"to\" string=\"true\">/b</|DSML|parameter><|DSML|parameter name=\"overwrite\" string=\"false\">true</|DSML|parameter></|DSML|invoke><|DSML|invoke name=\"list_files\"><|DSML|parameter name=\"path\" string=\"true\">/a</|DSML|parameter></|DSML|invoke></|DSML|calls>";
        let (shown, calls) = run_all(&[text]);
        assert!(shown.is_empty());
        assert_eq!(
            calls.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            vec!["move_path", "list_files"]
        );
        assert_eq!(args(&calls[0])["overwrite"], true);
    }

    #[test]
    fn a_truncated_block_keeps_complete_invokes_and_drops_partial_ones() {
        let text = "<|DSML|calls><|DSML|invoke name=\"read_file\"><|DSML|parameter name=\"path\" string=\"true\">/a</|DSML|parameter></|DSML|invoke><|DSML|invoke name=\"write_file\"><|DSML|parameter name=\"path\" string=\"true\">/b</|DSML|parameter><|DSML|parameter name=\"content\" string=\"true\">half";
        let (shown, calls) = run_all(&[text]);
        assert!(shown.is_empty(), "{shown:?}");
        assert_eq!(calls.len(), 1, "the unfinished write is never executed");
        assert_eq!(calls[0].name, "read_file");
    }

    #[test]
    fn ordinary_text_html_and_markdown_pass_through_untouched() {
        let text =
            "a < b, x<y, <div>html</div>, `<|not dsml|>` and | pipes | in tables |\n|---|---|";
        let (shown, calls) = run_all(&[text]);
        assert_eq!(shown, text);
        assert!(calls.is_empty());
        // A trailing lone `<` is plain text too.
        let (shown, _) = run_all(&["2 <"]);
        assert_eq!(shown, "2 <");
    }

    #[test]
    fn a_dangling_tag_start_at_the_end_is_dropped_not_shown() {
        let (shown, calls) = run_all(&["Hecho. <|DSML|inv"]);
        assert_eq!(shown, "Hecho. ");
        assert!(calls.is_empty());
    }

    #[test]
    fn sanitize_strips_residual_markup_and_native_tokens() {
        let leaked = format!("Antes {LEAKED} después");
        assert_eq!(sanitize_for_ui(&leaked), "Antes  después");
        let native = "Hola<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>read_file\n{}<｜tool▁call▁end｜><｜tool▁calls▁end｜> fin";
        assert_eq!(sanitize_for_ui(native), "Hola fin");
        assert_eq!(sanitize_for_ui("stray </|DSML|invoke> tag"), "stray  tag");
        assert_eq!(sanitize_for_ui("plain **markdown**"), "plain **markdown**");
    }
}
