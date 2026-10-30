//! Built-in web search (P1-7): a tool the chat model can call on its own.
//!
//! There is no UI toggle and no provider anywhere in the app: the model is
//! offered a `web_search` function through OpenAI tool-calling; when it asks
//! for it, the Rust core sends `POST {platform_base}/v1/search {query}` with
//! the profile's session JWT. Our platform API runs the search and answers
//! `{results: [{title, url, snippet}]}`; the app never learns (or shows)
//! who serves it.
//!
//! Silent degradation: any failure (no session, offline, 404 while the
//! endpoint is not deployed, 5xx, malformed body) yields an EMPTY result
//! set. The model is told nothing was found and simply answers without it.
//!
//! The renderer only ever sees the resulting sources (title + URL) as
//! citation chips, persisted with the assistant message.
//!
//! Privacy boundary: the query is written by the model, so it may carry
//! context the model has read (chat history, file contents from granted
//! folders, tool output). It is sent ONLY to our own platform endpoint
//! with the user's session — never directly to a third-party search
//! provider from the device — and is capped at [`MAX_QUERY_CHARS`]. What the
//! platform forwards upstream is governed by our platform's privacy terms;
//! that is the boundary we own and document.

use std::time::Duration;

use serde::Deserialize;

use crate::chat_store::WebSource;

/// Function name offered to the model.
pub const TOOL_NAME: &str = "web_search";

/// Most results fed back to the model per search.
pub const MAX_RESULTS: usize = 6;

/// Most citation chips persisted per assistant message.
pub const MAX_SOURCES: usize = 8;

/// Longest query forwarded (chars); longer model output is truncated.
pub const MAX_QUERY_CHARS: usize = 400;

/// Longest snippet forwarded to the model (chars).
const MAX_SNIPPET_CHARS: usize = 600;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// One search hit as returned by the platform API.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SearchResult {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub snippet: String,
}

/// The OpenAI tool definition for `web_search`.
pub fn tool_definition() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": TOOL_NAME,
            "description": "Search the web for current or factual information you do not \
                know (news, prices, recent events, documentation). Returns titles, URLs and \
                snippets. Cite the sources you use.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "A concise search query."
                    }
                },
                "required": ["query"]
            }
        }
    })
}

/// Extract the `query` argument from the model's raw JSON arguments.
/// Blank or malformed arguments yield None (nothing is searched).
pub fn parse_query(arguments: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(arguments).ok()?;
    let query = value.get("query")?.as_str()?.trim();
    if query.is_empty() {
        return None;
    }
    Some(query.chars().take(MAX_QUERY_CHARS).collect())
}

/// Only plain web links are ever kept (they become clickable chips; the
/// open path re-validates https-only in `links.rs`).
fn is_web_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// Parse the platform reply tolerantly: `{results:[…]}` or a bare array.
/// Results without a web URL are dropped; at most [`MAX_RESULTS`] are kept.
pub fn parse_results(body: &str) -> Vec<SearchResult> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let list = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(mut map) => match map.remove("results") {
            Some(serde_json::Value::Array(items)) => items,
            _ => return Vec::new(),
        },
        _ => return Vec::new(),
    };
    list.into_iter()
        .filter_map(|item| serde_json::from_value::<SearchResult>(item).ok())
        .filter(|result| is_web_url(result.url.trim()))
        .map(|result| SearchResult {
            title: result.title.trim().to_string(),
            url: result.url.trim().to_string(),
            snippet: result.snippet.chars().take(MAX_SNIPPET_CHARS).collect(),
        })
        .take(MAX_RESULTS)
        .collect()
}

/// The tool-message content fed back to the model.
pub fn results_for_model(results: &[SearchResult]) -> String {
    if results.is_empty() {
        return serde_json::json!({
            "results": [],
            "note": "Web search is unavailable or found nothing. Answer from your own \
                knowledge and do not mention the search."
        })
        .to_string();
    }
    let items: Vec<serde_json::Value> = results
        .iter()
        .map(|r| serde_json::json!({ "title": r.title, "url": r.url, "snippet": r.snippet }))
        .collect();
    serde_json::json!({ "results": items }).to_string()
}

/// Merge new results into the message's citation list: deduplicated by URL,
/// untitled results labelled by their host, capped at [`MAX_SOURCES`].
pub fn merge_sources(sources: &mut Vec<WebSource>, results: &[SearchResult]) {
    for result in results {
        if sources.len() >= MAX_SOURCES {
            return;
        }
        if sources.iter().any(|s| s.url == result.url) {
            continue;
        }
        let title = if result.title.is_empty() {
            host_of(&result.url).unwrap_or_else(|| result.url.clone())
        } else {
            result.title.clone()
        };
        sources.push(WebSource {
            title,
            url: result.url.clone(),
        });
    }
}

/// The host part of a web URL (`https://a.b/c` → `a.b`).
pub fn host_of(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host = rest.split(['/', '?', '#']).next()?.trim();
    (!host.is_empty()).then(|| host.to_string())
}

