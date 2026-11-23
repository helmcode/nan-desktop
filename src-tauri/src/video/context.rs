//! Hidden video context for one chat turn (R-V1): "Ask for a change in
//! this scene" and "Ask the assistant to fix it" put a short, plain request
//! in the composer (what the user reads and edits) and attach the technical
//! details here (project id, scene id and window, playhead, check findings).
//! The core validates them and adds ONE system note for that reply only,
//! right before the user's message; it is never shown or stored.

use serde::Deserialize;

use super::{library, project};

/// Most check findings attached.
pub const MAX_PROBLEMS: usize = 12;
/// Longest finding (characters).
pub const MAX_PROBLEM_CHARS: usize = 300;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VideoContext {
    pub project_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub scene_id: Option<String>,
    #[serde(default)]
    pub scene_title: Option<String>,
    /// The scene's window in the film, seconds.
    #[serde(default)]
    pub from: Option<f64>,
    #[serde(default)]
    pub to: Option<f64>,
    /// The playhead when the user asked, seconds.
    #[serde(default)]
    pub at: Option<f64>,
    /// Findings of the automatic check (`@hyperframes/lint`).
    #[serde(default)]
    pub problems: Vec<String>,
}

/// Printable text: control and bidi/format characters dropped, whitespace
/// collapsed, capped.
fn clean(text: &str, max: usize) -> String {
    text.chars()
        .filter(
            |c| !matches!(*c as u32, 0x200B..=0x200F | 0x202A..=0x202E | 0x2066..=0x2069 | 0xFEFF),
        )
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

fn seconds(value: Option<f64>) -> Option<String> {
    value
        .filter(|v| v.is_finite() && (0.0..=project::MAX_DURATION_S).contains(v))
        .map(project::fmt_seconds)
}

/// The system note for this reply, or why the context is refused.
pub fn note(context: &VideoContext) -> Result<String, String> {
    if !library::valid_project_id(&context.project_id) {
        return Err("video context: bad project id".into());
    }
    if let Some(scene) = &context.scene_id
        && !project::valid_id(scene)
    {
        return Err("video context: bad scene id".into());
    }
    if context.problems.len() > MAX_PROBLEMS {
        return Err("video context: too many findings".into());
    }
    let mut out = format!(
        "Context the app attached to the user's next message (the user does not see it): it is about the video project_id {}",
        context.project_id
    );
    if let Some(title) = context
        .title
        .as_deref()
        .map(|t| clean(t, 120))
        .filter(|t| !t.is_empty())
    {
        out.push_str(&format!(" titled \"{title}\""));
    }
    if let Some(scene) = &context.scene_id {
        out.push_str(&format!(", scene \"{scene}\""));
        if let Some(title) = context
            .scene_title
            .as_deref()
            .map(|t| clean(t, 60))
            .filter(|t| !t.is_empty())
        {
            out.push_str(&format!(" (\"{title}\")"));
        }
        if let (Some(from), Some(to)) = (seconds(context.from), seconds(context.to)) {
            out.push_str(&format!(", from {from} s to {to} s of the film"));
        }
        if let Some(at) = seconds(context.at) {
            out.push_str(&format!(", playhead at {at} s"));
        }
    }
    out.push_str(". Read it with edit_video (only project_id) if you need its current content, then change it with edit_video.");
    let problems: Vec<String> = context
        .problems
        .iter()
        .map(|p| clean(p, MAX_PROBLEM_CHARS))
        .filter(|p| !p.is_empty())
        .collect();
    if !problems.is_empty() {
        out.push_str(" The app's automatic check found these problems; fix them:");
        for problem in problems {
            out.push_str(&format!("\n- {problem}"));
        }
    }
    Ok(out)
}

/// Insert the note as a system message right before the LAST user message
/// of a composed request (this reply only).
pub fn insert_note(messages: &mut Vec<serde_json::Value>, note: &str) {
    let at = messages
        .iter()
        .rposition(|m| m["role"] == "user")
        .unwrap_or(messages.len());
    messages.insert(at, serde_json::json!({ "role": "system", "content": note }));
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    fn ctx() -> VideoContext {
        VideoContext {
            project_id: ID.into(),
            title: Some("Promo\u{202E} de\nverano".into()),
            scene_id: Some("message".into()),
            scene_title: Some("Mensaje".into()),
            from: Some(7.5),
            to: Some(11.0),
            at: Some(8.25),
            problems: vec!["compositions/intro.html: missing_root: x".into()],
        }
    }

    #[test]
    fn the_note_carries_ids_windows_and_findings_cleaned() {
        let note = note(&ctx()).unwrap();
        assert!(note.contains(&format!("project_id {ID}")));
        assert!(note.contains("titled \"Promo de verano\""), "{note}");
        assert!(note.contains(
            "scene \"message\" (\"Mensaje\"), from 7.5 s to 11 s of the film, playhead at 8.25 s"
        ));
        assert!(note.contains("\n- compositions/intro.html: missing_root: x"));
        assert!(!note.contains('\u{202E}'));
    }

    #[test]
    fn bad_contexts_are_refused() {
        for bad in [
            VideoContext {
                project_id: "../x".into(),
                ..ctx()
            },
            VideoContext {
                scene_id: Some("Bad Scene".into()),
                ..ctx()
            },
            VideoContext {
                problems: vec!["x".into(); MAX_PROBLEMS + 1],
                ..ctx()
            },
        ] {
            assert!(note(&bad).is_err());
        }
        assert!(
            serde_json::from_str::<VideoContext>(&format!(
                "{{\"project_id\":\"{ID}\",\"evil\":1}}"
            ))
            .is_err()
        );
        // Out-of-range times are just left out.
        let odd = VideoContext {
            at: Some(f64::NAN),
            from: Some(-1.0),
            ..ctx()
        };
        let text = note(&odd).unwrap();
        assert!(!text.contains("playhead") && !text.contains("from -1"));
    }

    #[test]
    fn the_note_goes_right_before_the_last_user_message() {
        let mut messages = vec![
            serde_json::json!({"role":"system","content":"rules"}),
            serde_json::json!({"role":"user","content":"a"}),
            serde_json::json!({"role":"assistant","content":"b"}),
            serde_json::json!({"role":"user","content":"Escena «Mensaje»: más grande"}),
        ];
        insert_note(&mut messages, "NOTE");
        assert_eq!(
            messages[3],
            serde_json::json!({"role":"system","content":"NOTE"})
        );
        assert_eq!(messages[4]["role"], "user");
        assert_eq!(messages.len(), 5);
    }
}
