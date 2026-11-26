//! Motion lint: cheap static checks of a scene's HTML/CSS for the patterns
//! that make an assistant-made video stutter. They are WARNINGS that go back
//! to the model in the `create_video` / `edit_video` result (next to the
//! voice-over warning), never errors: a scene they flag still renders.
//!
//! Why these patterns (measured by seeking the pinned HyperFrames runtime
//! frame by frame in headless Chrome, the way the render service does):
//! - The runtime hides a `.clip` outside its time window with `display:
//!   none` when the clip is in the normal flow (position static, relative
//!   or sticky) and holds no timed descendant; an absolutely positioned
//!   clip only gets `visibility: hidden`. So an in-flow clip that appears
//!   or ends mid-scene takes its box in or out of a flex/grid layout and
//!   every visible sibling jumps in ONE frame. That is the stutter testers
//!   see, in the preview and baked into the MP4 alike.
//! - The CSS adapter seeks every animation to `time - start of its closest
//!   [data-start]`, so `animation-delay` and `animation-fill-mode` behave
//!   exactly as in a browser: a delayed animation without a backwards fill
//!   shows its resting style and then snaps to its first keyframe, and an
//!   element hidden at rest (`opacity: 0`) without a forwards fill vanishes
//!   when its entrance ends.
//! - Keyframes on layout properties (width, margin, font-size...) re-lay
//!   out the scene on every frame: text re-wraps and neighbours move.
//! - An animation that ends after its scene is cut mid-move.
//!
//! Conservative by design: selectors the matcher does not understand (pseudo
//! classes, sibling combinators, attribute selectors) count as "not
//! animated" and as "maybe absolutely positioned", so an unusual but valid
//! scene gets fewer warnings, never more. Every bundled template is clean
//! (`templates::tests::every_template_passes_the_motion_lint`).

use std::collections::BTreeMap;

use super::project;
use crate::tools::website;

/// Tolerance for time comparisons (seconds).
const EPS: f64 = 0.001;
/// Elements named in one warning before "and N more".
const MAX_NAMED: usize = 3;
/// Longest element label (`#id`, `.class`) quoted back to the model.
const MAX_LABEL: usize = 40;
/// Bigger scenes are not linted (bounded cost; no warning is safe).
const MAX_ELEMENTS: usize = 2000;
const MAX_RULES: usize = 1000;

/// Properties whose animation re-lays out the scene (moves neighbours,
/// re-wraps text). Positioning offsets (`left`, `top`) are not listed: on an
/// absolutely positioned element they move nothing else.
const LAYOUT_PROPS: &[&str] = &[
    "width",
    "height",
    "min-width",
    "min-height",
    "max-width",
    "max-height",
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "margin-inline",
    "margin-block",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "padding-inline",
    "padding-block",
    "font-size",
    "line-height",
    "flex-basis",
    "gap",
    "row-gap",
    "column-gap",
    "border-width",
];

/// Properties that move an element with a transform.
const TRANSFORM_PROPS: &[&str] = &["transform", "translate", "scale", "rotate"];

/// The warnings for one scene (`html` as written, `duration` in seconds).
pub fn lint_scene(scene: &str, html: &str, duration: f64) -> Vec<String> {
    let low = html.to_ascii_lowercase();
    let elements = parse_elements(html, &low);
    let mut css = Css::default();
    for style in project::blocks(&low, "<style", "</style>") {
        parse_css(&strip_comments(style), &mut css);
    }
    if elements.len() > MAX_ELEMENTS || css.rules.len() > MAX_RULES {
        return Vec::new();
    }
    let mut doc = Doc {
        elements,
        css,
        layers: Vec::new(),
        uncertain: Vec::new(),
    };
    doc.layers = (0..doc.elements.len())
        .map(|at| Animation::from_decls(&doc.decls(at, true)).layers())
        .collect();
    doc.uncertain = (0..doc.elements.len())
        .map(|at| doc.animation_uncertain(at))
        .collect();
    let mut out = Vec::new();
    out.extend(in_flow_clips(scene, &doc, duration));
    out.extend(layout_keyframes(scene, &doc));
    out.extend(cut_by_scene_end(scene, &doc, duration));
    out.extend(popping_fills(scene, &doc));
    out
}

// ------------------------------------------------------------ model --

#[derive(Debug, Default)]
struct Element {
    tag: String,
    id: String,
    classes: Vec<String>,
    style: Vec<(String, String)>,
    start: Option<String>,
    duration: Option<String>,
    is_root: bool,
    parent: Option<usize>,
    /// Element children.
    children: usize,
    /// A descendant has `data-start` (the runtime then never collapses it).
    timed_descendant: bool,
}

#[derive(Debug, Default)]
struct Rule {
    selectors: Vec<Selector>,
    decls: Vec<(String, String)>,
}

