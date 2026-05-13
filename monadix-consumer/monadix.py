"""
monadix.py — Monadix consumer helper (Python 3.9+, stdlib only)

Place this file alongside monadix.key and monadix.signing-key.
Run:  python monadix.py
"""

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).parent


def _load_key(filename: str) -> str:
    return (BASE_DIR / filename).read_text(encoding="utf-8").strip()


def _signed_request(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    api_key = _load_key("monadix.key")
    signing_key = _load_key("monadix.signing-key")
    raw_body = "" if body is None else json.dumps(body, separators=(",", ":"))
    timestamp = str(int(time.time() * 1000))
    signed_payload = f"{timestamp}.{raw_body}"
    signature = hmac.new(
        signing_key.encode(), signed_payload.encode(), hashlib.sha256
    ).hexdigest()
    data = raw_body.encode() if raw_body else None
    headers = {
        "Authorization": f"Bearer {api_key}",
        "X-Monadix-Timestamp": timestamp,
        "X-Monadix-Signature": signature,
    }
    if method == "POST":
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        f"https://api.monadix.ai{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode()
            return resp.status, (json.loads(text) if text else {})
    except urllib.error.HTTPError as err:
        text = err.read().decode() if err.fp else ""
        try:
            parsed = json.loads(text) if text else {}
        except json.JSONDecodeError:
            parsed = {"raw": text}
        raise MonadixAPIError(err.code, parsed, text) from err


class MonadixAPIError(Exception):
    def __init__(self, status: int, body: dict, text: str) -> None:
        super().__init__(f"Monadix API error: {status} {text}")
        self.status = status
        self.body = body


def call_monadix(path: str, body: dict | None = None) -> dict:
    """
    Send a signed POST request to the Monadix API.
    Credentials are read fresh from disk on every call — never cached.

    Args:
        path: API path, e.g. '/network/match'
        body: Request payload (will be JSON-serialised); None → empty body

    Returns:
        Parsed JSON response body as a dict

    Raises:
        MonadixAPIError: on 4xx/5xx responses (with .status and .body)
        urllib.error.URLError: on network errors
    """
    _, body_out = _signed_request("POST", path, body)
    return body_out


def get_monadix(path: str) -> dict:
    """Send a signed GET request. Empty body by definition."""
    _, body_out = _signed_request("GET", path, None)
    return body_out


def rate_task(task_id: str, rating: int) -> str | None:
    """
    Submit a 1-5 star rating for a previously completed task.
    Returns None on success or a string error message on a 4xx soft failure.
    """
    try:
        call_monadix(f"/network/tasks/{task_id}/rate", {"rating": rating})
        return None
    except (MonadixAPIError, urllib.error.URLError) as err:
        return str(err)


# ---------------------------------------------------------------------------
# Conversation primitives (v14)
# ---------------------------------------------------------------------------

import uuid

MAX_PUBLISH_ATTEMPTS = 3


def _gen_client_turn_id() -> str:
    return str(uuid.uuid4())


def _run_with_retry(task_id: str, attempt_fn, label: str, can_retry_on_status) -> dict | None:
    """
    Generic capped retry runner with mandatory status-check-before-retry.

    can_retry_on_status(snap) returns one of:
      'retry'    — issue attempt_fn again
      'attached' — server moved on; re-issue attempt_fn once more (idempotent)
      'abort'    — stop and return None
    """
    last_error: Exception | None = None
    for attempt in range(1, MAX_PUBLISH_ATTEMPTS + 1):
        try:
            return attempt_fn()
        except MonadixAPIError as err:
            last_error = err
            if 400 <= err.status < 500 and err.status != 409:
                print(f"{label} failed with {err.status} — not retryable. {err}")
                return None
            if err.status == 409:
                print(f"{label} rejected by server cap (409). Aborting. {err}")
                return None
            if attempt == MAX_PUBLISH_ATTEMPTS:
                print(f"{label} failed after {attempt} attempts: {err}")
                return None
            print(f"{label} attempt {attempt} failed ({err.status}). Checking task status before retry...")
        except urllib.error.URLError as err:
            last_error = err
            if attempt == MAX_PUBLISH_ATTEMPTS:
                print(f"{label} failed after {attempt} attempts: {err}")
                return None
            print(f"{label} attempt {attempt} failed (network). Checking task status before retry...")

        try:
            snap = get_monadix(f"/network/tasks/{task_id}/status")
            verdict = can_retry_on_status(snap)
            if verdict == "abort":
                print(f"Task is {snap.get('status')} — not eligible for {label} retry. Aborting.")
                return None
            if verdict == "attached":
                print(f"Task is {snap.get('status')} server-side — re-issuing {label} to attach/fetch cached.")
            else:
                print(f"Task is {snap.get('status')} (attempt {snap.get('dispatchAttemptCount', attempt)}/{MAX_PUBLISH_ATTEMPTS}) — retrying.")
        except (MonadixAPIError, urllib.error.URLError) as status_err:
            print(f"Status check failed: {status_err} — retrying anyway.")

    return None


def publish_conversation(task_id: str) -> dict | None:
    """
    Publish a previously-reserved conversation draft. Idempotent.
    Returns the publish outcome ({task, status, result?, pendingPrompt?, usage?})
    or None on terminal failure.
    """
    def _verdict(snap: dict) -> str:
        s = snap.get("status")
        if s in ("completed", "failed", "awaiting_consumer", "pending", "matched", "executing"):
            return "attached"
        return "retry"  # draft / failed (re-eligible)

    return _run_with_retry(
        task_id,
        lambda: call_monadix(f"/network/conversations/{task_id}/publish"),
        "Publish",
        _verdict,
    )


def respond_to_provider(task_id: str, content, client_turn_id: str | None = None) -> dict | None:
    """
    Send a single consumer follow-up message. Idempotent via clientTurnId —
    always retry-safe with the same id.
    """
    turn_id = client_turn_id or _gen_client_turn_id()

    def _verdict(snap: dict) -> str:
        s = snap.get("status")
        if s in ("completed", "failed", "executing", "matched"):
            return "attached"
        if s == "awaiting_consumer":
            return "retry"
        return "abort"

    return _run_with_retry(
        task_id,
        lambda: call_monadix(
            f"/network/conversations/{task_id}/messages",
            {"content": content, "clientTurnId": turn_id},
        ),
        "Message",
        _verdict,
    )


def close_conversation(task_id: str, reason: str | None = None) -> dict:
    """Idempotently close a conversation. Safe to call multiple times."""
    body = {"reason": reason} if reason else {}
    try:
        return call_monadix(f"/network/conversations/{task_id}/close", body)
    except (MonadixAPIError, urllib.error.URLError) as err:
        return {"error": str(err)}


def delegate_task(description: str, input_data: dict | None = None) -> None:
    """
    Full delegation workflow (step-by-step — pauses at each boundary):
      Step 1 — Match:        call the match API, print ranked providers
      Step 2 — Confirm:      ask the user to pick a provider (or cancel)
      Step 3 — Publish & drive multi-turn conversation
      Step 4 — Show Results: print the provider's output and usage summary
      Step 5 — Rate:         offer the user a 1–5 star rating prompt

    Args:
        description: Task description (max 2000 chars)
        input_data:  Optional structured input for the provider
    """
    # Step 1 — Match: find providers (no credits spent)
    print("Matching providers...")
    data = call_monadix("/network/match", {"description": description, "limit": 5})
    matches = data.get("matches", [])
    if not matches:
        print("No providers available for this task.")
        return

    # --- PAUSE after Step 1: show results and wait for user selection ---
    print("\n[Step 1 complete — Match results]")
    print(f"\nFound {len(matches)} provider(s):")
    for i, m in enumerate(matches, 1):
        avg = m['provider'].get('averageRating')
        count = m['provider'].get('ratingCount', 0)
        if avg is not None and count > 0:
            rating_str = f"\u2605 {avg:.1f} ({count} rating{'s' if count != 1 else ''})"
        else:
            rating_str = "No ratings yet"
        print(f"{i}. {m['provider']['name']} ({round(m['score'] * 100)}% match)  {rating_str}")
        print(f"   Capability: {m['capability']['description']}")

    # Step 2 — Confirm: wait for the user to choose a provider
    answer = input("\nWhich provider? (number or 'cancel'): ").strip().lower()
    if answer == "cancel":
        print("Delegation cancelled.")
        return
    try:
        idx = int(answer) - 1
        assert 0 <= idx < len(matches)
    except (ValueError, AssertionError):
        print("Invalid selection.")
        return
    chosen = matches[idx]

    # Step 3a — Reserve a conversation id (no credits, no provider contacted).
    # NEVER call this twice for the same logical request.
    print(f"\nReserving conversation id for {chosen['provider']['name']}...")
    draft_payload: dict = {
        "description": description,
        "preMatchedProviderId": chosen["provider"]["id"],
        "preMatchedScore": chosen["score"],
        "preMatchedCapabilityDescription": chosen["capability"]["description"],
    }
    if input_data is not None:
        draft_payload["input"] = input_data
    draft = call_monadix("/network/conversations/draft", draft_payload)
    task_id = draft["task"]["id"]
    print(f"Conversation reserved: {task_id}. Publishing...")

    # Step 3b — Publish & wait for the first turn.
    outcome = publish_conversation(task_id)

    # Step 3c — Reply loop. Continues until terminal (completed/failed) or
    # until publish/message returns None (terminal failure inside the helper).
    while outcome is not None and outcome.get("status") == "awaiting_consumer":
        pending = outcome.get("pendingPrompt", {}) or {}
        print("\n[Provider needs input]")
        print(f"Question: {pending.get('question', '(no question text)')}")
        if pending.get("schema"):
            print(f"Expected shape: {json.dumps(pending['schema'])}")
        user_reply = input('Your reply (or "abort"): ').strip()
        if user_reply.lower() == "abort":
            print("Aborting conversation...")
            close_conversation(task_id, "User aborted from helper.")
            return
        outcome = respond_to_provider(task_id, user_reply, _gen_client_turn_id())

    if outcome is None:
        print("\nDelegation failed (see logs above).")
        return

    # Step 4 — Show Results
    task = outcome["task"]
    if outcome.get("status") == "completed":
        print("\n[Step 4 — Results]")
        print("\nTask completed!")
        print("Output:", json.dumps(outcome.get("result"), indent=2))
        usage = outcome.get("usage")
        if usage:
            print(f"Credits consumed: {usage.get('creditsConsumed')}")

        # Step 5 — Rate (completed only)
        provider_name = chosen["provider"]["name"]
        print(f"\n[Step 5 — Rate this provider]")
        print(f"How would you rate {provider_name}'s work on this task? (1–5 stars)")
        print("\u2605 1 = Poor   \u2605 3 = Good   \u2605 5 = Excellent")
        rating_answer = input('Enter a number 1–5, or "skip": ').strip()
        try:
            rating = int(rating_answer)
        except ValueError:
            rating = 0
        if 1 <= rating <= 5:
            err = rate_task(task["id"], rating)
            print(f"Rating not recorded: {err}" if err else f"Rated {rating}\u2605")
        else:
            print("Rating skipped.")
    else:
        print(f"\nTask {outcome.get('status')}. Delegation did not succeed.")


if __name__ == "__main__":
    delegate_task(
        "Summarise the key clauses of the attached contract and identify any unusual terms.",
        {"contractText": "..."},
    )
