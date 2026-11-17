//! Turn continuity for the streaming chat (`chat.rs`): why a turn ended,
//! the step budget the model is told about near the tool-round cap, the
//! device-local tool trace replayed to the next turns, and the single place
//! where a finished turn is summarized ([`TurnTracker`] → [`report_turn`]).
//!
//! Background (real user feedback): long tasks stopped without finishing
//! and the user had to type "sigue" again and again. Four causes, all
//! handled here or in `chat.rs`:
//!
//! - the tool-round cap was hit silently: the last round had no tools, the
//!   model could only narrate what it meant to do next, and the turn ended
//!   as a normal finish. Now the model is told how many steps remain
//!   ([`budget_note`]) and the turn ends as [`TurnEndReason::ToolCap`], which
//!   the UI turns into a "Continuar" button;
//! - tool calls and results of earlier turns were never replayed, so after
//!   "sigue" the model had lost its own work. Each reply now keeps its tool
//!   exchange ([`trace_round`], stored on the message, never synced) and the
//!   most recent turns replay it within a bounded budget
//!   ([`history_messages`]);
//! - a stream that ended without `[DONE]` (connection cut) read as a clean
//!   finish, and `finish_reason: "length"` was ignored. Both now end the turn
//!   with their own reason ([`round_end`]) and keep the received text.

use std::collections::HashMap;
use std::time::Instant;

use serde::Serialize;

use crate::chat::{ErrorKind, ToolCall};
use crate::chat_store::ChatMessageRow;
use crate::tool_markup;

// ---------------------------------------------------------------------------
// End reasons
// ---------------------------------------------------------------------------

/// Why a chat turn ended. Sent in `chat://done` / `chat://stopped` and stored
/// on the assistant message (`messages.end_reason`) so it survives reloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnEndReason {
    /// The model answered in text: the turn is done.
    Completed,
    /// The tool-round cap was reached: the model was still working.
    ToolCap,
    /// The stream ended without `[DONE]` and without a finish reason (the
    /// connection was cut). The text received so far is kept.
    StreamCut,
    /// The model hit its output-length limit (`finish_reason: "length"`).
    Length,
    /// The user pressed Stop (or a new send / realm switch replaced the
    /// stream).
    UserStop,
    /// A classified failure (`chat://error`); the reply is not kept.
    Error,
}

impl TurnEndReason {
    /// The stored / serialized spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::ToolCap => "tool_cap",
            Self::StreamCut => "stream_cut",
            Self::Length => "length",
            Self::UserStop => "user_stop",
            Self::Error => "error",
        }
    }

    /// Whether the work was left unfinished by something other than the
    /// user: the UI offers "Continuar" for exactly these (the renderer's
    /// `isContinuable` mirrors this; pinned by a test here).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_continuable(self) -> bool {
        matches!(self, Self::ToolCap | Self::StreamCut | Self::Length)
    }
}

/// How one streamed round ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoundEnd {
    /// `[DONE]` arrived or the model gave a non-`length` finish reason.
    Clean,
    /// `finish_reason: "length"`: the output was truncated.
    Length,
    /// The stream ended (or broke) with neither `[DONE]` nor a finish
    /// reason.
    Cut,
}

/// Classify a finished round from what the stream carried.
pub fn round_end(saw_done: bool, finish_reason: Option<&str>) -> RoundEnd {
    match finish_reason {
        Some("length") => RoundEnd::Length,
        Some(_) => RoundEnd::Clean,
        None if saw_done => RoundEnd::Clean,
        None => RoundEnd::Cut,
    }
}

