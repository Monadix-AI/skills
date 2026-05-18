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
# Conversation primitives
# ---------------------------------------------------------------------------

import uuid

# Server-side per-call long-poll cap for `GET /network/tasks/<id>/status?wait=`.
# The server enforces a hard ceiling of 55_000 ms regardless.
STATUS_LONG_POLL_MS = 55_000

# Statuses at which the consumer must stop polling and either surface the
# result to the user or solicit a reply. Anything else means the provider is
# still working and the consumer should keep polling — the SERVER (not this
# helper) is responsible for the per-turn (10 min) and per-conversation (30
# min) wall-clock ceilings, so polling is bounded automatically.
TERMINAL_STATUSES = {"completed", "failed", "awaiting_consumer"}


def _gen_client_turn_id() -> str:
    return str(uuid.uuid4())


def _post_with_transport_retry(path: str, body: dict | None, *, label: str) -> dict | None:
    """POST and retry once on a transport/5xx error.

    The publish and messages endpoints are idempotent server-side (publish
    branches on persisted task status; messages dedupes on `clientTurnId`),
    so a fresh retry never double-bills or duplicates a turn. 4xx responses
    other than 409 are surfaced as terminal failures; 409 means the server
    cap was reached and is also terminal.
    """
    for attempt in (1, 2):
        try:
            return call_monadix(path, body)
        except MonadixAPIError as err:
            if err.status == 409:
                print(f"{label} rejected by server cap (409). Aborting. {err}")
                return None
            if 400 <= err.status < 500:
                print(f"{label} failed with {err.status} — not retryable. {err}")
                return None
            if attempt == 2:
                print(f"{label} failed after {attempt} attempts: {err}")
                return None
            print(f"{label} attempt {attempt} failed ({err.status}) — retrying once.")
        except urllib.error.URLError as err:
            if attempt == 2:
                print(f"{label} failed after {attempt} attempts: {err}")
                return None
            print(f"{label} attempt {attempt} failed (network) — retrying once.")
    return None


def wait_until_terminal(task_id: str) -> dict | None:
    """Long-poll `GET /network/tasks/<id>/status?wait=55000` until the task
    reaches `completed`, `failed`, or `awaiting_consumer`.

    The server enforces both the per-turn (10 min) and per-conversation
    (30 min) wall-clock ceilings; either being exceeded transitions the
    task to `failed` and refunds credits unconditionally. The consumer
    therefore NEVER needs to time out itself — every long-poll iteration
    is bounded by the server, and looping indefinitely is safe.

    Returns the final status snapshot, or None on a terminal API error.
    """
    while True:
        try:
            snap = get_monadix(
                f"/network/tasks/{task_id}/status?wait={STATUS_LONG_POLL_MS}"
            )
        except MonadixAPIError as err:
            print(f"Status read failed with {err.status}: {err}")
            return None
        except urllib.error.URLError as err:
            print(f"Status read network error: {err} — retrying.")
            continue
        if snap.get("status") in TERMINAL_STATUSES:
            return snap
        # pending / matched / executing — provider is still working; loop again.


def publish_conversation(task_id: str) -> dict | None:
    """Publish a previously-reserved conversation draft. Fire-and-forget.

    Returns the dispatch acknowledgment (`{task, status, ...}`) or None on
    terminal failure. The returned `status` may be `pending` / `matched` /
    `executing` (in flight — call `wait_until_terminal`), `awaiting_consumer`
    / `completed` (terminal — payload already includes `pendingPrompt` /
    `result`), or `failed` (terminal failure).
    """
    return _post_with_transport_retry(
        f"/network/conversations/{task_id}/publish", None, label="Publish"
    )


def respond_to_provider(task_id: str, content, client_turn_id: str | None = None) -> dict | None:
    """Send a single consumer follow-up message. Fire-and-forget.

    Always sends a `clientTurnId` (auto-generated when omitted) so a
    transport retry is dedupe-safe server-side.
    """
    turn_id = client_turn_id or _gen_client_turn_id()
    return _post_with_transport_retry(
        f"/network/conversations/{task_id}/messages",
        {"content": content, "clientTurnId": turn_id},
        label="Message",
    )


def close_conversation(task_id: str, reason: str | None = None) -> dict:
    """Idempotently close a conversation. Safe to call multiple times."""
    body = {"reason": reason} if reason else {}
    try:
        return call_monadix(f"/network/conversations/{task_id}/close", body)
    except (MonadixAPIError, urllib.error.URLError) as err:
        return {"error": str(err)}


# ---------------------------------------------------------------------------
# Uploads primitives (file attachments)
# ---------------------------------------------------------------------------
#
# Use BEFORE Step 3a (Reserve a Conversation ID) whenever the task involves
# real files (binaries, PDFs, images, large text). Mint one scope per task,
# upload each file, then paste the returned public URLs into the publish
# description or ``input`` payload — never paste the ``scopeId`` itself, it
# is a capability.

