//! Text-to-speech (T6, S5/S10): kokoro speech synthesis with NATIVE Rust
//! playback.
//!
//! Architecture mirrors `chat.rs` (S4): the key is read from the OS keychain
//! (account = profile id), `POST {inference_base}/audio/speech` is sent from
//! the Rust core with body `{model: "kokoro", voice, input,
//! response_format: "wav"}`, and the WAV reply bytes are decoded IN MEMORY
//! (rodio's wav-only decoder over a `Cursor` — never a temp file) and played
//! back through the default audio device via cpal/rodio. The web renderer
//! never sees audio bytes, the key, or any URL; it only receives status
//! events:
//!
//! - `tts://started` — playback began (fetch + decode succeeded)
//! - `tts://ended`   — playback finished (naturally or via `tts_stop`)
//! - `tts://error`   `{kind}` — classified failure (chat's ErrorKind plus
//!   the audio-only `decode` kind)
//!
//! Cancel safety (same managed-task pattern as the chat streams): exactly
//! ONE active playback globally. `tts_speak` aborts/stops the previous
//! playback before starting a new one; `tts_stop` aborts the running task
//! and stops the rodio player, emitting `tts://ended` itself (the stopped
//! task never emits — its registry entry is gone). The player handle is
//! registered in `TtsState` under a generation counter so a finishing task
//! never touches a newer entry and a superseded task never emits stray
//! events.
//!
//! `response_format` is deliberately `"wav"` (not mp3): rodio is enabled
//! with only the wav decoder, so no mp3 decoder dependency is pulled in and
//! an unexpected non-WAV reply fails as `decode` instead of playing noise.
//!
//! Zero telemetry (S8): the only host contacted is the profile's own
//! inference base — a compiled-in constant (S2); in debug builds the
//! `NAN_DESKTOP_MOCK_INFERENCE` environment variable may point it at a
//! local mock (`test/mock-voice.mjs`), exactly like the chat surface.
//! Release builds ignore the variable entirely (S12).

use std::io::Cursor;
use std::sync::{Arc, Mutex};

use rodio::{Decoder, Player};
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, Window};

use crate::chat;

/// Voices the kokoro model accepts in this app (S5): two Spanish, one
/// English. Anything else is rejected before any request is made.
pub const VOICES: &[&str] = &["ef_dora", "em_alex", "af_heart"];

/// The TTS model both locked tenants serve (S10).
pub const TTS_MODEL: &str = "kokoro";

/// The wire format requested from `/audio/speech`: WAV so the reply decodes
/// with rodio's wav-only decoder in memory.
pub const RESPONSE_FORMAT: &str = "wav";

// ---------------------------------------------------------------------------
// Pure, unit-tested core
// ---------------------------------------------------------------------------

/// Build the OpenAI-compatible `/audio/speech` JSON body. `response_format`
/// is always `"wav"` so the reply decodes with rodio's wav-only decoder in
/// memory (no temp files, no mp3 decoder dependency).
pub fn speech_body(voice: &str, input: &str) -> serde_json::Value {
    serde_json::json!({
        "model": TTS_MODEL,
        "voice": voice,
        "input": input,
        "response_format": RESPONSE_FORMAT,
    })
}

/// Validate a voice id against [`VOICES`] before any network work.
pub fn validate_voice(voice: &str) -> Result<(), chat::ErrorKind> {
    if VOICES.contains(&voice) {
        Ok(())
    } else {
        Err(chat::ErrorKind::Protocol)
    }
}

/// Decode WAV bytes in memory (no device, no temp file). Returns the rodio
/// decoder ready to be appended to a player; the caller reads
/// `sample_rate`/`channels` and streams from it. Anything that is not a
/// decodable WAV is a [`chat::ErrorKind::Decode`] failure. The wav-only
/// decoder is used explicitly (no format sniffing): a server that ignored
/// `response_format` fails as `decode` instead of playing noise.
pub fn decode_wav(bytes: Vec<u8>) -> Result<Decoder<Cursor<Vec<u8>>>, chat::ErrorKind> {
    Decoder::new_wav(Cursor::new(bytes)).map_err(|_| chat::ErrorKind::Decode)
}

