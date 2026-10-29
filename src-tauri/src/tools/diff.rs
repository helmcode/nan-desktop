//! Minimal vendored unified diff for the tools subsystem (T8 / spec S7).
//!
//! Line-based LCS with a size guard: inputs beyond `MAX_LCS_LINES` fall
//! back to a single whole-file replacement hunk instead of allocating an
//! O(n·m) table. Only proposal diffs use this (shown in the UI); the audit
//! log never stores file contents, only paths and summaries.
//!
//! Format notes:
//! - headers `--- a/<path>` / `+++ b/<path>`;
//! - hunks `@@ -<old_start>,<old_count> +<new_start>,<new_count> @@` with
//!   counts always emitted (a count of 0 uses the line *before* the hunk,
//!   0 when at file start — same convention as git/diff);
//! - a line without a trailing newline is followed by
//!   `\ No newline at end of file`.

/// Maximum lines per side for the LCS table; above this we fall back to a
/// single whole-file hunk.
pub const MAX_LCS_LINES: usize = 1500;
/// Context lines shown around each change group.
pub const DIFF_CONTEXT: usize = 3;

/// Split text into `(content, ends_with_newline)` pairs. A trailing newline
/// does not create a phantom empty line; an empty string has no lines.
pub fn split_lines(text: &str) -> Vec<(String, bool)> {
    if text.is_empty() {
        return Vec::new();
    }
    let parts: Vec<&str> = text.split('\n').collect();
    let mut lines = Vec::with_capacity(parts.len());
    for (index, part) in parts.iter().enumerate() {
        if index + 1 == parts.len() {
            if part.is_empty() {
                break; // trailing newline: no phantom empty line
            }
            lines.push(((*part).to_string(), false));
        } else {
            lines.push(((*part).to_string(), true));
        }
    }
    lines
}

/// Render a unified diff of `old` → `new` for display path `path`.
/// Identical inputs produce the two header lines and no hunks.
pub fn unified_diff(path: &str, old: &str, new: &str) -> String {
    let old_lines = split_lines(old);
    let new_lines = split_lines(new);
    let ops = lcs_ops(&old_lines, &new_lines);

    // Tagged display entries in order.
    let mut tags: Vec<Tag> = Vec::with_capacity(ops.len());
    for op in &ops {
        match op {
            Op::Equal(index) => tags.push(Tag::Ctx(&old_lines[*index])),
            Op::Delete(index) => tags.push(Tag::Del(&old_lines[*index])),
            Op::Insert(index) => tags.push(Tag::Ins(&new_lines[*index])),
        }
    }

    let mut out = format!("--- a/{path}\n+++ b/{path}\n");
    let changes: Vec<usize> = tags
        .iter()
        .enumerate()
        .filter(|(_, tag)| !matches!(tag, Tag::Ctx(_)))
        .map(|(index, _)| index)
        .collect();
    if changes.is_empty() {
        return out;
    }

    // Group changes: consecutive changes belong to the same hunk while the
    // gap of context lines between them is ≤ 2 × DIFF_CONTEXT (tag-index
    // distance includes the two changed tags themselves).
    let mut groups: Vec<(usize, usize)> = Vec::new();
    let mut group_start = changes[0];
    let mut previous = changes[0];
    for &change in &changes[1..] {
        if change - previous > 2 * DIFF_CONTEXT + 1 {
            groups.push((group_start, previous));
            group_start = change;
        }
        previous = change;
    }
    groups.push((group_start, previous));

    // Running 1-based line numbers (next line per side).
    let mut old_ln = 1usize;
    let mut new_ln = 1usize;
    let mut cursor = 0usize;
    for (first_change, last_change) in groups {
        let hunk_start = first_change.saturating_sub(DIFF_CONTEXT);
        let hunk_end = (last_change + DIFF_CONTEXT + 1).min(tags.len());
        let mut old_count = 0usize;
        let mut new_count = 0usize;
        let mut has_old = false;
        let mut has_new = false;
        for tag in &tags[hunk_start..hunk_end] {
            match tag {
                Tag::Ctx(_) => {
                    old_count += 1;
                    new_count += 1;
                    has_old = true;
                    has_new = true;
                }
                Tag::Del(_) => {
                    old_count += 1;
                    has_old = true;
                }
                Tag::Ins(_) => {
                    new_count += 1;
                    has_new = true;
                }
            }
        }
        // A side with zero lines in the hunk reports the line BEFORE it
        // (0 at file start) — same convention as git/diff. Computed AFTER
        // advancing over skipped context so the counters are current.
        while cursor < hunk_start {
            if let Tag::Ctx(_) = tags[cursor] {
                old_ln += 1;
                new_ln += 1;
            }
            cursor += 1;
        }
        let hunk_old_start = if has_old { old_ln } else { old_ln - 1 };
        let hunk_new_start = if has_new { new_ln } else { new_ln - 1 };
        out.push_str(&format!(
            "@@ -{hunk_old_start},{old_count} +{hunk_new_start},{new_count} @@\n"
        ));

        for tag in &tags[cursor..hunk_end] {
            match tag {
                Tag::Ctx(line) => {
                    out.push(' ');
                    out.push_str(&line.0);
                    out.push('\n');
                    if !line.1 {
                        out.push_str("\\ No newline at end of file\n");
                    }
                    old_ln += 1;
                    new_ln += 1;
                }
                Tag::Del(line) => {
                    out.push('-');
                    out.push_str(&line.0);
                    out.push('\n');
                    if !line.1 {
                        out.push_str("\\ No newline at end of file\n");
                    }
                    old_ln += 1;
                }
                Tag::Ins(line) => {
                    out.push('+');
                    out.push_str(&line.0);
                    out.push('\n');
                    if !line.1 {
                        out.push_str("\\ No newline at end of file\n");
                    }
                    new_ln += 1;
                }
            }
        }
        cursor = hunk_end;
    }
    out
}

