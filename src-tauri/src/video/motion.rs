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
/// Most compound-selector checks one scene may cost (each selector costs
/// its compounds times the elements); above it the scene is not linted.
const MAX_WORK: usize = 4_000_000;
/// Most declarations (plus animation layers) the cascade may resolve over
/// all elements; above it the scene is not linted (bounded time and memory:
/// every resolved animation layer becomes a struct per element).
const MAX_RESOLVED: usize = 1_000_000;
/// Most comma-separated layers in one `animation*` declaration; more and
/// the scene is not linted (no real scene stacks that many).
const MAX_LAYERS: usize = 32;

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
    let Some(elements) = parse_elements(html, &low) else {
        return Vec::new();
    };
    let mut css = Css::default();
    for style in project::blocks(&low, "<style", "</style>") {
        parse_css(&strip_comments(style), &mut css);
    }
    if css.rules.len() > MAX_RULES {
        return Vec::new();
    }
    let inline = elements.iter().flat_map(|el| el.style.iter());
    let all_decls = css.rules.iter().flat_map(|rule| rule.decls.iter());
    if inline
        .chain(all_decls)
        .any(|decl| animation_layers(decl) > MAX_LAYERS)
    {
        return Vec::new();
    }
    let work: usize = css
        .rules
        .iter()
        .flat_map(|rule| rule.selectors.iter())
        .map(|selector| (selector.len() + 1).saturating_mul(elements.len()))
        .fold(0, usize::saturating_add);
    if work > MAX_WORK {
        return Vec::new();
    }
    let strict_hits: Vec<Vec<bool>> = css
        .rules
        .iter()
        .map(|rule| rule_hits(rule, &elements, true))
        .collect();
    let loose_hits: Vec<Vec<bool>> = css
        .rules
        .iter()
        .map(|rule| rule_hits(rule, &elements, false))
        .collect();
    if resolved_cost(&css, &elements, &strict_hits, &loose_hits) > MAX_RESOLVED {
        return Vec::new();
    }
    let mut doc = Doc {
        elements,
        css,
        strict_hits,
        loose_hits,
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

/// Layers in an `animation*` declaration (0 for any other property).
fn animation_layers((prop, value): &(String, String)) -> usize {
    if prop.starts_with("animation") {
        split_top(value, ',').len()
    } else {
        0
    }
}

/// What resolving the cascade costs over all elements: every declaration a
/// rule hands an element (strict and loose, the passes that copy them) plus
/// every animation layer it parses, and the inline declarations.
fn resolved_cost(
    css: &Css,
    elements: &[Element],
    strict_hits: &[Vec<bool>],
    loose_hits: &[Vec<bool>],
) -> usize {
    let mut cost = 0usize;
    for (r, rule) in css.rules.iter().enumerate() {
        let per_element = rule
            .decls
            .iter()
            .map(|decl| 1 + animation_layers(decl))
            .fold(0usize, usize::saturating_add);
        let hits = strict_hits[r].iter().filter(|h| **h).count()
            + loose_hits[r].iter().filter(|h| **h).count();
        cost = cost.saturating_add(per_element.saturating_mul(hits));
    }
    elements
        .iter()
        .flat_map(|el| el.style.iter())
        .map(|decl| 1 + animation_layers(decl))
        .fold(cost, usize::saturating_add)
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
    /// `[rule][element]`: the rule applies (strict matching).
    strict_hits: Vec<Vec<bool>>,
    /// `[rule][element]`: the rule may apply (subject compound only).
    loose_hits: Vec<Vec<bool>>,
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

/// The element tree, or `None` past `MAX_ELEMENTS` (the walk stops there).
fn parse_elements(html: &str, low: &str) -> Option<Vec<Element>> {
    let mut elements: Vec<Element> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    website::for_each_tag(html, low, |name, attributes| {
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
        if elements.len() >= MAX_ELEMENTS {
            return Err("too many elements".into());
        }
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
    })
    .ok()?;
    Some(elements)
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

/// The block opened by the `{` at `open`: `(body, index after the block)`.
/// An unclosed block runs to the end of the text. Every index is at an
/// ASCII brace or the end, so the slices are always on char boundaries.
fn block(css: &str, open: usize) -> (&str, usize) {
    let mut depth = 0usize;
    for (i, c) in css[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    let close = open + i;
                    return (&css[open + 1..close], close + 1);
                }
            }
            _ => {}
        }
    }
    (&css[open + 1..], css.len())
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
        let (body, end) = block(css, open);
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
        let (inner, end) = block(body, open);
        let selector = body[i..open]
            .trim()
            .trim_start_matches('}')
            .trim()
            .to_string();
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

/// Which elements a rule applies to. Strict: the whole chain must match
/// with descendant/child combinators only (anything else is "no match").
/// Loose: only the subject compound.
///
/// Dynamic programming over the tree, never backtracking: elements are in
/// document order (a parent before its children), `here[e]` says the
/// selector's first `k + 1` compounds match with `e` as the k-th, and
/// `below[e]` that `e` or one of its ancestors does. O(compounds x elements)
/// per selector, whatever the nesting.
fn rule_hits(rule: &Rule, elements: &[Element], strict: bool) -> Vec<bool> {
    let mut hits = vec![false; elements.len()];
    for parts in &rule.selectors {
        let Some((_, subject)) = parts.last() else {
            continue;
        };
        if !strict {
            for (hit, el) in hits.iter_mut().zip(elements) {
                *hit |= compound_matches(subject, el, false);
            }
            continue;
        }
        let mut here: Vec<bool> = elements
            .iter()
            .map(|el| compound_matches(&parts[0].1, el, true))
            .collect();
        for (combinator, compound) in &parts[1..] {
            let mut below = vec![false; elements.len()];
            for (e, el) in elements.iter().enumerate() {
                below[e] = here[e] || el.parent.is_some_and(|p| below[p]);
            }
            here = elements
                .iter()
                .map(|el| {
                    compound_matches(compound, el, true)
                        && match combinator {
                            '>' => el.parent.is_some_and(|p| here[p]),
                            ' ' => el.parent.is_some_and(|p| below[p]),
                            _ => false,
                        }
                })
                .collect();
        }
        for (hit, matched) in hits.iter_mut().zip(here) {
            *hit |= matched;
        }
    }
    hits
}

impl Doc {
    /// The declarations that apply to an element, in cascade order
    /// (approximate: source order, inline last).
    fn decls(&self, at: usize, strict: bool) -> Vec<&(String, String)> {
        let hits = if strict {
            &self.strict_hits
        } else {
            &self.loose_hits
        };
        let mut out: Vec<&(String, String)> = self
            .css
            .rules
            .iter()
            .zip(hits)
            .filter(|(_, hit)| hit[at])
            .flat_map(|(rule, _)| rule.decls.iter())
            .collect();
        out.extend(self.elements[at].style.iter());
        out
    }

    /// A rule that may apply (loose) but did not match strictly sets an
    /// animation property.
    fn animation_uncertain(&self, at: usize) -> bool {
        self.css.rules.iter().enumerate().any(|(r, rule)| {
            self.loose_hits[r][at]
                && !self.strict_hits[r][at]
                && rule.decls.iter().any(|(p, _)| p.starts_with("animation"))
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
        printable(&label)
    }
}

/// Model-written text quoted back in a warning: printable ASCII, clipped.
fn printable(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .take(MAX_LABEL)
        .collect()
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

/// `animation-iteration-count`: a number or `infinite` (never ends).
fn iteration_count(token: &str) -> f64 {
    if token == "infinite" {
        f64::INFINITY
    } else {
        token.parse().unwrap_or(1.0)
    }
}

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
                    a.iterations = layers().map(iteration_count).collect()
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
            } else if token == "infinite" || token.parse::<f64>().is_ok() {
                iterations = Some(iteration_count(token));
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
    let used: std::collections::HashSet<&String> =
        doc.layers.iter().flatten().map(|l| &l.name).collect();
    doc.css
        .keyframes
        .iter()
        .filter(|(name, _)| used.contains(*name))
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
                    printable(name),
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
        // A loop (`infinite`) never "ends": it is not cut, it just runs.
        let end = doc.layers[at]
            .iter()
            .filter(|l| l.iterations.is_finite())
            .map(|l| start + l.delay + l.duration * l.iterations.max(0.0))
            .filter(|end| end.is_finite())
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
    fn unclosed_blocks_ending_in_a_multibyte_char_never_panic() {
        // The body of an unclosed block runs to the end; slicing one byte
        // short would split the `é` (a panic aborts the release app).
        for html in [
            "<style>a{b:\u{e9}</style>",
            "<style>@keyframes k{from{b:\u{e9}</style>",
            "<style>@media x{a{b:\u{e9}</style>",
            "<style>a{b:\u{1f422}",
        ] {
            let _ = lint_scene("s", html, 2.0);
        }
        // Every truncation of a multibyte-heavy scene (at char boundaries:
        // the input is a &str).
        let full = scene(
            "@keyframes \u{e9}l\u{e8}ve{from{opacity:0;transform:translateY(1vmin)}to{opacity:1;content:\"\u{1f422}\u{e9}\"}}\
             .s-\u{e9}{opacity:0;animation:\u{e9}l\u{e8}ve .6s ease-out .2s both}\
             @media (max-aspect-ratio:3/4){.s-\u{e9}{width:\u{e9}m\u{e9}}}",
            "<div class=\"clip s-\u{e9}\" data-start=\"1\" data-duration=\"1\">tortuga \u{1f422} \u{f1}and\u{fa}</div><p>\u{e9}t\u{e9}</p>",
        );
        for (at, _) in full.char_indices() {
            let _ = lint_scene("s", &full[..at], 2.0);
        }
    }

    #[test]
    fn deep_nesting_with_long_descendant_selectors_is_fast() {
        // Backtracking descendant matching is C(depth, steps): this took
        // tens of seconds before. Now O(steps x elements).
        let depth = 200;
        let body = format!(
            "{}<span class=\"s-x\">x</span>{}",
            "<div>".repeat(depth),
            "</div>".repeat(depth)
        );
        let css = "@keyframes x{from{width:0}to{width:1px}}\
            span div div div div div div div{animation:x 1s}\
            div div div div div div div span{animation:x 1s both}\
            div div div div div div div div{position:absolute}";
        let started = std::time::Instant::now();
        let warnings = lint_scene("s", &scene(css, &body), 4.0);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
        // And it still matches correctly at depth.
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("@keyframes x animates width")),
            "{warnings:?}"
        );
    }

    #[test]
    fn work_and_size_budgets_skip_the_lint() {
        // Too many elements: the walk stops and nothing is reported.
        let many = format!(
            "<p>a</p>{}",
            "<div class=\"clip\" data-start=\"1\" data-duration=\"1\">x</div>"
                .repeat(MAX_ELEMENTS + 1)
        );
        assert_eq!(
            lint_scene("s", &scene("", &many), 4.0),
            Vec::<String>::new()
        );
        // Selectors x elements past the work budget: skipped, not slow.
        let rules: String = (0..900)
            .map(|i| format!(".a{i} .b .c .d .e .f{{color:red}}"))
            .collect();
        let body =
            "<div class=\"clip\" data-start=\"1\" data-duration=\"1\">x</div><p>a</p>".repeat(900);
        let started = std::time::Instant::now();
        assert_eq!(
            lint_scene("s", &scene(&rules, &body), 4.0),
            Vec::<String>::new()
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn huge_layer_lists_and_declaration_floods_are_bounded() {
        let elements = "<p class=\"s-p\">a</p>".repeat(1999);
        let check = |css: &str, body: &str| {
            let started = std::time::Instant::now();
            let warnings = lint_scene("s", &scene(css, body), 4.0);
            assert!(
                started.elapsed() < std::time::Duration::from_secs(1),
                "{:?}",
                started.elapsed()
            );
            warnings
        };
        // 50k layers in one declaration (was 25 s and 11 GB): skipped.
        let many = vec!["a 9s"; 50_000].join(",");
        assert_eq!(
            check(&format!("p{{animation:{many}}}"), &elements),
            Vec::<String>::new()
        );
        // Also as a longhand and inline.
        let names = vec!["a"; MAX_LAYERS + 1].join(",");
        assert_eq!(
            check(&format!("p{{animation-name:{names}}}"), &elements),
            Vec::<String>::new()
        );
        assert_eq!(
            check("", &format!("<p style=\"animation:{names}\">a</p>")),
            Vec::<String>::new()
        );
        // 100k plain declarations handed to 1999 elements: over budget.
        let flood = "b:c;".repeat(100_000);
        assert_eq!(
            check(&format!("p{{{flood}}}"), &elements),
            Vec::<String>::new()
        );
        // Within the caps it still lints: MAX_LAYERS layers on every <p>.
        let ok = vec!["a 1s"; MAX_LAYERS].join(",");
        let css = format!("@keyframes a{{from{{width:0}}to{{width:1px}}}}.s-p{{animation:{ok}}}");
        let w = check(&css, &"<p class=\"s-p\">a</p>".repeat(500));
        assert!(
            w.iter().any(|w| w.contains("@keyframes a animates width")),
            "{w:?}"
        );
    }

    #[test]
    fn infinite_loops_are_parsed_and_never_reported_as_cut() {
        let css = "@keyframes pulse{0%,100%{scale:1}50%{scale:1.1}}\
            .s-a{animation:pulse 2s ease-in-out infinite}\
            .s-b{animation:pulse 2s;animation-iteration-count:infinite}\
            .s-c{animation:pulse 2s ease-in-out 3}";
        let body = "<p class=\"s-a\">a</p><p class=\"s-b\">b</p><p class=\"s-c\">c</p>";
        let w = lint_scene("s", &scene(css, body), 4.0);
        assert_eq!(w.len(), 1, "{w:?}");
        assert!(w[0].contains(".s-c (ends at 6 s)"), "{w:?}");
        assert!(!w[0].contains("s-a") && !w[0].contains("s-b"), "{w:?}");
        // The name is the keyframes, not "infinite".
        let mut a = Animation::default();
        a.push_shorthand("pulse 2s ease-in-out infinite");
        assert_eq!(a.names, ["pulse"]);
        assert!(a.iterations[0].is_infinite());
    }

    #[test]
    fn keyframe_names_are_quoted_printable_and_clipped() {
        let name = format!("k{}\u{202e}{}", "\u{e9}".repeat(3), "z".repeat(80));
        let css = format!(
            "@keyframes {name}{{from{{width:0}}to{{width:9px}}}}.s-a{{animation:{name} 1s both}}"
        );
        let w = lint_scene("s", &scene(&css, "<p class=\"s-a\">a</p>"), 4.0);
        assert_eq!(w.len(), 1, "{w:?}");
        assert!(
            !w[0].contains('\u{202e}') && !w[0].contains('\u{e9}'),
            "{w:?}"
        );
        assert!(
            w[0].contains(&format!(
                "@keyframes k{} animates",
                "z".repeat(MAX_LABEL - 1)
            )),
            "{w:?}"
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
