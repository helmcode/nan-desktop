//! Browser approval policy (pure, unit-tested). See SECURITY.md, "In-app
//! browser", for the user-facing description.
//!
//! 1. **Sites.** The agent works on a site (host, `www.` ignored) only
//!    after it is approved for the conversation. In `ask` mode the first
//!    action on each site shows an inline card; approving remembers the
//!    site for that conversation (until the app restarts or the account
//!    changes). When every working folder of the conversation is in
//!    `allow` mode, public sites run without a prompt (re-evaluated on every
//!    action, never remembered, so a folder switched back to `ask` takes
//!    effect at once). Local-network addresses ask in every mode, once per
//!    conversation.
//! 2. **Secrets are never typed by the agent.** Password, verification
//!    code and payment-card fields are blocked for `browser_type` in every
//!    mode: the user fills them in themselves in the visible window.
//! 3. **Logins and payments always ask.** Submitting a form with a password
//!    or payment field, or pressing a control whose label reads like a
//!    payment / purchase / sign-in, shows a card EVERY time, even in
//!    `allow` mode and on an approved site.
//!
//! The facts come from the page and are untrusted: a hostile page can hide
//! that a field is a password. These rules add friction for honest pages
//! (the common case: the user's own bank, shop or email), they do not make
//! a hostile page safe. Isolation does that (SECURITY.md).

use super::page::{Description, FieldFacts};

/// What a field is, for the typing rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldClass {
    Normal,
    Password,
    OneTimeCode,
    Payment,
}

fn words(facts: &FieldFacts) -> String {
    format!("{} {} {}", facts.name, facts.id_attr, facts.label).to_lowercase()
}

fn has_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

const OTP_WORDS: &[&str] = &[
    "one-time",
    "one_time",
    "onetime",
    "otp",
    "2fa",
    "mfa",
    "totp",
    "verification code",
    "verification_code",
    "verificationcode",
    "security code",
    "código de verificación",
    "codigo de verificacion",
    "código de seguridad",
];

const PAYMENT_WORDS: &[&str] = &[
    "card number",
    "cardnumber",
    "card_number",
    "card-number",
    "ccnum",
    "cc-num",
    "cc_num",
    "creditcard",
    "credit card",
    "cvv",
    "cvc",
    "csc",
    "expiry",
    "expiration",
    "exp-date",
    "exp_date",
    "iban",
    "número de tarjeta",
    "numero de tarjeta",
    "tarjeta",
    "caducidad",
];

const PASSWORD_WORDS: &[&str] = &["password", "passwd", "contraseña", "contrasena", "passcode"];

/// Classify a field from what the page says about it. Only text inputs
/// can be sensitive; buttons and links are always `Normal` here.
pub fn classify_field(facts: &FieldFacts) -> FieldClass {
    let tag = facts.tag.as_str();
    let kind = facts.kind.as_str();
    if !matches!(tag, "input" | "textarea") {
        return FieldClass::Normal;
    }
    if tag == "input"
        && matches!(
            kind,
            "submit" | "button" | "reset" | "image" | "checkbox" | "radio" | "hidden" | "file"
        )
    {
        return FieldClass::Normal;
    }
    let autocomplete = facts.autocomplete.as_str();
    if kind == "password"
        || autocomplete.contains("current-password")
        || autocomplete.contains("new-password")
    {
        return FieldClass::Password;
    }
    if autocomplete.contains("one-time-code") {
        return FieldClass::OneTimeCode;
    }
    if autocomplete
        .split_whitespace()
        .any(|t| t.starts_with("cc-"))
    {
        return FieldClass::Payment;
    }
    let words = words(facts);
    if has_any(&words, PASSWORD_WORDS) {
        return FieldClass::Password;
    }
    if has_any(&words, OTP_WORDS) {
        return FieldClass::OneTimeCode;
    }
    if has_any(&words, PAYMENT_WORDS) {
        return FieldClass::Payment;
    }
    FieldClass::Normal
}

/// Why a click or a submit needs the user every time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sensitive {
    Login,
    Payment,
}

const PAY_LABELS: &[&str] = &[
    "pay",
    "buy",
    "checkout",
    "check out",
    "place order",
    "purchase",
    "subscribe",
    "donate",
    "pagar",
    "comprar",
    "finalizar compra",
    "tramitar pedido",
    "realizar pedido",
    "confirmar pedido",
    "confirmar compra",
    "confirmar pago",
    "suscribir",
    "suscribirse",
    "suscríbete",
    "donar",
    "transferir",
    "transfer",
    "send money",
    "enviar dinero",
];

const LOGIN_LABELS: &[&str] = &[
    "sign in",
    "signin",
    "sign on",
    "log in",
    "login",
    "iniciar sesión",
    "iniciar sesion",
    "acceder",
    "entrar",
];