/// One keyframe step: its selector (`from`, `50%`) and declarations.
type Step = (String, Vec<(String, String)>);

#[derive(Debug, Default)]
struct Css {
    rules: Vec<Rule>,
    keyframes: BTreeMap<String, Vec<Step>>,
}

struct Doc {
    elements: Vec<Element>,
    css: Css,
    /// Each element's animation layers (strictly matched rules + inline).
    layers: Vec<Vec<Layer>>,
    /// A rule the strict matcher does not understand (`li:nth-child(2)`)
    /// may set this element's animation: its timing is not known.
    uncertain: Vec<bool>,
}

const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];

fn parse_elements(html: &str, low: &str) -> Vec<Element> {
    let mut elements: Vec<Element> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let _ = website::for_each_tag(html, low, |name, attributes| {
        if let Some(closing) = name.strip_prefix('/') {
            if let Some(at) = stack.iter().rposition(|&i| elements[i].tag == closing) {
                stack.truncate(at);
            }
            return Ok(());
        }
        let value = |attr: &str| {
            attributes
                .iter()
                .find(|(n, _)| *n == attr)
                .map(|(_, v)| v.trim().to_ascii_lowercase())
        };
        let parent = stack.last().copied();
        let element = Element {
            tag: name.to_string(),
            id: value("id").unwrap_or_default(),
            classes: value("class")
                .unwrap_or_default()
                .split_ascii_whitespace()
                .map(str::to_string)
                .collect(),
            style: value("style").map(|s| parse_decls(&s)).unwrap_or_default(),
            start: value("data-start"),
            duration: value("data-duration"),
            is_root: value("data-composition-id").is_some(),
            parent,
            ..Element::default()
        };
        if element.start.is_some() {
            for &i in &stack {
                elements[i].timed_descendant = true;
            }
        }
        if let Some(p) = parent {
            elements[p].children += 1;
        }
        elements.push(element);
        if !VOID.contains(&name) {
            stack.push(elements.len() - 1);
        }
        Ok(())
    });
    elements
}

fn strip_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(at) = rest.find("/*") {
        out.push_str(&rest[..at]);
        rest = rest[at + 2..]
            .find("*/")
            .map_or("", |end| &rest[at + 2 + end + 2..]);
    }
    out.push_str(rest);
    out
}

/// The index just after the `}` matching the `{` at `open`.
fn block_end(css: &str, open: usize) -> usize {
    let mut depth = 0usize;
    for (i, c) in css[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return open + i + 1;
                }
            }
            _ => {}
        }
    }
    css.len()
}

fn parse_css(css: &str, out: &mut Css) {
    let mut i = 0;
    while i < css.len() {
        let Some(open) = css[i..].find('{').map(|at| i + at) else {
            return;
        };
        // A stray `}` before the next block ends nothing: skip past it.
        let prelude_raw = &css[i..open];
        let prelude = prelude_raw.rsplit('}').next().unwrap_or(prelude_raw).trim();
        let end = block_end(css, open);
        let body = &css[open + 1..end.saturating_sub(1).max(open + 1)];
        if let Some(at_rule) = prelude.strip_prefix('@') {
            let (keyword, rest) = at_rule
                .split_once(|c: char| c.is_ascii_whitespace())
                .unwrap_or((at_rule, ""));
            if keyword.ends_with("keyframes") {
                out.keyframes
                    .insert(rest.trim().to_string(), parse_steps(body));
            } else if matches!(keyword, "media" | "supports" | "container" | "layer") {
                parse_css(body, out);
            }
        } else if !prelude.is_empty() {
            out.rules.push(Rule {
                selectors: split_top(prelude, ',')
                    .into_iter()
                    .map(parse_selector)
                    .filter(|s| !s.is_empty())
                    .collect(),
                decls: parse_decls(body),
            });
        }
        i = end;
    }
}

fn parse_steps(body: &str) -> Vec<Step> {
    let mut steps = Vec::new();
    let mut i = 0;
    while let Some(open) = body[i..].find('{').map(|at| i + at) {
        let end = block_end(body, open);
        let selector = body[i..open]
            .trim()
            .trim_start_matches('}')
            .trim()
            .to_string();
        let inner = &body[open + 1..end.saturating_sub(1).max(open + 1)];
        steps.push((selector, parse_decls(inner)));
        i = end;
    }
    steps
}

/// Split at `sep` outside parentheses and brackets.
fn split_top(text: &str, sep: char) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut from = 0;
    for (i, c) in text.char_indices() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            _ if c == sep && depth <= 0 => {
                out.push(&text[from..i]);
                from = i + c.len_utf8();
            }
            _ => {}
        }
    }
    out.push(&text[from..]);
    out
}