/// Decide, after a round, whether the turn ends (`Some(reason)`) or the
/// requested tools run and another round follows (`None`).
///
/// - a cut or truncated round ends the turn: its tool calls may be
///   incomplete, so they are never run;
/// - `final_round` is the round sent WITHOUT tools because the cap was
///   reached: reaching it means the model wanted tools on every earlier
///   round, so the work is unfinished ([`TurnEndReason::ToolCap`]);
/// - a clean round with tool calls continues only when tools were offered.
pub fn turn_end_after_round(
    end: RoundEnd,
    has_tool_calls: bool,
    tools_offered: bool,
    final_round: bool,
) -> Option<TurnEndReason> {
    match end {
        RoundEnd::Cut => Some(TurnEndReason::StreamCut),
        RoundEnd::Length => Some(TurnEndReason::Length),
        RoundEnd::Clean if final_round => Some(TurnEndReason::ToolCap),
        RoundEnd::Clean if has_tool_calls && tools_offered => None,
        RoundEnd::Clean => Some(TurnEndReason::Completed),
    }
}

/// How many of the last tool rounds carry a "steps left" note.
pub const BUDGET_WARNING_ROUNDS: usize = 3;

/// The note appended to the last tool result before round `next_round`
/// (0-based) when the cap `max_rounds` is close: rounds `0..max_rounds`
/// offer tools, round `max_rounds` does not. `None` while the budget is
/// comfortable. Appended to a tool message (not a mid-conversation system
/// message: some chat templates reject those).
pub fn budget_note(next_round: usize, max_rounds: usize) -> Option<String> {
    if next_round >= max_rounds {
        return Some(
            "[Note from the app: no tool steps are left in this reply. Do not call tools. \
             Tell the user briefly what you finished, what is still pending and that they \
             can press Continue to resume.]"
                .to_string(),
        );
    }
    let left = max_rounds - next_round;
    (left <= BUDGET_WARNING_ROUNDS).then(|| {
        let steps = if left == 1 { "step" } else { "steps" };
        format!(
            "[Note from the app: {left} tool {steps} left in this reply. Finish the current \
             action and leave the work in a consistent state (save files, note what is \
             pending) instead of starting something new; the user can continue afterwards.]"
        )
    })
}

// ---------------------------------------------------------------------------
// Tool trace (device-local) and its replay
// ---------------------------------------------------------------------------

/// Longest tool result kept in a trace (chars). The live turn sends up to
/// `MAX_TOOL_RESULT_CHARS`; the replay only needs enough to remember what
/// happened.
pub const TRACE_RESULT_CHARS: usize = 4_000;
/// Longest tool-call `arguments` kept verbatim in a trace (chars). Longer
/// ones (a `write_file` body) are compacted while staying valid JSON.
pub const TRACE_ARGUMENT_CHARS: usize = 2_000;
/// Longest string value kept inside compacted arguments (chars).
const TRACE_ARGUMENT_VALUE_CHARS: usize = 300;
/// How many of the most recent assistant turns replay their tool trace.
pub const REPLAY_TURNS: usize = 2;
/// Total characters of replayed trace per request, and the most a stored
/// trace keeps (older rounds are dropped first).
pub const REPLAY_BUDGET_CHARS: usize = 32_000;

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push_str("… (truncated)");
    out
}

/// Keep tool-call arguments small but valid JSON: long string values are
/// truncated; unparseable oversized arguments become `{}`.
pub fn compact_arguments(arguments: &str) -> String {
    if arguments.chars().count() <= TRACE_ARGUMENT_CHARS {
        return arguments.to_string();
    }
    fn shrink(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::String(text) => {
                if text.chars().count() > TRACE_ARGUMENT_VALUE_CHARS {
                    *text = truncate_chars(text, TRACE_ARGUMENT_VALUE_CHARS);
                }
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(shrink),
            serde_json::Value::Object(map) => map.values_mut().for_each(shrink),
            _ => {}
        }
    }
    match serde_json::from_str::<serde_json::Value>(arguments) {
        Ok(mut value) => {
            shrink(&mut value);
            value.to_string()
        }
        Err(_) => "{}".to_string(),
    }
}