/// Whole-word phrase match (`pay` matches "Pay now", not "Display").
fn label_says(label: &str, needles: &[&str]) -> bool {
    // Short labels only: a paragraph that mentions "pay" is not a button.
    if label.chars().count() > 60 {
        return false;
    }
    let normalized = |text: &str| {
        let words: Vec<String> = text
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(str::to_string)
            .collect();
        format!(" {} ", words.join(" "))
    };
    let label = normalized(label);
    needles
        .iter()
        .any(|needle| label.contains(&normalized(needle)))
}

/// Does acting on `element` submit a login or a payment? `submits` is
/// whether the action submits a form (a submit control is clicked, or
/// `browser_type` with `submit: true`).
pub fn sensitive_action(description: &Description, submits: bool) -> Option<Sensitive> {
    let form_classes: Vec<FieldClass> =
        description.form_fields.iter().map(classify_field).collect();
    if submits {
        if form_classes.contains(&FieldClass::Payment) {
            return Some(Sensitive::Payment);
        }
        if form_classes
            .iter()
            .any(|c| matches!(c, FieldClass::Password | FieldClass::OneTimeCode))
        {
            return Some(Sensitive::Login);
        }
    }
    // A button/link that reads like a purchase asks even outside a form
    // (one-click checkouts are plain buttons wired with scripts).
    let label = &description.field.label;
    if label_says(label, PAY_LABELS) {
        return Some(Sensitive::Payment);
    }
    // A sign-in button on a page with a password field asks even when it
    // is not a form submit (sign-in buttons wired with scripts).
    if (submits || description.page_has_password) && label_says(label, LOGIN_LABELS) {
        return Some(Sensitive::Login);
    }
    None
}

/// The verdict for one action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// Go ahead.
    Run,
    /// Ask to use this site (remembered for the conversation once granted).
    AskSite { private: bool },
    /// Ask for this single submit (never remembered).
    AskSensitive(Sensitive),
    /// Never: the user must do it themselves.
    Block(FieldClass),
}

/// The site rule: may the agent act on a site?
pub fn site_gate(site_approved: bool, allow_mode: bool, private: bool) -> Gate {
    if site_approved || (allow_mode && !private) {
        Gate::Run
    } else {
        Gate::AskSite { private }
    }
}

/// Whether a site may run without its card because the user chose not to
/// be asked (the browser permission mode, stored or for this session, or
/// every folder of the conversation in allow mode). A local-network
/// address never does. Pure.
pub fn runs_without_site_card(private: bool, browser_allows: bool, folders_allow: bool) -> bool {
    !private && (browser_allows || folders_allow)
}

/// The typing rule, checked before anything else for `browser_type`.
pub fn typing_gate(field: &FieldFacts) -> Gate {
    match classify_field(field) {
        FieldClass::Normal => Gate::Run,
        class => Gate::Block(class),
    }
}