// ---------------------------------------------------------------------------
// Event payloads (the renderer never sees the key, URLs or audio — S4)
// ---------------------------------------------------------------------------

/// `tts://error` — classified failure of a speak attempt or of playback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TtsErrorPayload {
    pub kind: chat::ErrorKind,
}

// ---------------------------------------------------------------------------
// Active-playback registry (cancel-safe: one playback globally)
// ---------------------------------------------------------------------------

/// One registry entry: the generation counter, the playback task's handle
/// and (once attached) the shared rodio player so `tts_stop` can stop sound
/// even while the playback wait runs on the async runtime. The handle and
/// player are filled in two steps (reserve → spawn → attach) so the command
/// stays race-free without the task reading shared state: the task receives
/// its generation as a parameter.
struct ActiveTts {
    generation: u64,
    handle: Option<JoinHandle<()>>,
    player: Option<Arc<Player>>,
}

/// Single-slot registry: at most one active playback globally.
#[derive(Default)]
pub struct TtsState(Mutex<Option<ActiveTts>>);

/// Atomically abort/stop the previous playback (if any) and reserve the next
/// generation. No handle yet — `tts_speak` attaches it after spawning.
fn reserve_playback(state: &TtsState) -> Result<u64, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "tts state mutex poisoned".to_string())?;
    let generation = guard
        .as_ref()
        .map(|entry| entry.generation + 1)
        .unwrap_or(1);
    if let Some(previous) = guard.take() {
        if let Some(handle) = previous.handle {
            handle.abort();
        }
        if let Some(player) = previous.player {
            player.stop();
        }
    }
    *guard = Some(ActiveTts {
        generation,
        handle: None,
        player: None,
    });
    Ok(generation)
}

