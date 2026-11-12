//! `save_chat_as_skill` (round 15/F4): the model DISTILLS the conversation
//! into a skill draft that prefills the app's existing save form.
//!
//! "Save as skill" used to copy the first message of the chat verbatim. Now
//! the model is offered this tool and told (see [`GUIDANCE`]) to codify the
//! whole conversation the skill-creator way: a description that says what
//! the skill does and when to use it ([`skills::DESCRIPTION_GUIDE`]) and a
//! body that is the working order ([`skills::BODY_ORDER_HEADING`]) with the
//! decisions and gotchas the conversation surfaced.
//!
//! The tool NEVER saves anything. The draft goes through the same pure checks
//! as every save (field limits, bundle rules and the credential detector,
//! `skills::build`), so a draft carrying a secret is refused here and fed
//! back to the model; a valid one is handed to the renderer
//! (`chat://skill_draft`), which opens the save form preloaded with it. The
//! user reviews, edits and saves; saving runs the checks again.

use serde::{Deserialize, Serialize};

use crate::skills::{self, SkillError, SkillInput};

/// The tool name the model calls.
pub const TOOL_NAME: &str = "save_chat_as_skill";

/// The renderer event carrying a validated draft.
pub const DRAFT_EVENT: &str = "chat://skill_draft";

/// What the model is told about saving a conversation as a skill. Appended
/// to the system prompt so the rule applies whether the user typed the
/// request or pressed "Save as skill".
pub const GUIDANCE: &str = "Saving a conversation as a skill:\n\
- When the user asks to save, keep, codify or reuse this conversation (or a way of \
working from it) as a skill, call save_chat_as_skill once. It opens the app's save \
form prefilled with your draft; the user reviews and saves it, nothing is saved by the \
call itself.\n\
- Distill the WHOLE conversation, never copy the first message: what the user wanted, \
the decisions taken, the order of work that ended up working, the inputs it needs, the \
expected output and the gotchas or corrections along the way. Generalize it so it works \
next time with different inputs; drop one-off details (dates, names, file paths) unless \
they are the point.\n\
- name: a short human title, in the user's language.\n\
- description: one line. Say what it does, then when to use it, with the trigger phrases \
the user actually types: \"<What it does>. Use when: <trigger phrases>.\"\n\
- instructions: Markdown in the user's language, addressed to the assistant that will \
apply it. Start with one sentence of purpose, then numbered steps (the working order), \
then short sections only when useful (inputs, output format, checks, gotchas). Do not \
add a top heading or a \"Working order\" heading: the app adds it.\n\
- Never include passwords, API keys, tokens or other credentials; the app refuses them.\n\
- After the call, tell the user in one short sentence that the form is ready to review.";

/// The arguments the model sends.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct Args {
    name: String,
    description: String,
    instructions: String,
}

/// A validated draft for the save form (what `chat://skill_draft` carries,
/// with the conversation id added by the caller).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkillDraft {
    pub title: String,
    pub description: String,
    pub instructions: String,
}

/// The `chat://skill_draft` payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DraftPayload {
    pub conversation_id: i64,
    pub draft: SkillDraft,
}

/// The OpenAI function definition offered on every reply.
pub fn tool_definition() -> serde_json::Value {
    serde_json::json!({ "type": "function", "function": {
        "name": TOOL_NAME,
        "description": "Prefill the app's 'Save as skill' form with a skill distilled from this whole conversation (the user reviews and saves it). Use only when the user asks to save or codify the conversation, or a way of working from it, as a skill.",
        "parameters": { "type": "object", "properties": {
            "name": { "type": "string", "description": "Short human title of the skill, in the user's language (at most 120 characters)." },
            "description": { "type": "string", "description": "One line: what it does, then when to use it with the user's trigger phrases. \"<What it does>. Use when: <trigger phrases>.\"" },
            "instructions": { "type": "string", "description": "Markdown body for the assistant that applies the skill: one purpose sentence, numbered working-order steps, then inputs, output, checks and gotchas when useful. No top heading." }
        }, "required": ["name", "description", "instructions"] }
    }})
}

/// Why a draft was refused, worded for the model (it may retry).
fn refusal(err: &SkillError) -> &'static str {
    match err {
        SkillError::TitleEmpty => "name is empty",
        SkillError::TitleTooLong => "name is longer than 120 characters",
        SkillError::DescriptionEmpty => "description is empty",
        SkillError::DescriptionTooLong => "description is longer than 1024 characters",
        SkillError::InstructionsEmpty => "instructions are empty",
        SkillError::SecretDetected { .. } => {
            "the draft contains something that looks like a password, key or token; remove it and try again"
        }
        SkillError::FileTooLarge { .. } | SkillError::BundleTooLarge => {
            "instructions are too long; keep the essentials"
        }
        _ => "the draft is not a valid skill",
    }
}