/// The submit rule for clicks and `browser_type(submit: true)`.
pub fn submit_gate(description: &Description, submits: bool) -> Gate {
    match sensitive_action(description, submits) {
        Some(kind) => Gate::AskSensitive(kind),
        None => Gate::Run,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(tag: &str, kind: &str) -> FieldFacts {
        FieldFacts {
            tag: tag.into(),
            kind: kind.into(),
            ..FieldFacts::default()
        }
    }

    fn named(tag: &str, kind: &str, name: &str, label: &str) -> FieldFacts {
        FieldFacts {
            name: name.into(),
            label: label.into(),
            ..field(tag, kind)
        }
    }

    #[test]
    fn passwords_codes_and_cards_are_recognised() {
        assert_eq!(
            classify_field(&field("input", "password")),
            FieldClass::Password
        );
        let auto = |value: &str| FieldFacts {
            autocomplete: value.into(),
            ..field("input", "text")
        };
        assert_eq!(
            classify_field(&auto("current-password")),
            FieldClass::Password
        );
        assert_eq!(
            classify_field(&auto("section-a new-password")),
            FieldClass::Password
        );
        assert_eq!(
            classify_field(&auto("one-time-code")),
            FieldClass::OneTimeCode
        );
        assert_eq!(classify_field(&auto("cc-number")), FieldClass::Payment);
        assert_eq!(classify_field(&auto("billing cc-csc")), FieldClass::Payment);
        assert_eq!(
            classify_field(&named("input", "text", "cardnumber", "")),
            FieldClass::Payment
        );
        assert_eq!(
            classify_field(&named("input", "tel", "", "CVV")),
            FieldClass::Payment
        );
        assert_eq!(
            classify_field(&named("input", "text", "", "Número de tarjeta")),
            FieldClass::Payment
        );
        assert_eq!(
            classify_field(&named("input", "text", "otp", "")),
            FieldClass::OneTimeCode
        );
        assert_eq!(
            classify_field(&named("input", "text", "", "Contraseña")),
            FieldClass::Password
        );
    }

    #[test]
    fn ordinary_fields_and_controls_are_normal() {
        for facts in [
            named("input", "email", "email", "Correo"),
            named("input", "search", "q", "Buscar"),
            named("textarea", "", "message", "Mensaje"),
            field("input", "checkbox"),
            named("button", "submit", "", "Password reset"),
            named("a", "", "", "Forgot your password?"),
            named("input", "submit", "", "Contraseña"),
        ] {
            assert_eq!(classify_field(&facts), FieldClass::Normal, "{facts:?}");
        }
    }

    #[test]
    fn the_agent_never_types_secrets_in_any_mode() {
        assert_eq!(
            typing_gate(&field("input", "password")),
            Gate::Block(FieldClass::Password)
        );
        assert_eq!(
            typing_gate(&named("input", "text", "cc-cvc", "")),
            Gate::Block(FieldClass::Payment)
        );
        assert_eq!(
            typing_gate(&named("input", "text", "city", "Ciudad")),
            Gate::Run
        );
    }

    fn description(label: &str, is_submit: bool, form: Vec<FieldFacts>) -> Description {
        Description {
            field: named("button", "submit", "", label),
            in_form: !form.is_empty(),
            is_submit,
            form_fields: form,
            ..Description::default()
        }
    }

    #[test]
    fn submitting_a_login_or_payment_form_always_asks() {
        let login = description(
            "Continue",
            true,
            vec![field("input", "email"), field("input", "password")],
        );
        assert_eq!(
            submit_gate(&login, true),
            Gate::AskSensitive(Sensitive::Login)
        );
        let card = description(
            "Continue",
            true,
            vec![FieldFacts {
                autocomplete: "cc-number".into(),
                ..field("input", "text")
            }],
        );
        assert_eq!(
            submit_gate(&card, true),
            Gate::AskSensitive(Sensitive::Payment)
        );
        // Same forms, but the action does not submit (e.g. a "show
        // password" toggle): no prompt.
        assert_eq!(submit_gate(&login, false), Gate::Run);
    }

    #[test]
    fn purchase_buttons_ask_even_outside_a_form() {
        for label in [
            "Pay now",
            "Comprar ahora",
            "Finalizar compra",
            "Place order",
            "Suscribirse",
        ] {
            assert_eq!(
                submit_gate(&description(label, false, vec![]), false),
                Gate::AskSensitive(Sensitive::Payment),
                "{label}"
            );
        }
        // A sign-in LINK that only opens the login page does not ask...
        assert_eq!(
            submit_gate(&description("Iniciar sesión", false, vec![]), false),
            Gate::Run
        );
        // ...but submitting with that label does.
        assert_eq!(
            submit_gate(
                &description("Iniciar sesión", true, vec![field("input", "email")]),
                true
            ),
            Gate::AskSensitive(Sensitive::Login)
        );
        // A scripted sign-in button on a page with a password field asks.
        let scripted = Description {
            page_has_password: true,
            ..description("Sign in", false, vec![])
        };
        assert_eq!(
            submit_gate(&scripted, false),
            Gate::AskSensitive(Sensitive::Login)
        );
        // Plain search submit: no prompt.
        assert_eq!(
            submit_gate(
                &description("Buscar", true, vec![field("input", "search")]),
                true
            ),
            Gate::Run
        );
        // Whole words only.
        assert_eq!(
            submit_gate(&description("Display options", false, vec![]), false),
            Gate::Run
        );
        // Long text that mentions paying is not a button label.
        let long = "Read our guide about how to pay less for your electricity bill this winter";
        assert_eq!(
            submit_gate(&description(long, false, vec![]), false),
            Gate::Run
        );
    }

    #[test]
    fn sites_ask_once_per_conversation_and_local_network_asks_in_every_mode() {
        assert_eq!(
            site_gate(false, false, false),
            Gate::AskSite { private: false }
        );
        assert_eq!(site_gate(true, false, false), Gate::Run);
        // allow mode: public sites run, local network still asks.
        assert_eq!(site_gate(false, true, false), Gate::Run);
        assert_eq!(
            site_gate(false, true, true),
            Gate::AskSite { private: true }
        );
        assert_eq!(site_gate(true, true, true), Gate::Run);
    }

    #[test]
    fn the_browser_permission_skips_only_public_site_cards() {
        // ask (no folder allow): every new site asks.
        assert!(!runs_without_site_card(false, false, false));
        // allow (stored or this session) or every folder allows: public
        // sites run without the card.
        assert!(runs_without_site_card(false, true, false));
        assert!(runs_without_site_card(false, false, true));
        // A local-network address asks in every mode.
        for (browser, folders) in [(true, false), (false, true), (true, true)] {
            assert!(!runs_without_site_card(true, browser, folders));
            assert_eq!(
                site_gate(false, runs_without_site_card(true, browser, folders), true),
                Gate::AskSite { private: true }
            );
        }
        // Typing and submit rules take no mode at all: passwords are never
        // typed and sign-in still asks, whatever the browser permission.
        assert_eq!(
            typing_gate(&field("input", "password")),
            Gate::Block(FieldClass::Password)
        );
    }
}