/// Attach the freshly created player to its reserved generation. Returns
/// `false` when this task was superseded (or stopped) while it was still
/// fetching — the caller must then not play and not emit any event.
fn attach_player(state: &TtsState, generation: u64, player: Arc<Player>) -> Result<bool, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "tts state mutex poisoned".to_string())?;
    match guard.as_ref() {
        Some(entry) if entry.generation == generation => {
            if let Some(entry) = guard.as_mut() {
                entry.player = Some(player);
            }
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Remove this task's registry entry if it is still the newest. Returns
/// `true` when the task may emit `tts://ended` (it was not superseded or
/// stopped in the meantime).
fn release_playback(state: &TtsState, generation: u64) -> bool {
    if let Ok(mut guard) = state.0.lock()
        && guard.as_ref().map(|entry| entry.generation) == Some(generation)
    {
        *guard = None;
        return true;
    }
    false
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Speak `input` with the kokoro voice: fetch the WAV reply from the
/// profile's inference API, decode it in memory and play it natively.
/// Exactly one playback is active globally — starting a new one replaces the
/// previous. Returns immediately; progress arrives via `tts://started`,
/// `tts://ended` and `tts://error` events.
#[tauri::command]
pub fn tts_speak(
    app: AppHandle,
    window: Window,
    profile_id: String,
    voice: String,
    input: String,
) -> Result<(), String> {
    // Local validation before any work; the renderer gets a command error
    // (no event needed — it never left the button handler).
    if input.trim().is_empty() {
        return Err("input is empty".to_string());
    }
    validate_voice(&voice).map_err(|kind| format!("invalid voice: {voice:?} ({kind:?})"))?;

    let state = app.state::<TtsState>();
    // Cancel-safe: reserve (aborting/stopping the previous playback) before
    // spawning, then attach the handle to the reserved generation so a
    // superseded task is aborted instead of orphaned.
    let generation = reserve_playback(&state)?;
    let handle = tauri::async_runtime::spawn(run_tts_playback(
        app.clone(),
        window,
        profile_id,
        voice,
        input,
        generation,
    ));
    // Attach the handle to its reserved generation. If another speak already
    // superseded this one (a higher generation is registered), the handle is
    // aborted immediately — the superseded task never plays.
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "tts state mutex poisoned".to_string())?;
    match guard.as_ref() {
        Some(entry) if entry.generation == generation => {
            if let Some(entry) = guard.as_mut() {
                entry.handle = Some(handle);
            }
            Ok(())
        }
        _ => {
            handle.abort();
            Ok(())
        }
    }
}

/// The managed playback task: fetch the WAV reply, decode it in memory,
/// play it natively and emit lifecycle events. `generation` identifies this
/// task in the single-slot registry — a superseded task never emits.
async fn run_tts_playback(
    app: AppHandle,
    window: Window,
    profile_id: String,
    voice: String,
    input: String,
    generation: u64,
) {
    let state = app.state::<TtsState>();

    let emit_error = |kind: chat::ErrorKind| {
        release_playback(&state, generation);
        let _ = window.emit("tts://error", TtsErrorPayload { kind });
    };

    // ---- credentials + endpoint (Rust core only, S4) ---------------------
    let key = match chat::read_profile_key(&profile_id) {
        Ok(key) => key,
        Err(kind) => return emit_error(kind),
    };
    let Some(base) = chat::inference_base(&profile_id) else {
        return emit_error(chat::ErrorKind::Protocol);
    };

    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(chat::CONNECT_TIMEOUT_SECS))
        .build()
    {
        Ok(client) => client,
        Err(_) => return emit_error(chat::ErrorKind::Protocol),
    };

    // ---- POST /audio/speech ----------------------------------------------
    let response = match client
        .post(format!("{base}/audio/speech"))
        .bearer_auth(&key)
        .json(&speech_body(&voice, &input))
        .send()
        .await
    {
        Ok(response) => response,
        Err(err) => return emit_error(chat::classify_transport(err.is_timeout())),
    };
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return emit_error(chat::classify_chat_status(status));
    }
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => return emit_error(chat::classify_transport(err.is_timeout())),
    };

    // ---- decode in memory (no temp file) ----------------------------------
    let decoder = match decode_wav(bytes.to_vec()) {
        Ok(decoder) => decoder,
        Err(kind) => return emit_error(kind),
    };

    // ---- native playback through the default output device ----------------
    // The device sink must outlive the playback: it is a local of this task
    // and is dropped (stopping the sound) when the task ends or is aborted.
    let device = match rodio::DeviceSinkBuilder::open_default_sink() {
        Ok(device) => device,
        Err(_) => return emit_error(chat::ErrorKind::Protocol),
    };
    let player = Arc::new(Player::connect_new(device.mixer()));

    // Register the player for `tts_stop`. When this task was superseded or
    // stopped while fetching, play nothing and emit nothing.
    match attach_player(&state, generation, player.clone()) {
        Ok(true) => {}
        Ok(_) => return,
        Err(_) => return,
    }
    player.append(decoder);
    let _ = window.emit("tts://started", ());

    // Wait for the end. Polling keeps the task abort-friendly: an abort() or
    // a player.stop() surfaces at the next sleep and the sound stops.
    while !player.empty() {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    // Only the newest task reports the natural end.
    if release_playback(&state, generation) {
        let _ = window.emit("tts://ended", ());
    }
}