fn parse_decls(body: &str) -> Vec<(String, String)> {
    split_top(body, ';')
        .into_iter()
        .filter_map(|decl| {
            let (prop, value) = decl.split_once(':')?;
            let value = value.trim();
            let value = value.strip_suffix("!important").unwrap_or(value).trim();
            Some((prop.trim().to_string(), value.to_string()))
        })
        .filter(|(prop, _)| !prop.is_empty())
        .collect()
}

// --------------------------------------------------------- selectors --

#[derive(Debug, Default)]
struct Compound {
    tag: Option<String>,
    ids: Vec<String>,
    classes: Vec<String>,
    /// A pseudo-class or an attribute selector (not understood).
    other: bool,
    /// `::before` and friends: the rule targets a pseudo box.
    pseudo_element: bool,
}

fn parse_compound(text: &str) -> Compound {
    let mut c = Compound::default();
    let bytes = text.as_bytes();
    let mut i = 0;
    let word = |from: usize| {
        let mut j = from;
        while j < bytes.len()
            && (bytes[j].is_ascii_alphanumeric() || matches!(bytes[j], b'-' | b'_'))
        {
            j += 1;
        }
        j
    };
    while i < bytes.len() {
        match bytes[i] {
            b'#' | b'.' => {
                let end = word(i + 1);
                let name = text[i + 1..end].to_string();
                if bytes[i] == b'#' {
                    c.ids.push(name);
                } else {
                    c.classes.push(name);
                }
                i = end.max(i + 1);
            }
            b'[' => {
                c.other = true;
                i = text[i..].find(']').map_or(bytes.len(), |e| i + e + 1);
            }
            b':' => {
                if bytes.get(i + 1) == Some(&b':') {
                    c.pseudo_element = true;
                    i += 2;
                } else {
                    i += 1;
                }
                let end = word(i);
                let name = &text[i..end];
                if matches!(
                    name,
                    "before" | "after" | "first-line" | "first-letter" | "marker"
                ) {
                    c.pseudo_element = true;
                } else {
                    c.other = true;
                }
                i = end;
                if bytes.get(i) == Some(&b'(') {
                    let mut depth = 0;
                    while i < bytes.len() {
                        match bytes[i] {
                            b'(' => depth += 1,
                            b')' => {
                                depth -= 1;
                                if depth == 0 {
                                    i += 1;
                                    break;
                                }
                            }
                            _ => {}
                        }
                        i += 1;
                    }
                }
            }
            b'*' => i += 1,
            _ => {
                let end = word(i);
                if end == i {
                    i += 1;
                } else {
                    c.tag = Some(text[i..end].to_string());
                    i = end;
                }
            }
        }
    }
    c
}

/// A selector as compounds joined by combinators (`' '`, `'>'`, `'+'`,
/// `'~'`): `(combinator before it, compound)`, left to right.
type Selector = Vec<(char, Compound)>;

fn parse_selector(selector: &str) -> Selector {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut pending = ' ';
    let mut depth = 0i32;
    let flush = |current: &mut String, pending: &mut char, parts: &mut Vec<(char, Compound)>| {
        if !current.trim().is_empty() {
            parts.push((*pending, parse_compound(current.trim())));
            *pending = ' ';
        }
        current.clear();
    };
    for c in selector.chars() {
        match c {
            '(' | '[' => {
                depth += 1;
                current.push(c);
            }
            ')' | ']' => {
                depth -= 1;
                current.push(c);
            }
            '>' | '+' | '~' if depth <= 0 => {
                flush(&mut current, &mut pending, &mut parts);
                pending = c;
            }
            c if c.is_ascii_whitespace() && depth <= 0 => {
                flush(&mut current, &mut pending, &mut parts)
            }
            _ => current.push(c),
        }
    }
    flush(&mut current, &mut pending, &mut parts);
    parts
}

fn compound_matches(c: &Compound, el: &Element, strict: bool) -> bool {
    if c.pseudo_element || (strict && c.other) {
        return false;
    }
    c.tag.as_ref().is_none_or(|t| *t == el.tag)
        && c.ids.iter().all(|id| *id == el.id)
        && c.classes.iter().all(|cls| el.classes.contains(cls))
}

/// Strict: the whole chain must match with descendant/child combinators
/// only (anything else is "no match"). Loose: only the subject compound.
fn selector_matches(parts: &Selector, elements: &[Element], at: usize, strict: bool) -> bool {
    let Some((_, subject)) = parts.last() else {
        return false;
    };
    if !compound_matches(subject, &elements[at], strict) {
        return false;
    }
    if !strict {
        return true;
    }
    chain_matches(parts, parts.len() - 1, elements, at)
}