/// Count added/removed lines in a rendered diff (headers and
/// `\ No newline` markers excluded).
pub fn diff_line_counts(diff_text: &str) -> (usize, usize) {
    let mut added = 0usize;
    let mut removed = 0usize;
    for line in diff_text.lines() {
        // Headers, hunk markers and newline notices are not content.
        if line.starts_with("--- ") || line.starts_with("+++ ") {
            continue;
        }
        if line.starts_with("@@") || line.starts_with("\\ No newline") {
            continue;
        }
        if line.starts_with('+') {
            added += 1;
        } else if line.starts_with('-') {
            removed += 1;
        }
    }
    (added, removed)
}

enum Op {
    Equal(usize),
    Delete(usize),
    Insert(usize),
}

enum Tag<'a> {
    Ctx(&'a (String, bool)),
    Del(&'a (String, bool)),
    Ins(&'a (String, bool)),
}

fn line_eq(a: &(String, bool), b: &(String, bool)) -> bool {
    a == b
}

fn lcs_ops(old: &[(String, bool)], new: &[(String, bool)]) -> Vec<Op> {
    // Size guard: beyond MAX_LCS_LINES the O(n·m) table is not worth it —
    // fall back to one whole-file replacement hunk.
    if old.len() > MAX_LCS_LINES || new.len() > MAX_LCS_LINES {
        return old
            .iter()
            .enumerate()
            .map(|(index, _)| Op::Delete(index))
            .chain(new.iter().enumerate().map(|(index, _)| Op::Insert(index)))
            .collect();
    }
    let n = old.len();
    let m = new.len();
    // lcs[i][j] = LCS length of old[i..] and new[j..].
    let mut table = vec![0u32; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[at(i, j)] = if line_eq(&old[i], &new[j]) {
                table[at(i + 1, j + 1)] + 1
            } else {
                table[at(i + 1, j)].max(table[at(i, j + 1)])
            };
        }
    }
    let mut ops = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if line_eq(&old[i], &new[j]) {
            ops.push(Op::Equal(i));
            i += 1;
            j += 1;
        } else if table[at(i + 1, j)] >= table[at(i, j + 1)] {
            ops.push(Op::Delete(i));
            i += 1;
        } else {
            ops.push(Op::Insert(j));
            j += 1;
        }
    }
    while i < n {
        ops.push(Op::Delete(i));
        i += 1;
    }
    while j < m {
        ops.push(Op::Insert(j));
        j += 1;
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(path: &str, old: &str, new: &str) -> String {
        unified_diff(path, old, new)
    }

    #[test]
    fn split_lines_variants() {
        assert_eq!(split_lines(""), Vec::<(String, bool)>::new());
        assert_eq!(
            split_lines("a\nb"),
            vec![("a".to_string(), true), ("b".to_string(), false)]
        );
        assert_eq!(split_lines("a\n"), vec![("a".to_string(), true)]);
        assert_eq!(split_lines("\n"), vec![("".to_string(), true)]);
        assert_eq!(
            split_lines("a\n\nb\n"),
            vec![
                ("a".to_string(), true),
                ("".to_string(), true),
                ("b".to_string(), true)
            ]
        );
    }

    #[test]
    fn identical_text_yields_no_hunks() {
        let diff = render("/p/f.txt", "same\nlines\n", "same\nlines\n");
        assert!(diff.starts_with("--- a//p/f.txt\n+++ b//p/f.txt\n"));
        assert!(!diff.contains("@@"), "no changes → no hunks");
        assert!(!diff.contains("+same"));
    }

    #[test]
    fn single_line_change_with_context() {
        let diff = render("/f.txt", "line1\nline2\nline3\n", "line1\nline2x\nline3\n");
        let expected =
            "--- a//f.txt\n+++ b//f.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+line2x\n line3\n";
        assert_eq!(diff, expected);
    }

    #[test]
    fn empty_to_content_uses_zero_old_start() {
        let diff = render("/f.txt", "", "a\nb\n");
        let expected = "--- a//f.txt\n+++ b//f.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n";
        assert_eq!(diff, expected);
    }

    #[test]
    fn content_to_empty_uses_zero_new_start() {
        let diff = render("/f.txt", "a\nb\n", "");
        let expected = "--- a//f.txt\n+++ b//f.txt\n@@ -1,2 +0,0 @@\n-a\n-b\n";
        assert_eq!(diff, expected);
    }

    #[test]
    fn distant_changes_split_into_two_hunks() {
        // 9 lines, first and last changed: 7 context lines between them
        // exceeds 2 × DIFF_CONTEXT → two hunks.
        let old = "a\nb\nc\nd\ne\nf\ng\nh\ni\n";
        let new = "A\nb\nc\nd\ne\nf\ng\nh\nI\n";
        let diff = render("/f.txt", old, new);
        let expected = "--- a//f.txt\n+++ b//f.txt\n\
            @@ -1,4 +1,4 @@\n-a\n+A\n b\n c\n d\n\
            @@ -6,4 +6,4 @@\n f\n g\n h\n-i\n+I\n";
        assert_eq!(diff, expected);
    }

    #[test]
    fn close_changes_merge_into_one_hunk() {
        // Same edits but 8 lines: 6 context lines between == 2 × DIFF_CONTEXT
        // → merged into one hunk.
        let old = "a\nb\nc\nd\ne\nf\ng\nh\n";
        let new = "A\nb\nc\nd\ne\nf\ng\nH\n";
        let diff = render("/f.txt", old, new);
        let expected = "--- a//f.txt\n+++ b//f.txt\n\
            @@ -1,8 +1,8 @@\n-a\n+A\n b\n c\n d\n e\n f\n g\n-h\n+H\n";
        assert_eq!(diff, expected);
    }

    #[test]
    fn trailing_newline_marker() {
        let diff = render("/f.txt", "x\n", "x");
        let expected = "--- a//f.txt\n+++ b//f.txt\n\
            @@ -1,1 +1,1 @@\n-x\n+x\n\\ No newline at end of file\n";
        assert_eq!(diff, expected);
    }

    #[test]
    fn huge_input_falls_back_without_lcs() {
        let mut old = String::new();
        let mut new = String::new();
        for i in 0..(MAX_LCS_LINES + 50) {
            old.push_str(&format!("line-{i}\n"));
            new.push_str(&format!("line-{i}\n"));
        }
        new.push_str("tail-added\n");
        let diff = render("/big.txt", &old, &new);
        assert!(diff.contains("@@"), "fallback still renders a hunk");
        assert_eq!(diff.matches("@@").count() / 2, 1, "single whole-file hunk");
        assert!(diff.contains("+tail-added"));
        assert!(diff.contains("-line-0"));
    }

    #[test]
    fn diff_counts_exclude_headers() {
        let diff = render("/f.txt", "a\nb\nc\n", "a\nB\nc\nd\n");
        let (added, removed) = diff_line_counts(&diff);
        assert_eq!(added, 2, "+B and +d");
        assert_eq!(removed, 1, "-b");
        let (added, removed) = diff_line_counts(&render("/f.txt", "same\n", "same\n"));
        assert_eq!((added, removed), (0, 0));
    }
}