/// Stop the active playback (if any) and emit `tts://ended` so the renderer
/// resets its playing state. No-op when nothing is playing.
#[tauri::command]
pub fn tts_stop(app: AppHandle, window: Window) -> Result<(), String> {
    let state = app.state::<TtsState>();
    let entry = state
        .0
        .lock()
        .map_err(|_| "tts state mutex poisoned".to_string())?
        .take();
    if let Some(entry) = entry {
        if let Some(handle) = entry.handle {
            handle.abort();
        }
        if let Some(player) = entry.player {
            player.stop();
        }
        // The stopped task never emits (its entry is gone): report the end
        // from here so the renderer's playing state resets immediately.
        let _ = window.emit("tts://ended", ());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rodio::Source;
    use std::time::Duration;

    /// Build a tiny valid PCM16 mono WAV in memory: 44-byte RIFF header +
    /// `samples` 16-bit samples at 22050 Hz. Mirrors what
    /// `test/mock-voice.mjs` synthesizes — keep both in sync.
    fn tiny_wav(samples: usize) -> Vec<u8> {
        let sample_rate: u32 = 22050;
        let channels: u16 = 1;
        let bits: u16 = 16;
        let data_len = (samples * (bits as usize / 8)) as u32;
        let mut wav = Vec::with_capacity(44 + data_len as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&channels.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * u32::from(channels) * 2).to_le_bytes());
        wav.extend_from_slice(&(channels * (bits / 8)).to_le_bytes());
        wav.extend_from_slice(&bits.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..samples {
            let value = ((i % 64) as i16 - 32) * 512;
            wav.extend_from_slice(&value.to_le_bytes());
        }
        wav
    }

    // ---- VOICES + validate_voice ------------------------------------------

    #[test]
    fn voice_catalog_is_exactly_the_three_supported_voices() {
        assert_eq!(VOICES, &["ef_dora", "em_alex", "af_heart"]);
    }

    #[test]
    fn validate_voice_accepts_the_three_and_rejects_everything_else() {
        for &voice in VOICES {
            assert_eq!(
                validate_voice(voice),
                Ok::<(), chat::ErrorKind>(()),
                "{voice} must be valid"
            );
        }
        assert_eq!(validate_voice(""), Err(chat::ErrorKind::Protocol));
        assert_eq!(validate_voice("ef_nobody"), Err(chat::ErrorKind::Protocol));
        assert_eq!(validate_voice("EF_DORA"), Err(chat::ErrorKind::Protocol));
        assert_eq!(validate_voice("kokoro"), Err(chat::ErrorKind::Protocol));
    }

    // ---- speech_body ---------------------------------------------------------

    #[test]
    fn speech_body_matches_the_openai_speech_shape_with_wav_format() {
        assert_eq!(
            speech_body("ef_dora", "hola mundo"),
            serde_json::json!({
                "model": "kokoro",
                "voice": "ef_dora",
                "input": "hola mundo",
                "response_format": "wav",
            })
        );
    }

    #[test]
    fn speech_body_carries_the_text_verbatim_including_multibyte() {
        let body = speech_body("af_heart", "Café ☕ — listó");
        assert_eq!(body["input"], "Café ☕ — listó");
        assert_eq!(body["voice"], "af_heart");
        assert_eq!(body["model"], "kokoro");
    }

    // ---- decode_wav ------------------------------------------------------------

    #[test]
    fn tiny_wav_decodes_in_memory_with_expected_shape() {
        let decoder = decode_wav(tiny_wav(100)).expect("tiny wav must decode");
        assert_eq!(
            decoder.sample_rate(),
            std::num::NonZeroU32::new(22050).unwrap()
        );
        assert_eq!(decoder.channels(), std::num::NonZeroU16::new(1).unwrap());
        assert_eq!(
            decoder.total_duration(),
            Some(Duration::from_nanos(100_000_000_000 / 22050))
        );
    }

    #[test]
    fn longer_wav_reports_proportional_duration() {
        let decoder = decode_wav(tiny_wav(22050)).expect("decode");
        assert_eq!(decoder.total_duration(), Some(Duration::from_secs(1)));
    }

    #[test]
    fn garbage_bytes_are_a_decode_error_not_a_panic() {
        assert_eq!(
            decode_wav(b"not a wav at all".to_vec()).err(),
            Some(chat::ErrorKind::Decode)
        );
        assert_eq!(decode_wav(Vec::new()).err(), Some(chat::ErrorKind::Decode));
        // A WAV header truncated mid-chunk is still undecodable.
        let mut truncated = tiny_wav(100);
        truncated.truncate(20);
        assert_eq!(decode_wav(truncated).err(), Some(chat::ErrorKind::Decode));
    }
}