fn chain_matches(
    parts: &[(char, Compound)],
    index: usize,
    elements: &[Element],
    at: usize,
) -> bool {
    if index == 0 {
        return true;
    }
    let combinator = parts[index].0;
    let wanted = &parts[index - 1].1;
    let mut parent = elements[at].parent;
    match combinator {
        '>' => parent.is_some_and(|p| {
            compound_matches(wanted, &elements[p], true)
                && chain_matches(parts, index - 1, elements, p)
        }),
        ' ' => {
            while let Some(p) = parent {
                if compound_matches(wanted, &elements[p], true)
                    && chain_matches(parts, index - 1, elements, p)
                {
                    return true;
                }
                parent = elements[p].parent;
            }
            false
        }
        _ => false,
    }
}

impl Doc {
    /// The declarations that apply to an element, in cascade order
    /// (approximate: source order, inline last).
    fn decls(&self, at: usize, strict: bool) -> Vec<&(String, String)> {
        let mut out: Vec<&(String, String)> = self
            .css
            .rules
            .iter()
            .filter(|rule| {
                rule.selectors
                    .iter()
                    .any(|s| selector_matches(s, &self.elements, at, strict))
            })
            .flat_map(|rule| rule.decls.iter())
            .collect();
        out.extend(self.elements[at].style.iter());
        out
    }

    /// A rule that may apply (loose) but did not match strictly sets an
    /// animation property.
    fn animation_uncertain(&self, at: usize) -> bool {
        self.css.rules.iter().any(|rule| {
            rule.decls.iter().any(|(p, _)| p.starts_with("animation"))
                && rule
                    .selectors
                    .iter()
                    .any(|s| selector_matches(s, &self.elements, at, false))
                && !rule
                    .selectors
                    .iter()
                    .any(|s| selector_matches(s, &self.elements, at, true))
        })
    }

    /// Positioned out of the flow by ANY rule that may apply (loose).
    fn maybe_out_of_flow(&self, at: usize) -> bool {
        self.decls(at, false).iter().any(|(prop, value)| {
            prop == "position" && (value.starts_with("absolute") || value.starts_with("fixed"))
        })
    }

    /// The resting value of a property (strictly matched, last wins).
    fn resting(&self, at: usize, prop: &str) -> Option<String> {
        self.decls(at, true)
            .iter()
            .rev()
            .find(|(p, _)| p == prop)
            .map(|(_, v)| v.clone())
    }

    /// Start (scene seconds) of the closest timed ancestor-or-self.
    fn clip_start(&self, at: usize) -> f64 {
        let mut cursor = Some(at);
        while let Some(i) = cursor {
            if let Some(start) = &self.elements[i].start {
                return start.parse::<f64>().unwrap_or(0.0).max(0.0);
            }
            cursor = self.elements[i].parent;
        }
        0.0
    }

    fn label(&self, at: usize) -> String {
        let el = &self.elements[at];
        let label = if !el.id.is_empty() {
            format!("#{}", el.id)
        } else if let Some(class) = el.classes.iter().find(|c| *c != "clip") {
            format!(".{class}")
        } else if el.classes.iter().any(|c| c == "clip") {
            format!(
                "the .clip at data-start=\"{}\"",
                el.start.as_deref().unwrap_or("0")
            )
        } else {
            format!("<{}>", el.tag)
        };
        label
            .chars()
            .filter(|c| c.is_ascii_graphic() || *c == ' ')
            .take(MAX_LABEL)
            .collect()
    }
}

// --------------------------------------------------------- animation --

#[derive(Debug, Default, Clone)]
struct Layer {
    name: String,
    duration: f64,
    delay: f64,
    iterations: f64,
    fill: String,
}

#[derive(Debug, Default)]
struct Animation {
    names: Vec<String>,
    durations: Vec<f64>,
    delays: Vec<f64>,
    iterations: Vec<f64>,
    fills: Vec<String>,
}

const TIMING_WORDS: &[&str] = &[
    "ease",
    "ease-in",
    "ease-out",
    "ease-in-out",
    "linear",
    "step-start",
    "step-end",
    "normal",
    "reverse",
    "alternate",
    "alternate-reverse",
    "running",
    "paused",
    "initial",
    "inherit",
    "unset",
];
const FILL_WORDS: &[&str] = &["forwards", "backwards", "both"];

fn parse_time(token: &str) -> Option<f64> {
    if let Some(ms) = token.strip_suffix("ms") {
        return ms.parse::<f64>().ok().map(|v| v / 1000.0);
    }
    token.strip_suffix('s')?.parse::<f64>().ok()
}