import mimetypes
import os


def create_upload_scope() -> dict:
    """Mint a fresh upload scope.

    Returns ``{"scopeId": "usc_...", "limits": {"maxFileSizeBytes": ...}}``.
    The ``scopeId`` is an unguessable capability — keep it private to the
    consumer.
    """
    return call_monadix("/uploads/scopes", {})


def upload_file(
    scope_id: str,
    local_file_path: str | os.PathLike,
    *,
    filename: str | None = None,
    content_type: str | None = None,
) -> dict:
    """Upload a single file to a scope using the pre-signed PUT flow.

    Two HTTP calls happen here:
      1. ``POST /uploads/scopes/<scopeId>/files/sign`` (Monadix-signed JSON)
         returns ``{uploadUrl, publicUrl, requiredHeaders, ...}``.
      2. ``PUT <uploadUrl>`` with the raw file bytes and the required
         ``Content-Type``. No Monadix credentials are sent on the PUT — the
         URL itself is the credential.

    Returns a flat dict ``{fileId, scopeId, storagePath, publicUrl,
    originalName, sizeBytes, contentType}``.
    """
    local_file_path = Path(local_file_path)
    file_bytes = local_file_path.read_bytes()
    upload_name = filename or local_file_path.name
    upload_type = content_type or (
        mimetypes.guess_type(upload_name)[0] or "application/octet-stream"
    )

    # Step 1: mint a pre-signed upload URL via the standard Monadix HMAC flow.
    signed = call_monadix(
        f"/uploads/scopes/{scope_id}/files/sign",
        {"filename": upload_name, "contentType": upload_type},
    )

    # Step 2: PUT the raw bytes directly to Supabase Storage. No Monadix headers.
    put_req = urllib.request.Request(
        signed["uploadUrl"],
        data=file_bytes,
        headers=signed["requiredHeaders"],
        method="PUT",
    )
    try:
        with urllib.request.urlopen(put_req, timeout=120) as resp:
            resp.read()  # drain Supabase receipt; we don't need it
    except urllib.error.HTTPError as err:
        text = err.read().decode() if err.fp else ""
        raise MonadixAPIError(err.code, {"raw": text}, text) from err

    return {
        "fileId": signed["fileId"],
        "scopeId": signed["scopeId"],
        "storagePath": signed["storagePath"],
        "publicUrl": signed["publicUrl"],
        "originalName": signed["originalName"],
        "sizeBytes": len(file_bytes),
        "contentType": upload_type,
    }


def list_scope_files(scope_id: str) -> dict:
    """List files already uploaded into a scope.

    Useful for recovering URLs after a process restart without re-uploading.
    """
    return get_monadix(f"/uploads/scopes/{scope_id}/files")


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

    # Step 3b — Publish (fire-and-forget) then long-poll for the first
    # terminal/awaiting_consumer status.
    ack = publish_conversation(task_id)
    if ack is None:
        print("\nDelegation failed (publish rejected).")
        return
    snap = ack if ack.get("status") in TERMINAL_STATUSES else wait_until_terminal(task_id)
    if snap is None:
        print("\nDelegation failed (status read error).")
        return

    # Step 3c — Reply loop. Continues until the conversation is terminal.
    while snap.get("status") == "awaiting_consumer":
        pending = snap.get("pendingPrompt", {}) or {}
        print("\n[Provider needs input]")
        print(f"Question: {pending.get('question', '(no question text)')}")
        if pending.get("schema"):
            print(f"Expected shape: {json.dumps(pending['schema'])}")
        user_reply = input('Your reply (or "abort"): ').strip()
        if user_reply.lower() == "abort":
            print("Aborting conversation...")
            close_conversation(task_id, "User aborted from helper.")
            return
        ack = respond_to_provider(task_id, user_reply, _gen_client_turn_id())
        if ack is None:
            print("\nDelegation failed (message rejected).")
            return
        snap = ack if ack.get("status") in TERMINAL_STATUSES else wait_until_terminal(task_id)
        if snap is None:
            print("\nDelegation failed (status read error).")
            return

    # Step 4 — Show Results
    if snap.get("status") == "completed":
        print("\n[Step 4 — Results]")
        print("\nTask completed!")
        print("Output:", json.dumps(snap.get("result"), indent=2))
        credit_cost = snap.get("creditCost")
        if credit_cost is not None:
            print(f"Credits consumed: {credit_cost}")

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
            err = rate_task(task_id, rating)
            print(f"Rating not recorded: {err}" if err else f"Rated {rating}\u2605")
        else:
            print("Rating skipped.")
    else:
        # `failed` — server has already refunded any debited credits.
        output = snap.get("output") or {}
        reason = output.get("error") or output.get("reason") or "no reason given"
        print(f"\nTask failed: {reason}. No credits charged.")


if __name__ == "__main__":
    delegate_task(
        "Summarise the key clauses of the attached contract and identify any unusual terms.",
        {"contractText": "..."},
    )