/// One complete tool round as OpenAI messages: the assistant `tool_calls`
/// message (no content: the round's text is already part of the final
/// reply) followed by one `tool` message per call, results truncated.
/// `results[i]` answers `calls[i]`.
pub fn trace_round(calls: &[ToolCall], results: &[String]) -> Vec<serde_json::Value> {
    let requested: Vec<serde_json::Value> = calls
        .iter()
        .map(|call| {
            serde_json::json!({
                "id": call.id,
                "type": "function",
                "function": { "name": call.name, "arguments": compact_arguments(&call.arguments) },
            })
        })
        .collect();
    let mut round = vec![serde_json::json!({
        "role": "assistant",
        "content": serde_json::Value::Null,
        "tool_calls": requested,
    })];
    for (call, result) in calls.iter().zip(results) {
        round.push(serde_json::json!({
            "role": "tool",
            "tool_call_id": call.id,
            "content": truncate_chars(result, TRACE_RESULT_CHARS),
        }));
    }
    round
}

/// Split a trace into rounds (each starts at an assistant message).
fn split_rounds(trace: &[serde_json::Value]) -> Vec<&[serde_json::Value]> {
    let mut starts: Vec<usize> = trace
        .iter()
        .enumerate()
        .filter(|(_, message)| message.get("role").and_then(|r| r.as_str()) == Some("assistant"))
        .map(|(index, _)| index)
        .collect();
    if starts.first() != Some(&0) {
        // A malformed head (tool results without their call) is dropped.
        starts.retain(|start| *start != 0);
    }
    starts
        .iter()
        .enumerate()
        .map(|(i, &start)| {
            let end = starts.get(i + 1).copied().unwrap_or(trace.len());
            &trace[start..end]
        })
        .collect()
}

fn json_len(messages: &[serde_json::Value]) -> usize {
    messages.iter().map(|m| m.to_string().len()).sum()
}

/// The newest whole rounds of `trace` that fit in `budget` chars, in order,
/// and the chars they use. Older rounds are dropped first; a round is never
/// split (a call without its result is invalid for the API).
pub fn tail_rounds(trace: &[serde_json::Value], budget: usize) -> (Vec<serde_json::Value>, usize) {
    let mut kept: Vec<&[serde_json::Value]> = Vec::new();
    let mut used = 0;
    for round in split_rounds(trace).into_iter().rev() {
        let size = json_len(round);
        if used + size > budget {
            break;
        }
        used += size;
        kept.push(round);
    }
    kept.reverse();
    (kept.into_iter().flatten().cloned().collect(), used)
}

/// Parse a stored trace; anything that is not a list of assistant/tool
/// messages is ignored (never replayed).
fn parse_trace(raw: &str) -> Option<Vec<serde_json::Value>> {
    let messages: Vec<serde_json::Value> = serde_json::from_str(raw).ok()?;
    let valid = messages.iter().all(|message| {
        matches!(
            message.get("role").and_then(|r| r.as_str()),
            Some("assistant") | Some("tool")
        )
    });
    (valid && !messages.is_empty()).then_some(messages)
}

/// The request history for a new turn: every stored row as `{role,
/// content}` (assistant text sanitized of leaked tool markup, S16) and,
/// for the [`REPLAY_TURNS`] most recent assistant replies, their tool
/// trace right before the reply, newest rounds first within
/// [`REPLAY_BUDGET_CHARS`]. `replay_traces: false` gives the plain history
/// (the fallback for a server that rejects tool messages).
pub fn history_messages(rows: &[ChatMessageRow], replay_traces: bool) -> Vec<serde_json::Value> {
    let mut replay: HashMap<i64, Vec<serde_json::Value>> = HashMap::new();
    if replay_traces {
        let mut budget = REPLAY_BUDGET_CHARS;
        for row in rows
            .iter()
            .rev()
            .filter(|row| row.role == "assistant")
            .take(REPLAY_TURNS)
        {
            let Some(trace) = row.tool_trace.as_deref().and_then(parse_trace) else {
                continue;
            };
            let (kept, used) = tail_rounds(&trace, budget);
            if kept.is_empty() {
                break;
            }
            budget -= used;
            replay.insert(row.id, kept);
        }
    }
    let mut messages = Vec::with_capacity(rows.len());
    for row in rows {
        if let Some(trace) = replay.remove(&row.id) {
            messages.extend(trace);
        }
        let content = if row.role == "assistant" {
            tool_markup::sanitize_for_ui(&row.content)
        } else {
            row.content.clone()
        };
        messages.push(serde_json::json!({ "role": row.role, "content": content }));
    }
    messages
}

