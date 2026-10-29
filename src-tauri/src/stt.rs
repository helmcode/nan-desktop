//! Speech-to-text (T6, S5/S10): whisper dictation against the locked
//! tenants' OpenAI-compatible inference APIs.
//!
//! Architecture mirrors `chat.rs` (S4): the key is read from the OS keychain
//! (account = profile id) and `POST {inference_base}/audio/transcriptions`
//! is sent from the Rust core as multipart (`model=whisper`, `file=<bytes>`
//! with the recording's MIME type). The reply `{text: "…"}` crosses the IPC
//! boundary as a plain string. The audio bytes and the key never touch the
//! renderer, are never persisted, and are never logged (zero telemetry, S8:
//! the only host contacted is the profile's compiled-in inference base —
//! debug builds may redirect it to `test/mock-voice.mjs` exactly like chat).
//!
//! Local guards before any network work (both `protocol` kind): empty audio
//! and audio larger than [`MAX_AUDIO_BYTES`] (25 MiB — the practical cap of
//! OpenAI-compatible transcription endpoints; the request is rejected
//! before upload instead of failing server-side after a long upload).
//!
//! Error classification is shared with chat ([`crate::chat::ErrorKind`] —
//! `missing_key` / `unauthorized` / `rate_limited` / `server` / `network` /
//! `protocol`; the `decode` kind is audio-playback-only and never produced
//! here).

use std::time::Duration;

use serde::Serialize;

use crate::chat;

/// Maximum accepted audio upload: 25 MiB. Rejected locally (kind
/// `protocol`) before any network work.
pub const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;

/// The STT model both locked tenants serve (S10).
pub const STT_MODEL: &str = "whisper";

/// MIME sent when the recorder provides none (never happens in practice:
/// MediaRecorder always reports a mimeType; defensive only).
pub const FALLBACK_MIME: &str = "application/octet-stream";

// ---------------------------------------------------------------------------
// Pure, unit-tested core
// ---------------------------------------------------------------------------

/// `stt_transcribe`'s success payload: the transcribed text only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Transcription {
    pub text: String,
}

/// Local validation of an audio upload before any network work: non-empty
/// and at most [`MAX_AUDIO_BYTES`]. Both rejections are
/// [`chat::ErrorKind::Protocol`] (a local input problem, same family as
/// malformed payloads — nothing was sent anywhere).
pub fn validate_audio(bytes: &[u8]) -> Result<(), chat::ErrorKind> {
    if bytes.is_empty() || bytes.len() > MAX_AUDIO_BYTES {
        return Err(chat::ErrorKind::Protocol);
    }
    Ok(())
}

/// The base MIME type of a recorder MIME string (`audio/webm;codecs=opus`
/// → `audio/webm`). Empty input maps to [`FALLBACK_MIME`].
pub fn base_mime(mime: &str) -> String {
    let base = mime.split(';').next().unwrap_or("").trim();
    if base.is_empty() {
        FALLBACK_MIME.to_string()
    } else {
        base.to_string()
    }
}

/// A plausible file name for the transcription upload part, derived from the
/// base MIME type. OpenAI-compatible endpoints key on the extension for
/// container sniffing.
pub fn filename_for_mime(mime: &str) -> &'static str {
    match base_mime(mime).as_str() {
        "audio/webm" => "audio.webm",
        "audio/mp4" => "audio.m4a",
        "audio/wav" | "audio/x-wav" => "audio.wav",
        "audio/mpeg" | "audio/mp3" => "audio.mp3",
        "audio/ogg" => "audio.ogg",
        _ => "audio",
    }
}