impl Animation {
    fn from_decls(decls: &[&(String, String)]) -> Self {
        let mut a = Animation::default();
        for (prop, value) in decls {
            let layers = || split_top(value, ',').into_iter().map(str::trim);
            match prop.as_str() {
                "animation" => {
                    a = Animation::default();
                    for layer in layers() {
                        a.push_shorthand(layer);
                    }
                }
                "animation-name" => a.names = layers().map(str::to_string).collect(),
                "animation-duration" => {
                    a.durations = layers().map(|t| parse_time(t).unwrap_or(0.0)).collect()
                }
                "animation-delay" => {
                    a.delays = layers().map(|t| parse_time(t).unwrap_or(0.0)).collect()
                }
                "animation-iteration-count" => {
                    a.iterations = layers().map(|t| t.parse().unwrap_or(1.0)).collect()
                }
                "animation-fill-mode" => a.fills = layers().map(str::to_string).collect(),
                _ => {}
            }
        }
        a
    }

    fn push_shorthand(&mut self, layer: &str) {
        let layer = layer.split_ascii_whitespace().collect::<Vec<_>>().join(" ");
        let (mut name, mut fill) = (None, None);
        let (mut times, mut iterations) = (Vec::new(), None);
        let mut saw_none = false;
        for token in split_top(&layer, ' ').into_iter().filter(|t| !t.is_empty()) {
            if let Some(t) = parse_time(token) {
                times.push(t);
            } else if let Ok(n) = token.parse::<f64>() {
                iterations = Some(n);
            } else if FILL_WORDS.contains(&token) {
                fill = Some(token.to_string());
            } else if token == "none" {
                saw_none = true;
            } else if !TIMING_WORDS.contains(&token) && !token.contains('(') {
                name = Some(token.to_string());
            }
        }
        let name = name.unwrap_or_else(|| if saw_none { "none" } else { "" }.to_string());
        self.names.push(name);
        self.durations.push(times.first().copied().unwrap_or(0.0));
        self.delays.push(times.get(1).copied().unwrap_or(0.0));
        self.iterations.push(iterations.unwrap_or(1.0));
        self.fills.push(fill.unwrap_or_else(|| "none".into()));
    }

    fn layers(&self) -> Vec<Layer> {
        let pick = |list: &[f64], i: usize, default: f64| {
            if list.is_empty() {
                default
            } else {
                list[i % list.len()]
            }
        };
        self.names
            .iter()
            .enumerate()
            .filter(|(_, name)| !name.is_empty() && name.as_str() != "none")
            .map(|(i, name)| Layer {
                name: name.clone(),
                duration: pick(&self.durations, i, 0.0),
                delay: pick(&self.delays, i, 0.0),
                iterations: pick(&self.iterations, i, 1.0),
                fill: if self.fills.is_empty() {
                    "none".into()
                } else {
                    self.fills[i % self.fills.len()].clone()
                },
            })
            .collect()
    }
}

fn opacity(value: &str) -> Option<f64> {
    let value = value.trim();
    match value.strip_suffix('%') {
        Some(pct) => pct.trim().parse::<f64>().ok().map(|v| v / 100.0),
        None => value.parse().ok(),
    }
}

/// `(first step, last step)` of a keyframes rule, by offset.
/// Declarations borrowed from the parsed CSS.
type DeclRefs<'a> = Vec<&'a (String, String)>;

fn edge_steps(steps: &[Step]) -> (DeclRefs<'_>, DeclRefs<'_>) {
    let at = |offsets: &[&str]| -> DeclRefs<'_> {
        steps
            .iter()
            .filter(|(sel, _)| sel.split(',').any(|s| offsets.contains(&s.trim())))
            .flat_map(|(_, decls)| decls.iter())
            .collect()
    };
    (at(&["from", "0%"]), at(&["to", "100%"]))
}

fn named(labels: &[String]) -> String {
    let mut text = labels
        .iter()
        .take(MAX_NAMED)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if labels.len() > MAX_NAMED {
        text.push_str(&format!(" and {} more", labels.len() - MAX_NAMED));
    }
    text
}

// ------------------------------------------------------------ checks --

fn in_flow_clips(scene: &str, doc: &Doc, duration: f64) -> Option<String> {
    let mut labels = Vec::new();
    for (at, el) in doc.elements.iter().enumerate() {
        if el.is_root || el.timed_descendant || !el.classes.iter().any(|c| c == "clip") {
            continue;
        }
        let Some(Ok(start)) = el.start.as_deref().map(str::parse::<f64>) else {
            continue;
        };
        let length = el.duration.as_deref().and_then(|d| d.parse::<f64>().ok());
        let appears = start > EPS;
        let ends = length.is_some_and(|len| start + len < duration - EPS);
        let has_siblings = el.parent.is_some_and(|p| doc.elements[p].children >= 2);
        if (appears || ends) && has_siblings && !doc.maybe_out_of_flow(at) {
            labels.push(doc.label(at));
        }
    }
    (!labels.is_empty()).then(|| {
        format!(
            "scene \"{scene}\": {} {} in the page flow that {} mid-scene; outside its time window a .clip takes no space, so everything around it jumps in one frame. Use ONE .clip stage for the whole scene (data-start=\"0\", data-duration = the scene's duration, position:absolute; inset:0) and stagger the entrances with animation-delay on its children, or make this clip position:absolute",
            named(&labels),
            if labels.len() == 1 { "is a .clip" } else { "are .clip elements" },
            if labels.len() == 1 { "appears or ends" } else { "appear or end" }
        )
    })
}

