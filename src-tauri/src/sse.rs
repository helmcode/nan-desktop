//! Minimal SSE parsing for the T1 spike: HTTP lives in the Rust core (S4),
//! parsed events are forwarded to the UI as Tauri events.
//!
//! The parser only implements what the spike needs: `data:` lines and
//! blank-line event boundaries. `event:`, `id:`, `retry:` fields and
//! `:`-prefixed comments are ignored, and events with empty data are
//! skipped. Both `\n` and `\r\n` line endings are supported.

/// Parse complete SSE events out of `buffer`.
///
/// Consumes every byte that belongs to a finished event and leaves any
/// partial event (no blank line yet) in `buffer` so later chunks can
/// complete it. Returns the data payload of each finished event, in order.
/// Multi-line events (several `data:` lines in one event) are joined with
/// `\n`, as required by the SSE spec.
pub fn parse_sse_buffer(buffer: &mut String) -> Vec<String> {
    let mut events = Vec::new();
    // Data lines of the event currently being read (multi-line events are
    // joined with `\n` when the event completes).
    let mut current: Vec<String> = Vec::new();

    while let Some(newline) = buffer.find('\n') {
        // Drain the line including its terminating `\n`.
        let line: String = buffer.drain(..=newline).collect();
        let line = &line[..line.len() - 1];
        // Support CRLF line endings.
        let line = line.strip_suffix('\r').unwrap_or(line);

        if line.is_empty() {
            // Blank line = event boundary. Events whose data payload is
            // entirely empty are skipped.
            let joined = current.join("\n");
            if !joined.is_empty() {
                events.push(joined);
            }
            current.clear();
        } else if line.starts_with(':') {
            // Comment: ignored.
        } else if let Some(rest) = line.strip_prefix("data:") {
            // The SSE spec strips exactly one leading space.
            let rest = rest.strip_prefix(' ').unwrap_or(rest);
            current.push(rest.to_string());
        }
        // `event:`, `id:`, `retry:` and unknown fields are ignored for the
        // spike (see module docs).
    }

    // The event is not finished until a blank line arrives: re-encode the
    // pending data lines back into `buffer` so state survives across calls
    // (later chunks complete the event).
    if !current.is_empty() {
        let pending: String = current.iter().map(|l| format!("data: {l}\n")).collect();
        buffer.insert_str(0, &pending);
    }

    events
}

/// Flush an SSE stream that ended without a trailing blank line.
///
/// Treats the end of `buffer` as an event boundary so a trailing
/// `data:` line is not lost, and clears `buffer`.
pub fn flush_sse_buffer(buffer: &mut String) -> Vec<String> {
    if buffer.is_empty() {
        return Vec::new();
    }
    // Terminate the trailing (possibly unterminated) event with blank lines
    // and re-run the parser, so a final `data:` line is not lost.
    buffer.push_str("\n\n");
    let events = parse_sse_buffer(buffer);
    buffer.clear();
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_data_event() {
        let mut buf = String::from("data: chunk 1\n\n");
        assert_eq!(parse_sse_buffer(&mut buf), vec!["chunk 1".to_string()]);
        assert!(buf.is_empty());
    }

    #[test]
    fn parses_multi_line_data_event() {
        let mut buf = String::from("data: line1\ndata: line2\n\n");
        assert_eq!(parse_sse_buffer(&mut buf), vec!["line1\nline2".to_string()]);
        assert!(buf.is_empty());
    }

    #[test]
    fn splits_event_across_chunk_boundary() {
        // Simulates a network chunk splitting an event in the middle.
        let mut buf = String::from("data: chu");
        assert!(parse_sse_buffer(&mut buf).is_empty());
        buf.push_str("nk 1\n\ndata: chunk 2\n\n");
        assert_eq!(
            parse_sse_buffer(&mut buf),
            vec!["chunk 1".to_string(), "chunk 2".to_string()]
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn handles_crlf_line_endings() {
        let mut buf = String::from("data: chunk 1\r\n\r\ndata: chunk 2\r\n\r\n");
        assert_eq!(
            parse_sse_buffer(&mut buf),
            vec!["chunk 1".to_string(), "chunk 2".to_string()]
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn ignores_comments_and_event_id_retry_fields() {
        let mut buf =
            String::from(": ping\nid: 42\nevent: message\nretry: 3000\ndata: payload\n\n");
        assert_eq!(parse_sse_buffer(&mut buf), vec!["payload".to_string()]);
        assert!(buf.is_empty());
    }

    #[test]
    fn skips_events_with_empty_data() {
        let mut buf = String::from("data:\n\ndata: real\n\n");
        assert_eq!(parse_sse_buffer(&mut buf), vec!["real".to_string()]);
        assert!(buf.is_empty());
    }

    #[test]
    fn leaves_partial_event_in_buffer() {
        let mut buf = String::from("data: chunk 1\n\ndata: chunk 2\n");
        assert_eq!(parse_sse_buffer(&mut buf), vec!["chunk 1".to_string()]);
        assert_eq!(buf, "data: chunk 2\n");
    }

    #[test]
    fn flush_delivers_trailing_event_without_blank_line() {
        let mut buf = String::from("data: final\n");
        assert!(parse_sse_buffer(&mut buf).is_empty());
        assert_eq!(flush_sse_buffer(&mut buf), vec!["final".to_string()]);
        assert!(buf.is_empty());
    }

    #[test]
    fn flush_on_empty_buffer_is_a_noop() {
        let mut buf = String::new();
        assert!(flush_sse_buffer(&mut buf).is_empty());
        assert!(buf.is_empty());
    }
}