/// Parse the OpenAI-compatible transcription reply body into
/// [`Transcription`]. Anything that is not `{"text": "…"}` with a string
/// `text` is [`chat::ErrorKind::Protocol`].
pub fn parse_transcription(body: &str) -> Result<Transcription, chat::ErrorKind> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| chat::ErrorKind::Protocol)?;
    let text = value
        .get("text")
        .and_then(|text| text.as_str())
        .ok_or(chat::ErrorKind::Protocol)?;
    Ok(Transcription {
        text: text.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/// Transcribe recorded audio with whisper: `POST
/// {inference_base}/audio/transcriptions` as multipart (`model=whisper`,
/// `file=<bytes>`). Returns the transcribed text. The bytes and the key are
/// never logged, stored or echoed (S4/S8).
#[tauri::command]
pub async fn stt_transcribe(
    profile_id: String,
    audio_bytes: Vec<u8>,
    mime: String,
) -> Result<Transcription, chat::ErrorKind> {
    // Local guards before anything leaves the device (both `protocol`).
    validate_audio(&audio_bytes)?;
    let key = chat::read_profile_key(&profile_id)?;
    let base = chat::inference_base(&profile_id).ok_or(chat::ErrorKind::Protocol)?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(chat::CONNECT_TIMEOUT_SECS))
        .build()
        .map_err(|_| chat::ErrorKind::Protocol)?;
    let mime = base_mime(&mime);
    let form = reqwest::multipart::Form::new()
        .text("model", STT_MODEL)
        .part(
            "file",
            reqwest::multipart::Part::bytes(audio_bytes)
                .file_name(filename_for_mime(&mime).to_string())
                .mime_str(&mime)
                .map_err(|_| chat::ErrorKind::Protocol)?,
        );

    let response = client
        .post(format!("{base}/audio/transcriptions"))
        .bearer_auth(&key)
        .multipart(form)
        .send()
        .await
        .map_err(|err| chat::classify_transport(err.is_timeout()))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(chat::classify_chat_status(status));
    }
    let body = response
        .text()
        .await
        .map_err(|err| chat::classify_transport(err.is_timeout()))?;
    parse_transcription(&body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::ErrorKind;

    // ---- validate_audio ----------------------------------------------------

    #[test]
    fn empty_audio_is_rejected_as_protocol() {
        assert_eq!(validate_audio(&[]), Err(ErrorKind::Protocol));
    }

    #[test]
    fn audio_up_to_the_25mib_cap_is_accepted() {
        let cap = vec![0u8; MAX_AUDIO_BYTES];
        assert_eq!(validate_audio(&cap), Ok(()));
    }

    #[test]
    fn audio_over_the_25mib_cap_is_rejected_as_protocol() {
        let over = vec![0u8; MAX_AUDIO_BYTES + 1];
        assert_eq!(validate_audio(&over), Err(ErrorKind::Protocol));
    }

    #[test]
    fn tiny_recordings_are_accepted() {
        assert_eq!(validate_audio(&[0x1a, 0x45, 0xdf, 0xa3]), Ok(()));
    }

    // ---- base_mime + filename_for_mime -------------------------------------

    #[test]
    fn base_mime_strips_codec_parameters() {
        assert_eq!(base_mime("audio/webm;codecs=opus"), "audio/webm");
        assert_eq!(base_mime("audio/mp4;codecs=mp4a.40.2"), "audio/mp4");
        assert_eq!(base_mime("audio/webm"), "audio/webm");
    }

    #[test]
    fn base_mime_trims_whitespace_and_handles_empty() {
        assert_eq!(base_mime("  audio/wav  "), "audio/wav");
        assert_eq!(base_mime(""), FALLBACK_MIME);
        assert_eq!(base_mime("   "), FALLBACK_MIME);
    }

    #[test]
    fn filenames_match_the_recorder_container() {
        assert_eq!(filename_for_mime("audio/webm"), "audio.webm");
        assert_eq!(filename_for_mime("audio/mp4"), "audio.m4a");
        assert_eq!(filename_for_mime("audio/wav"), "audio.wav");
        assert_eq!(filename_for_mime("audio/mpeg"), "audio.mp3");
        assert_eq!(filename_for_mime("audio/ogg"), "audio.ogg");
        assert_eq!(filename_for_mime("audio/webm;codecs=opus"), "audio.webm");
        assert_eq!(filename_for_mime(FALLBACK_MIME), "audio");
        assert_eq!(filename_for_mime("something/else"), "audio");
    }

    // ---- parse_transcription -------------------------------------------------

    #[test]
    fn parses_the_openai_transcription_body() {
        assert_eq!(
            parse_transcription(r#"{"text":"hola mundo"}"#),
            Ok(Transcription {
                text: "hola mundo".to_string()
            })
        );
    }

    #[test]
    fn transcription_text_is_taken_verbatim_including_multibyte() {
        let body = r#"{"text":"Café ☕ — listo","language":"es"}"#;
        assert_eq!(
            parse_transcription(body),
            Ok(Transcription {
                text: "Café ☕ — listo".to_string()
            })
        );
    }

    #[test]
    fn empty_transcription_text_is_still_valid() {
        assert_eq!(
            parse_transcription(r#"{"text":""}"#),
            Ok(Transcription {
                text: String::new()
            })
        );
    }

    #[test]
    fn malformed_transcription_bodies_are_protocol_errors() {
        assert_eq!(
            parse_transcription("<html>nope</html>"),
            Err(ErrorKind::Protocol)
        );
        assert_eq!(parse_transcription("{}"), Err(ErrorKind::Protocol));
        assert_eq!(
            parse_transcription(r#"{"text":42}"#),
            Err(ErrorKind::Protocol)
        );
        assert_eq!(
            parse_transcription(r#"{"words":"…"}"#),
            Err(ErrorKind::Protocol)
        );
    }

    // ---- error classification (shared with chat) -----------------------------
    // The command maps statuses/transports with the exact same helpers as the
    // chat surface; these pin the mapping for the audio endpoint so a refactor
    // cannot silently fork the two.

    #[test]
    fn stt_uses_the_shared_status_classification() {
        assert_eq!(chat::classify_chat_status(401), ErrorKind::Unauthorized);
        assert_eq!(chat::classify_chat_status(429), ErrorKind::RateLimited);
        assert_eq!(chat::classify_chat_status(400), ErrorKind::Server);
        assert_eq!(chat::classify_chat_status(500), ErrorKind::Server);
        assert_eq!(chat::classify_transport(true), ErrorKind::Network);
        assert_eq!(chat::classify_transport(false), ErrorKind::Network);
    }

    #[test]
    fn stt_model_is_whisper_and_cap_is_25mib() {
        assert_eq!(STT_MODEL, "whisper");
        assert_eq!(MAX_AUDIO_BYTES, 25 * 1024 * 1024);
    }
}