// ---------------------------------------------------------------------------
// Turn summary (reported to telemetry)
// ---------------------------------------------------------------------------

/// What one finished turn looked like. Built in exactly one place
/// ([`TurnTracker::finish`], or its `Drop` for an aborted task) and handed
/// to [`report_turn`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnSummary {
    /// The profile the turn ran under (telemetry goes to its platform only).
    pub profile_id: String,
    pub reason: TurnEndReason,
    /// The classified failure when `reason` is [`TurnEndReason::Error`].
    pub error_kind: Option<ErrorKind>,
    /// Model requests made (rounds streamed).
    pub rounds: usize,
    /// Tool calls run.
    pub tool_calls: usize,
    pub duration_ms: u64,
    pub model: String,
    /// The turn was a "Continuar" continuation of an unfinished one.
    pub continued: bool,
}

/// Counts a running turn. Dropped without [`TurnTracker::finish`] (the
/// stream task was aborted by Stop, a new send or a realm switch) it
/// reports [`TurnEndReason::UserStop`].
#[derive(Debug)]
pub struct TurnTracker {
    started: Instant,
    profile_id: String,
    model: String,
    continued: bool,
    pub rounds: usize,
    pub tool_calls: usize,
    finished: bool,
}

impl TurnTracker {
    pub fn start(profile_id: &str, model: &str, continued: bool) -> Self {
        Self {
            started: Instant::now(),
            profile_id: profile_id.to_string(),
            model: model.to_string(),
            continued,
            rounds: 0,
            tool_calls: 0,
            finished: false,
        }
    }

    fn summary(&self, reason: TurnEndReason, error_kind: Option<ErrorKind>) -> TurnSummary {
        TurnSummary {
            profile_id: self.profile_id.clone(),
            reason,
            error_kind,
            rounds: self.rounds,
            tool_calls: self.tool_calls,
            duration_ms: u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
            model: self.model.clone(),
            continued: self.continued,
        }
    }

    /// The turn ended: build its summary and report it.
    pub fn finish(mut self, reason: TurnEndReason, error_kind: Option<ErrorKind>) -> TurnSummary {
        self.finished = true;
        let summary = self.summary(reason, error_kind);
        report_turn(&summary);
        summary
    }
}

impl Drop for TurnTracker {
    fn drop(&mut self) {
        if !self.finished {
            report_turn(&self.summary(TurnEndReason::UserStop, None));
        }
    }
}

