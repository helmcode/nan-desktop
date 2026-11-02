//! Inline approval requests (S14).
//!
//! In `ask` mode an action is approved through a card in the chat stream
//! instead of a native dialog. The card is only the AFFORDANCE: the core
//! creates every request ([`ApprovalBroker::register`]), emits it as a
//! `tools://approval-request` event and waits for the answer. The renderer
//! can only ANSWER a request that is currently pending
//! (`tools_approval_respond` → [`ApprovalBroker::respond`]): unknown,
//! answered, expired or abandoned ids are rejected, so a compromised
//! renderer can neither originate an approval nor replay one. Each answer
//! is single-use. A request that is not answered within its deadline counts
//! as declined.
//!
//! The pending entry is owned by an RAII [`ApprovalTicket`]: when the
//! waiting chat task finishes or is aborted (stop button, new message), the
//! ticket drops and the id stops being answerable.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::oneshot;

use super::Rejection;

/// `tools://approval-request` payload: everything the card shows. Built by
/// the core from the STORED proposal (never from renderer input). `title`
/// and `text` are ready-made Spanish copy (the native dialog wording); the
/// structured fields let the renderer localize.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApprovalRequest {
    pub approval_id: String,
    pub conversation_id: Option<i64>,
    /// Tool action kind (`write_file`, `delete_path`, `run_command`, …).
    pub action: String,
    pub title: String,
    pub text: String,
    pub summary: String,
    pub path: Option<String>,
    /// move_path destination.
    pub dest_path: Option<String>,
    /// run_command command line.
    pub command: Option<String>,
    /// Bounded change preview for writes.
    pub diff_preview: Option<String>,
    /// delete_path without a reachable trash.
    pub permanent: bool,
    pub expires_in_secs: u64,
}

/// `tools://approval-resolved` payload: the request is closed (answered,
/// expired or abandoned) and its card must stop accepting input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApprovalResolved {
    pub approval_id: String,
    pub granted: bool,
}

/// Pending inline approvals keyed by approval id.
#[derive(Default)]
pub struct ApprovalBroker {
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

/// Ownership of one pending request; dropping it withdraws the request.
pub struct ApprovalTicket<'a> {
    broker: &'a ApprovalBroker,
    pub id: String,
    receiver: Option<oneshot::Receiver<bool>>,
}

impl ApprovalBroker {
    /// Create a pending request with a fresh unguessable id.
    pub fn register(&self) -> Result<ApprovalTicket<'_>, Rejection> {
        let (sender, receiver) = oneshot::channel();
        let id = uuid::Uuid::new_v4().to_string();
        self.pending
            .lock()
            .map_err(|_| Rejection::new("io", "approval state poisoned"))?
            .insert(id.clone(), sender);
        Ok(ApprovalTicket {
            broker: self,
            id,
            receiver: Some(receiver),
        })
    }

    /// Answer a pending request (single-use). Unknown, already answered or
    /// withdrawn ids are rejected with `unknown_approval`.
    pub fn respond(&self, approval_id: &str, granted: bool) -> Result<(), Rejection> {
        let sender = self
            .pending
            .lock()
            .map_err(|_| Rejection::new("io", "approval state poisoned"))?
            .remove(approval_id)
            .ok_or_else(|| {
                Rejection::new(
                    "unknown_approval",
                    "no pending approval request with this id",
                )
            })?;
        sender.send(granted).map_err(|_| {
            Rejection::new(
                "unknown_approval",
                "the approval request is no longer waiting",
            )
        })
    }

    /// Number of requests currently answerable.
    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.pending.lock().map(|map| map.len()).unwrap_or(0)
    }

    fn withdraw(&self, approval_id: &str) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(approval_id);
        }
    }
}

impl ApprovalTicket<'_> {
    /// Wait for the user's answer. Anything but an explicit grant within
    /// `timeout` (deny, timeout, withdrawn) is `false`. The request is
    /// withdrawn when this returns.
    pub async fn wait(mut self, timeout: Duration) -> bool {
        let Some(receiver) = self.receiver.take() else {
            return false;
        };
        matches!(tokio::time::timeout(timeout, receiver).await, Ok(Ok(true)))
    }
}

impl Drop for ApprovalTicket<'_> {
    fn drop(&mut self) {
        self.broker.withdraw(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn renderer_cannot_answer_an_id_the_core_never_created() {
        let broker = ApprovalBroker::default();
        let err = broker.respond("forged-id", true).expect_err("forged");
        assert_eq!(err.kind, "unknown_approval");
        assert_eq!(broker.pending_count(), 0);
    }

    #[test]
    fn a_grant_resolves_the_waiting_request_once() {
        let broker = ApprovalBroker::default();
        let ticket = broker.register().expect("register");
        let id = ticket.id.clone();
        assert_eq!(broker.pending_count(), 1);
        broker.respond(&id, true).expect("answer");
        assert!(block_on(ticket.wait(Duration::from_secs(5))), "granted");
        // Single-use: replaying the same answer is rejected.
        assert_eq!(
            broker.respond(&id, true).expect_err("replay").kind,
            "unknown_approval"
        );
        assert_eq!(broker.pending_count(), 0);
    }

    #[test]
    fn a_deny_or_a_timeout_is_not_a_grant() {
        let broker = ApprovalBroker::default();
        let ticket = broker.register().expect("register");
        broker.respond(&ticket.id.clone(), false).expect("deny");
        assert!(!block_on(ticket.wait(Duration::from_secs(5))));

        let ticket = broker.register().expect("register");
        let id = ticket.id.clone();
        assert!(!block_on(ticket.wait(Duration::from_millis(20))), "timeout");
        assert_eq!(
            broker.respond(&id, true).expect_err("expired").kind,
            "unknown_approval",
            "an expired request can no longer be granted"
        );
    }

    #[test]
    fn dropping_the_ticket_withdraws_the_request() {
        let broker = ApprovalBroker::default();
        let ticket = broker.register().expect("register");
        let id = ticket.id.clone();
        drop(ticket); // the chat task was stopped / aborted
        assert_eq!(broker.pending_count(), 0);
        assert_eq!(
            broker.respond(&id, true).expect_err("withdrawn").kind,
            "unknown_approval"
        );
    }

    #[test]
    fn ids_are_unique_per_request() {
        let broker = ApprovalBroker::default();
        let a = broker.register().expect("a");
        let b = broker.register().expect("b");
        assert_ne!(a.id, b.id);
        assert_eq!(broker.pending_count(), 2);
    }
}