fn layout_keyframes(scene: &str, doc: &Doc) -> Vec<String> {
    let used: Vec<&String> = doc.layers.iter().flatten().map(|l| &l.name).collect();
    doc.css
        .keyframes
        .iter()
        .filter(|(name, _)| used.contains(name))
        .filter_map(|(name, steps)| {
            let mut props: Vec<&str> = steps
                .iter()
                .flat_map(|(_, decls)| decls.iter().map(|(p, _)| p.as_str()))
                .filter(|p| LAYOUT_PROPS.contains(p))
                .collect();
            props.sort_unstable();
            props.dedup();
            (!props.is_empty()).then(|| {
                format!(
                    "scene \"{scene}\": @keyframes {} animates {}, which re-lays out the scene on every frame (text re-wraps, neighbours move). Animate transform (translate, scale) and opacity instead",
                    name.chars().take(MAX_LABEL).collect::<String>(),
                    props.join(", ")
                )
            })
        })
        .collect()
}

fn cut_by_scene_end(scene: &str, doc: &Doc, duration: f64) -> Option<String> {
    let mut labels = Vec::new();
    for at in 0..doc.elements.len() {
        let start = doc.clip_start(at);
        let end = doc.layers[at]
            .iter()
            .map(|l| start + l.delay + l.duration * l.iterations.max(0.0))
            .fold(0.0, f64::max);
        if end > duration + EPS {
            labels.push(format!(
                "{} (ends at {} s)",
                doc.label(at),
                project::fmt_seconds(project::round_ms(end))
            ));
        }
    }
    (!labels.is_empty()).then(|| {
        format!(
            "scene \"{scene}\" lasts {} s but {} still animating when it ends, so the movement is cut. Shorten the delays or durations (entrances done at least 0.5 s before the scene ends) or lengthen the scene",
            project::fmt_seconds(duration),
            if labels.len() == 1 {
                format!("{} is", named(&labels))
            } else {
                format!("{} are", named(&labels))
            }
        )
    })
}