/// Turn telemetry: every finished turn passes through here exactly once and
/// becomes one `turn_end` event (metadata only, see `telemetry::turn_end`).
pub fn report_turn(summary: &TurnSummary) {
    #[cfg(test)]
    tests::REPORTED.with(|reported| reported.borrow_mut().push(summary.clone()));
    crate::telemetry::record(
        Some(&summary.profile_id),
        crate::telemetry::turn_end(summary),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    thread_local! {
        pub(super) static REPORTED: RefCell<Vec<TurnSummary>> = const { RefCell::new(Vec::new()) };
    }

    fn take_reported() -> Vec<TurnSummary> {
        REPORTED.with(|reported| std::mem::take(&mut *reported.borrow_mut()))
    }

    // ---- end reasons -------------------------------------------------------

    #[test]
    fn end_reasons_serialize_snake_case_and_match_as_str() {
        for reason in [
            TurnEndReason::Completed,
            TurnEndReason::ToolCap,
            TurnEndReason::StreamCut,
            TurnEndReason::Length,
            TurnEndReason::UserStop,
            TurnEndReason::Error,
        ] {
            assert_eq!(
                serde_json::to_value(reason).expect("serialize"),
                serde_json::Value::String(reason.as_str().to_string())
            );
        }
        assert_eq!(TurnEndReason::ToolCap.as_str(), "tool_cap");
        assert_eq!(TurnEndReason::StreamCut.as_str(), "stream_cut");
    }

    #[test]
    fn only_unfinished_work_is_continuable() {
        assert!(TurnEndReason::ToolCap.is_continuable());
        assert!(TurnEndReason::StreamCut.is_continuable());
        assert!(TurnEndReason::Length.is_continuable());
        assert!(!TurnEndReason::Completed.is_continuable());
        assert!(!TurnEndReason::UserStop.is_continuable());
        assert!(!TurnEndReason::Error.is_continuable());
    }

    #[test]
    fn a_round_is_classified_by_done_and_finish_reason() {
        assert_eq!(round_end(true, None), RoundEnd::Clean);
        assert_eq!(round_end(true, Some("stop")), RoundEnd::Clean);
        assert_eq!(round_end(false, Some("stop")), RoundEnd::Clean);
        assert_eq!(round_end(false, Some("tool_calls")), RoundEnd::Clean);
        assert_eq!(round_end(true, Some("length")), RoundEnd::Length);
        assert_eq!(round_end(false, Some("length")), RoundEnd::Length);
        assert_eq!(
            round_end(false, None),
            RoundEnd::Cut,
            "no [DONE] and no finish reason: the connection was cut"
        );
    }

    #[test]
    fn the_turn_continues_only_after_a_clean_round_with_offered_tools() {
        assert_eq!(
            turn_end_after_round(RoundEnd::Clean, true, true, false),
            None
        );
        assert_eq!(
            turn_end_after_round(RoundEnd::Clean, false, true, false),
            Some(TurnEndReason::Completed)
        );
        // Degraded server (tools rejected): calls are not run, the text stands.
        assert_eq!(
            turn_end_after_round(RoundEnd::Clean, true, false, false),
            Some(TurnEndReason::Completed)
        );
        // The forced no-tools round: the cap was hit.
        assert_eq!(
            turn_end_after_round(RoundEnd::Clean, false, false, true),
            Some(TurnEndReason::ToolCap)
        );
        // Cut / truncated rounds never run their (possibly partial) calls.
        assert_eq!(
            turn_end_after_round(RoundEnd::Cut, true, true, false),
            Some(TurnEndReason::StreamCut)
        );
        assert_eq!(
            turn_end_after_round(RoundEnd::Length, true, true, false),
            Some(TurnEndReason::Length)
        );
        assert_eq!(
            turn_end_after_round(RoundEnd::Cut, false, false, true),
            Some(TurnEndReason::StreamCut),
            "a cut final round is still a cut"
        );
    }

    #[test]
    fn the_model_is_told_when_few_steps_remain() {
        let max = 60;
        assert_eq!(budget_note(1, max), None);
        assert_eq!(budget_note(max - 4, max), None);
        let three = budget_note(max - 3, max).expect("3 left");
        assert!(three.contains("3 tool steps left"), "{three}");
        let one = budget_note(max - 1, max).expect("1 left");
        assert!(one.contains("1 tool step left"), "{one}");
        let none = budget_note(max, max).expect("last round");
        assert!(none.contains("no tool steps are left"));
        assert!(none.contains("Do not call tools"));
    }

    // ---- trace -------------------------------------------------------------

    fn call(id: &str, name: &str, arguments: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: arguments.into(),
        }
    }

    #[test]
    fn a_round_trace_pairs_every_call_with_its_truncated_result() {
        let calls = vec![
            call("c1", "read_file", r#"{"path":"/a"}"#),
            call("c2", "run_command", r#"{"cmd":"ls"}"#),
        ];
        let long = "x".repeat(TRACE_RESULT_CHARS + 500);
        let round = trace_round(&calls, &["short".to_string(), long]);
        assert_eq!(round.len(), 3);
        assert_eq!(round[0]["role"], "assistant");
        assert!(
            round[0]["content"].is_null(),
            "round text lives in the reply"
        );
        assert_eq!(round[0]["tool_calls"][1]["id"], "c2");
        assert_eq!(round[0]["tool_calls"][1]["function"]["name"], "run_command");
        assert_eq!(round[1]["tool_call_id"], "c1");
        assert_eq!(round[1]["content"], "short");
        let truncated = round[2]["content"].as_str().expect("text");
        assert!(truncated.ends_with("(truncated)"));
        assert!(truncated.chars().count() < TRACE_RESULT_CHARS + 20);
    }

    #[test]
    fn oversized_arguments_stay_valid_json() {
        let body = "y".repeat(10_000);
        let args = serde_json::json!({ "path": "/a/index.html", "content": body }).to_string();
        let compacted = compact_arguments(&args);
        let value: serde_json::Value = serde_json::from_str(&compacted).expect("valid json");
        assert_eq!(value["path"], "/a/index.html");
        assert!(value["content"].as_str().expect("str").chars().count() < 400);
        assert_eq!(compact_arguments(r#"{"path":"/a"}"#), r#"{"path":"/a"}"#);
        assert_eq!(compact_arguments(&"{".repeat(5_000)), "{}");
    }

    #[test]
    fn tail_rounds_keeps_the_newest_whole_rounds_within_budget() {
        let mut trace = Vec::new();
        for i in 0..10 {
            let id = format!("c{i}");
            trace.extend(trace_round(
                &[call(&id, "read_file", "{}")],
                &[format!("result {i} {}", "z".repeat(200))],
            ));
        }
        let one_round = json_len(&trace[18..20]);
        let (kept, used) = tail_rounds(&trace, one_round * 3 + 10);
        assert_eq!(kept.len(), 6, "three whole rounds");
        assert!(used <= one_round * 3 + 10);
        assert_eq!(kept[0]["role"], "assistant");
        assert_eq!(
            kept[0]["tool_calls"][0]["id"], "c7",
            "the newest rounds win"
        );
        assert_eq!(kept[5]["tool_call_id"], "c9");
        assert!(tail_rounds(&trace, 10).0.is_empty(), "never half a round");
    }

    fn msg(
        id: i64,
        role: &str,
        content: &str,
        trace: Option<Vec<serde_json::Value>>,
    ) -> ChatMessageRow {
        ChatMessageRow {
            id,
            conversation_id: 1,
            role: role.into(),
            content: content.into(),
            model: None,
            created_at: String::new(),
            partial: false,
            media_path: None,
            sources: vec![],
            artifacts: vec![],
            parent_message_id: None,
            end_reason: None,
            tool_trace: trace.map(|t| serde_json::Value::Array(t).to_string()),
        }
    }

    #[test]
    fn history_replays_the_traces_of_the_most_recent_turns_only() {
        let rows = vec![
            msg(1, "user", "turn 1", None),
            msg(
                2,
                "assistant",
                "r1",
                Some(trace_round(
                    &[call("a", "list_files", "{}")],
                    &["old".into()],
                )),
            ),
            msg(3, "user", "turn 2", None),
            msg(
                4,
                "assistant",
                "r2",
                Some(trace_round(
                    &[call("b", "read_file", "{}")],
                    &["mid".into()],
                )),
            ),
            msg(5, "user", "turn 3", None),
            msg(
                6,
                "assistant",
                "r3",
                Some(trace_round(
                    &[call("c", "run_command", "{}")],
                    &["new".into()],
                )),
            ),
            msg(7, "user", "sigue", None),
        ];
        let history = history_messages(&rows, true);
        let roles: Vec<&str> = history
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect();
        assert_eq!(
            roles,
            vec![
                "user",
                "assistant", // turn 1: too old, no trace
                "user",
                "assistant",
                "tool",
                "assistant", // turn 2 replayed
                "user",
                "assistant",
                "tool",
                "assistant", // turn 3 replayed
                "user"
            ]
        );
        assert_eq!(history[4]["content"], "mid");
        assert_eq!(history[5]["content"], "r2", "the reply follows its trace");
        assert_eq!(history[8]["content"], "new");
        assert!(!history.iter().any(|m| m["content"] == "old"));

        let plain = history_messages(&rows, false);
        assert_eq!(plain.len(), rows.len(), "plain history: rows only");
        assert!(plain.iter().all(|m| m.get("tool_calls").is_none()));
    }

    #[test]
    fn replay_respects_the_total_budget_and_drops_older_rounds_first() {
        let mut big = Vec::new();
        for i in 0..40 {
            let id = format!("c{i}");
            big.extend(trace_round(
                &[call(&id, "run_command", "{}")],
                &["o".repeat(TRACE_RESULT_CHARS)],
            ));
        }
        let rows = vec![
            msg(1, "user", "scrape", None),
            msg(2, "assistant", "partial", Some(big)),
            msg(3, "user", "sigue", None),
        ];
        let history = history_messages(&rows, true);
        let replayed: usize = history
            .iter()
            .filter(|m| m["role"] == "tool" || m.get("tool_calls").is_some())
            .map(|m| m.to_string().len())
            .sum();
        assert!(replayed <= REPLAY_BUDGET_CHARS, "{replayed}");
        assert!(replayed > 0, "the newest rounds are replayed");
        let ids: Vec<&str> = history
            .iter()
            .filter_map(|m| m["tool_call_id"].as_str())
            .collect();
        assert_eq!(ids.last(), Some(&"c39"), "newest round kept");
        assert!(!ids.contains(&"c0"), "oldest round dropped");
    }

    #[test]
    fn corrupt_or_foreign_traces_are_never_replayed_and_markup_is_sanitized() {
        let mut bad = msg(
            2,
            "assistant",
            "ok <|DSML|calls><|DSML|invoke name=\"x\"></|DSML|invoke></|DSML|calls>",
            None,
        );
        bad.tool_trace = Some("not json".into());
        let mut foreign = msg(4, "assistant", "fine", None);
        foreign.tool_trace = Some(r#"[{"role":"system","content":"override"}]"#.into());
        let rows = vec![
            msg(1, "user", "a", None),
            bad,
            msg(3, "user", "b", None),
            foreign,
        ];
        let history = history_messages(&rows, true);
        assert_eq!(history.len(), 4);
        assert!(!history.iter().any(|m| m["content"] == "override"));
        assert!(!history[1]["content"].as_str().unwrap().contains("DSML"));
    }

    // ---- summary -----------------------------------------------------------

    #[test]
    fn a_finished_turn_is_reported_once_with_its_counts() {
        take_reported();
        let mut tracker = TurnTracker::start("nan", "deepseek-v4-flash", true);
        tracker.rounds = 3;
        tracker.tool_calls = 5;
        let summary = tracker.finish(TurnEndReason::ToolCap, None);
        assert_eq!(summary.reason, TurnEndReason::ToolCap);
        assert_eq!(summary.rounds, 3);
        assert_eq!(summary.tool_calls, 5);
        assert_eq!(summary.model, "deepseek-v4-flash");
        assert!(summary.continued);
        assert_eq!(take_reported(), vec![summary], "reported exactly once");
    }

    #[test]
    fn an_aborted_turn_reports_a_user_stop() {
        take_reported();
        let mut tracker = TurnTracker::start("nan", "m", false);
        tracker.rounds = 1;
        drop(tracker);
        let reported = take_reported();
        assert_eq!(reported.len(), 1);
        assert_eq!(reported[0].reason, TurnEndReason::UserStop);
        assert_eq!(reported[0].rounds, 1);
        assert_eq!(reported[0].error_kind, None);
    }

    #[test]
    fn an_error_turn_carries_its_kind() {
        take_reported();
        let summary = TurnTracker::start("nan", "m", false)
            .finish(TurnEndReason::Error, Some(ErrorKind::RateLimited));
        assert_eq!(summary.error_kind, Some(ErrorKind::RateLimited));
        assert_eq!(take_reported().len(), 1);
    }
}