/// Parse and validate a tool call into a draft. The SAME checks as a save
/// (`skills::build`: limits, bundle rules, credential detector) run here, so
/// the form never opens with a draft that could not be saved for a secret.
pub fn parse_draft(arguments: &str) -> Result<SkillDraft, String> {
    let args: Args = serde_json::from_str(arguments)
        .map_err(|_| "save_chat_as_skill needs name, description and instructions".to_string())?;
    let input = SkillInput {
        title: args.name,
        description: args.description,
        instructions: args.instructions,
        references: Vec::new(),
    };
    let skill =
        skills::build(&input, "draft", &[], 0, 0).map_err(|err| refusal(&err).to_string())?;
    Ok(SkillDraft {
        title: skill.title,
        description: skill.description,
        instructions: skill.instructions,
    })
}

/// The tool result fed back to the model.
pub fn result_for_model(result: &Result<SkillDraft, String>) -> String {
    match result {
        Ok(_) => serde_json::json!({
            "ok": true,
            "status": "form_prefilled",
            "message": "The save form opens with this draft when your reply ends. The user reviews and saves it; nothing is saved yet."
        })
        .to_string(),
        Err(message) => {
            serde_json::json!({ "ok": false, "error": "invalid_skill", "message": message }).to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str, description: &str, instructions: &str) -> String {
        serde_json::json!({ "name": name, "description": description, "instructions": instructions })
            .to_string()
    }

    #[test]
    fn the_definition_has_the_three_required_fields() {
        let def = tool_definition();
        assert_eq!(def["function"]["name"], TOOL_NAME);
        let required: Vec<&str> = def["function"]["parameters"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(required, ["name", "description", "instructions"]);
        for field in required {
            assert_eq!(
                def["function"]["parameters"]["properties"][field]["type"],
                "string"
            );
        }
    }

    #[test]
    fn the_guidance_encodes_the_skill_creator_method() {
        assert!(GUIDANCE.contains(TOOL_NAME));
        assert!(GUIDANCE.contains("never copy the first message"));
        assert!(GUIDANCE.contains("Distill the WHOLE conversation"));
        // The description rule is the same one the form shows.
        assert!(GUIDANCE.contains("\"<What it does>. Use when: <trigger phrases>.\""));
        assert!(
            skills::DESCRIPTION_GUIDE.ends_with("\"<What it does>. Use when: <trigger phrases>.\"")
        );
        // The body is the working order; the app adds the heading.
        assert!(GUIDANCE.contains("numbered steps (the working order)"));
        assert!(GUIDANCE.contains("Working order\" heading: the app adds it"));
        assert!(GUIDANCE.contains("credentials"));
    }

    #[test]
    fn a_good_draft_is_trimmed_and_normalized() {
        let draft = parse_draft(&call(
            "  Informe semanal ",
            "Escribe el informe semanal.\nUse when: informe semanal.",
            "\n1. Lee las notas.\n2. Escribe.\n",
        ))
        .unwrap();
        assert_eq!(draft.title, "Informe semanal");
        assert_eq!(
            draft.description,
            "Escribe el informe semanal. Use when: informe semanal."
        );
        assert_eq!(draft.instructions, "1. Lee las notas.\n2. Escribe.");
        assert!(result_for_model(&Ok(draft)).contains("form_prefilled"));
    }

    #[test]
    fn a_secret_is_refused_before_the_form_opens() {
        let leaked = "1. Call the API with sk-ant-REDACTED_FAKE_KEY_9999.";
        let err = parse_draft(&call("Deploy", "Deploys. Use when: deploy.", leaked)).unwrap_err();
        assert!(err.contains("password, key or token"), "{err}");
        let fed_back = result_for_model(&Err(err));
        assert!(fed_back.contains("invalid_skill"));
        assert!(
            !fed_back.contains("sk-ant-"),
            "the secret is never echoed back"
        );
        // In the name or the description too.
        assert!(parse_draft(&call("ghp_aaaaaaaaaaaaaaaaaaaaaaaa", "d", "i")).is_err());
        assert!(parse_draft(&call("t", "AKIAABCDEFGHIJKLMNOP", "i")).is_err());
    }

    #[test]
    fn missing_or_empty_fields_are_refused() {
        assert!(parse_draft("{}").is_err());
        assert!(parse_draft("not json").is_err());
        assert_eq!(
            parse_draft(&call("", "d", "i")).unwrap_err(),
            "name is empty"
        );
        assert_eq!(
            parse_draft(&call("t", " ", "i")).unwrap_err(),
            "description is empty"
        );
        assert_eq!(
            parse_draft(&call("t", "d", "\n")).unwrap_err(),
            "instructions are empty"
        );
        assert_eq!(
            parse_draft(&call(&"x".repeat(121), "d", "i")).unwrap_err(),
            "name is longer than 120 characters"
        );
    }

    #[test]
    fn the_payload_serializes_for_the_renderer() {
        let payload = DraftPayload {
            conversation_id: 7,
            draft: SkillDraft {
                title: "t".into(),
                description: "d".into(),
                instructions: "i".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            serde_json::json!({ "conversation_id": 7, "draft": { "title": "t", "description": "d", "instructions": "i" } })
        );
    }
}