fn popping_fills(scene: &str, doc: &Doc) -> Option<String> {
    let mut labels = Vec::new();
    for at in 0..doc.elements.len() {
        if doc.uncertain[at] {
            continue;
        }
        let resting_opacity = doc.resting(at, "opacity").and_then(|v| opacity(&v));
        let hidden_at_rest = resting_opacity.is_some_and(|o| o <= 0.01);
        for layer in &doc.layers[at] {
            let Some(steps) = doc.css.keyframes.get(&layer.name) else {
                continue;
            };
            let (first, last) = edge_steps(steps);
            let backwards = matches!(layer.fill.as_str(), "backwards" | "both");
            let forwards = matches!(layer.fill.as_str(), "forwards" | "both");
            // Delayed, not filled backwards: rests visibly, then snaps to
            // its first keyframe when the delay ends.
            let first_moves = first.iter().any(|(p, v)| {
                TRANSFORM_PROPS.contains(&p.as_str())
                    || (p == "opacity" && opacity(v).is_some_and(|o| o < 0.99))
            });
            let snaps_in = layer.delay > EPS && !backwards && !hidden_at_rest && first_moves;
            // Hidden at rest, shown by the animation, not filled forwards:
            // vanishes when the entrance ends.
            let shows = last
                .iter()
                .any(|(p, v)| p == "opacity" && opacity(v).is_some_and(|o| o > 0.01));
            let vanishes = hidden_at_rest && !forwards && shows;
            if snaps_in || vanishes {
                labels.push(doc.label(at));
                break;
            }
        }
    }
    (!labels.is_empty()).then(|| {
        format!(
            "scene \"{scene}\": {} {} animation-fill-mode: both, so it pops (a delayed animation shows the resting style and then snaps to its first keyframe; an element at opacity 0 disappears again when its entrance ends). Add both to the animation",
            named(&labels),
            if labels.len() == 1 { "lacks" } else { "lack" }
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene(style: &str, body: &str) -> String {
        format!(
            "<template id=\"s-template\"><style>#root{{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}}{style}</style>\
             <div id=\"root\" data-composition-id=\"s\" data-width=\"1920\" data-height=\"1080\">{body}</div></template>"
        )
    }

    /// The shape the tester's video had (one in-flow .clip per staggered
    /// line inside a centered flex column).
    const STAGGERED_CLIPS: &str = "<div id=\"s-copy\">\
        <div class=\"clip\" data-start=\"0.1\" data-duration=\"5.7\"><div class=\"s-kicker\">Kicker</div></div>\
        <div class=\"clip\" data-start=\"0.35\" data-duration=\"5.45\"><h2 class=\"s-big\">Big</h2></div>\
        <div class=\"clip\" data-start=\"1.2\" data-duration=\"4.6\"><div class=\"s-bar\"></div></div>\
        <div class=\"clip\" data-start=\"1.5\" data-duration=\"4.3\"><p class=\"s-note\">Note</p></div>\
        </div>";
    const ENTRANCE_CSS: &str = "#s-copy{display:flex;flex-direction:column;gap:2vmin}\
        .s-kicker,.s-big,.s-bar,.s-note{opacity:0;animation:s-in .7s ease-out both}\
        @keyframes s-in{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}";

    #[test]
    fn staggered_in_flow_clips_are_flagged() {
        let warnings = lint_scene("s", &scene(ENTRANCE_CSS, STAGGERED_CLIPS), 5.8);
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        let w = &warnings[0];
        assert!(w.starts_with("scene \"s\":"), "{w}");
        assert!(w.contains("data-start=\"0.1\""), "{w}");
        assert!(w.contains("and 1 more"), "{w}");
        assert!(w.contains("jumps"), "{w}");
        assert!(w.contains("ONE .clip stage"), "{w}");
        assert!(w.contains("animation-delay"), "{w}");
    }

    #[test]
    fn one_stage_with_animation_delays_is_clean() {
        let css = format!(
            "{ENTRANCE_CSS}.s-stage{{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}}\
             .s-big{{animation-delay:.25s}}"
        );
        let body = "<div class=\"clip s-stage\" data-start=\"0\" data-duration=\"5.8\">\
            <div class=\"s-kicker\">Kicker</div>\
            <h2 class=\"s-big\">Big</h2>\
            <p class=\"s-note\" style=\"animation-delay:1.5s\">Note</p></div>";
        assert_eq!(
            lint_scene("s", &scene(&css, body), 5.8),
            Vec::<String>::new()
        );
    }

    #[test]
    fn clips_that_cannot_move_their_neighbours_are_not_flagged() {
        // Absolutely positioned (class rule, inline style, even only in a
        // media query: conservative), alone in its parent, covering the
        // whole scene, or holding a timed descendant.
        let cases = [
            (
                ".s-tag{position:absolute;top:6%;left:6%}",
                "<p>a</p><div class=\"clip s-tag\" data-start=\"1\" data-duration=\"2\">x</div>",
            ),
            (
                "",
                "<p>a</p><div class=\"clip\" style=\"position: fixed\" data-start=\"1\">x</div>",
            ),
            (
                "@media (max-aspect-ratio: 3/4){#s-cap{position:absolute}}",
                "<p>a</p><div id=\"s-cap\" class=\"clip\" data-start=\"1\">x</div>",
            ),
            (
                "",
                "<div><div class=\"clip\" data-start=\"1\" data-duration=\"1\">alone</div></div>",
            ),
            (
                "",
                "<p>a</p><div class=\"clip\" data-start=\"0\" data-duration=\"4\">whole scene</div>",
            ),
            (
                "",
                "<p>a</p><div class=\"clip\" data-start=\"0\">no duration: to the end</div>",
            ),
            (
                "",
                "<p>a</p><div class=\"clip\" data-start=\"1\"><span class=\"clip\" data-start=\"2\">x</span></div>",
            ),
            (
                "",
                "<p>a</p><div class=\"clip\" data-start=\"intro-title\">not a number</div>",
            ),
        ];
        for (css, body) in cases {
            assert_eq!(
                lint_scene("s", &scene(css, body), 4.0),
                Vec::<String>::new(),
                "{css} {body}"
            );
        }
        // A clip that ENDS mid-scene moves its neighbours too.
        let ends =
            "<p>a</p><div id=\"s-x\" class=\"clip\" data-start=\"0\" data-duration=\"2\">x</div>";
        let w = lint_scene("s", &scene("", ends), 4.0);
        assert!(w[0].contains("#s-x is a .clip"), "{w:?}");
    }

    #[test]
    fn keyframes_on_layout_properties_are_flagged_when_used() {
        let css = "@keyframes bar{from{width:0;opacity:0}to{width:80%;opacity:1}}\
            @keyframes slide{from{left:100%}to{left:50%}}\
            @keyframes unused{from{height:0}to{height:10px}}\
            .s-bar{animation:bar 1s ease-out both}\
            .s-divider{position:absolute;animation:slide 1s both}";
        let body = "<div class=\"s-bar\"></div><div class=\"s-divider\"></div>";
        let w = lint_scene("s", &scene(css, body), 4.0);
        assert_eq!(w.len(), 1, "{w:?}");
        assert!(w[0].contains("@keyframes bar animates width"), "{w:?}");
        assert!(w[0].contains("transform"), "{w:?}");
    }

    #[test]
    fn animations_cut_by_the_scene_end_are_flagged() {
        let css = "@keyframes in{from{opacity:0}to{opacity:1}}\
            .s-a{animation:in 1s ease-out .5s both}\
            .s-b{animation:in .5s 3 both}";
        let body = "<div class=\"clip s-stage\" data-start=\"0\">\
            <div class=\"clip\" style=\"position:absolute\" data-start=\"4\"><p class=\"s-a\">a</p></div>\
            <p class=\"s-b\">b</p></div>";
        // .s-a ends at 4 + 0.5 + 1 = 5.5; .s-b at 1.5.
        let w = lint_scene("s", &scene(css, body), 5.0);
        assert_eq!(w.len(), 1, "{w:?}");
        assert!(w[0].contains("lasts 5 s"), "{w:?}");
        assert!(w[0].contains(".s-a (ends at 5.5 s) is"), "{w:?}");
        assert_eq!(
            lint_scene("s", &scene(css, body), 5.5),
            Vec::<String>::new()
        );
        // Iterations count: 3 x 0.5 s.
        let w = lint_scene("s", &scene(css, body), 1.2);
        assert!(w[0].contains(".s-b (ends at 1.5 s)"), "{w:?}");
    }

    #[test]
    fn fills_that_pop_are_flagged() {
        let keyframes =
            "@keyframes in{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}";
        // Delayed without a backwards fill: visible during the delay.
        let w = lint_scene(
            "s",
            &scene(
                &format!("{keyframes}.s-a{{animation:in .6s ease-out .4s}}"),
                "<p class=\"s-a\">a</p>",
            ),
            4.0,
        );
        assert!(
            w[0].contains(".s-a lacks animation-fill-mode: both"),
            "{w:?}"
        );
        // Hidden at rest and not filled forwards: vanishes at the end.
        let w = lint_scene(
            "s",
            &scene(
                &format!("{keyframes}.s-a{{opacity:0;animation:in .6s ease-out backwards}}"),
                "<p class=\"s-a\">a</p>",
            ),
            4.0,
        );
        assert!(w[0].contains("pops"), "{w:?}");
        // The right ones.
        for css in [
            ".s-a{opacity:0;animation:in .6s ease-out .4s both}",
            ".s-a{animation:in .6s ease-out .4s;animation-fill-mode:both}",
            ".s-a{opacity:0;animation:in .6s ease-out .4s forwards}",
            ".s-a{animation:in .6s ease-out}",
        ] {
            assert_eq!(
                lint_scene(
                    "s",
                    &scene(&format!("{keyframes}{css}"), "<p class=\"s-a\">a</p>"),
                    4.0
                ),
                Vec::<String>::new(),
                "{css}"
            );
        }
    }

    #[test]
    fn selectors_it_does_not_understand_never_warn() {
        // Pseudo-classes and sibling combinators: not matched strictly, so
        // no animation is assumed (and loose matching keeps absolute).
        let css = "@keyframes up{from{transform:translateY(9px)}to{transform:none}}\
            #s-list li:nth-child(2){animation:up 9s both}\
            #s-list + p{animation:up 9s both}\
            p::before{position:absolute}";
        let body = "<ul id=\"s-list\"><li>a</li><li>b</li></ul><p>c</p>";
        assert_eq!(
            lint_scene("s", &scene(css, body), 1.0),
            Vec::<String>::new()
        );
    }

    #[test]
    fn hostile_or_broken_input_never_panics() {
        for html in [
            "",
            "<template>",
            "<style>}}}{{{</style><div class=clip data-start=1>",
            "<style>@keyframes{</style>",
            "<style>a{animation:}</style><a>",
            "<style>.x{animation:x 1s,,, ;}</style><b class=x>",
            "</div></div><div class=\"clip\" data-start=\"-3\" data-duration=\"nan\">",
            "<style>/* unterminated",
            "<style>@media{@media{.a{position:absolute}</style><i class=a/>",
        ] {
            let _ = lint_scene("s", html, 2.0);
        }
        // Labels quoted back are clipped and printable.
        let long = format!(
            "<p>a</p><div id=\"{}\u{202e}\" class=\"clip\" data-start=\"1\">x</div>",
            "a".repeat(200)
        );
        let w = lint_scene("s", &scene("", &long), 4.0);
        assert!(w[0].contains(&format!("#{}", "a".repeat(MAX_LABEL - 1))));
        assert!(!w[0].contains('\u{202e}'));
        assert!(!w[0].contains(&"a".repeat(MAX_LABEL)));
    }
}