/// Run one search through the platform API. Never fails: every problem
/// degrades to "no results" (see module docs).
pub async fn search(profile_id: &str, query: &str) -> Vec<SearchResult> {
    let Some(token) = crate::chat::read_session_token(profile_id) else {
        return Vec::new();
    };
    let Some(base) = crate::device_flow::platform_base(profile_id) else {
        return Vec::new();
    };
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
    else {
        return Vec::new();
    };
    let Ok(response) = client
        .post(format!("{base}/v1/search"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "query": query }))
        .send()
        .await
    else {
        return Vec::new();
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    match response.text().await {
        Ok(body) => parse_results(&body),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_definition_is_an_openai_function_named_web_search() {
        let def = tool_definition();
        assert_eq!(def["type"], "function");
        assert_eq!(def["function"]["name"], TOOL_NAME);
        assert_eq!(def["function"]["parameters"]["required"][0], "query");
    }

    #[test]
    fn tool_definition_names_no_search_provider() {
        // The provider behind our API is invisible to the app and the user.
        let text = tool_definition().to_string().to_lowercase();
        for vendor in [
            "brave",
            "google",
            "bing",
            "tavily",
            "serp",
            "exa",
            "duckduckgo",
        ] {
            assert!(!text.contains(vendor), "provider leaked: {vendor}");
        }
    }

    #[test]
    fn parse_query_reads_and_bounds_the_argument() {
        assert_eq!(
            parse_query(r#"{"query":"  tiempo en Madrid "}"#).as_deref(),
            Some("tiempo en Madrid")
        );
        assert_eq!(parse_query(r#"{"query":"   "}"#), None);
        assert_eq!(parse_query(r#"{"q":"x"}"#), None);
        assert_eq!(parse_query("not json"), None);
        let long = format!(r#"{{"query":"{}"}}"#, "a".repeat(1000));
        assert_eq!(
            parse_query(&long).expect("query").chars().count(),
            MAX_QUERY_CHARS
        );
    }

    #[test]
    fn parses_object_and_bare_array_bodies() {
        let object = r#"{"results":[{"title":"A","url":"https://a.example/x","snippet":"sa"}]}"#;
        let array = r#"[{"title":"A","url":"https://a.example/x","snippet":"sa"}]"#;
        let expected = vec![SearchResult {
            title: "A".into(),
            url: "https://a.example/x".into(),
            snippet: "sa".into(),
        }];
        assert_eq!(parse_results(object), expected);
        assert_eq!(parse_results(array), expected);
    }

    #[test]
    fn malformed_bodies_degrade_to_no_results() {
        assert!(parse_results("<html>404</html>").is_empty());
        assert!(parse_results(r#"{"results":42}"#).is_empty());
        assert!(parse_results(r#"{"error":"not found"}"#).is_empty());
        assert!(parse_results("42").is_empty());
    }

    #[test]
    fn non_web_urls_are_dropped_and_results_capped() {
        let mut items = vec![
            r#"{"title":"js","url":"javascript:alert(1)"}"#.to_string(),
            r#"{"title":"file","url":"file:///etc/passwd"}"#.to_string(),
        ];
        for i in 0..10 {
            items.push(format!(
                r#"{{"title":"t{i}","url":"https://e.example/{i}"}}"#
            ));
        }
        let body = format!("[{}]", items.join(","));
        let results = parse_results(&body);
        assert_eq!(results.len(), MAX_RESULTS);
        assert!(results.iter().all(|r| r.url.starts_with("https://")));
    }

    #[test]
    fn empty_results_tell_the_model_to_continue_without_search() {
        let text = results_for_model(&[]);
        let value: serde_json::Value = serde_json::from_str(&text).expect("json");
        assert_eq!(value["results"].as_array().map(Vec::len), Some(0));
        assert!(value["note"].as_str().is_some());
    }

    #[test]
    fn sources_dedupe_label_by_host_and_cap() {
        let mut sources = Vec::new();
        let results = vec![
            SearchResult {
                title: "".into(),
                url: "https://news.example/a?b".into(),
                snippet: "".into(),
            },
            SearchResult {
                title: "Dup".into(),
                url: "https://news.example/a?b".into(),
                snippet: "".into(),
            },
            SearchResult {
                title: "Other".into(),
                url: "https://o.example".into(),
                snippet: "".into(),
            },
        ];
        merge_sources(&mut sources, &results);
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].title, "news.example");
        assert_eq!(sources[1].title, "Other");
        let many: Vec<SearchResult> = (0..20)
            .map(|i| SearchResult {
                title: format!("t{i}"),
                url: format!("https://m.example/{i}"),
                snippet: "".into(),
            })
            .collect();
        merge_sources(&mut sources, &many);
        assert_eq!(sources.len(), MAX_SOURCES);
    }

    #[test]
    fn host_of_extracts_the_host() {
        assert_eq!(host_of("https://a.b/c").as_deref(), Some("a.b"));
        assert_eq!(host_of("http://x.y?q").as_deref(), Some("x.y"));
        assert_eq!(host_of("ftp://x"), None);
    }
}
