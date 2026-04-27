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


def call_monadix(path: str, body: dict | None = None) -> dict:
    """
    Send a signed POST request to the Monadix API.
    Credentials are read fresh from disk on every call — never cached.

    Args:
        path: API path, e.g. '/marketplace/match'
        body: Request payload (will be JSON-serialised); None → empty body

    Returns:
        Parsed JSON response body as a dict

    Raises:
        urllib.error.HTTPError: on 4xx/5xx responses
        urllib.error.URLError:  on network errors
    """
    api_key = _load_key("monadix.key")
    signing_key = _load_key("monadix.signing-key")
    raw_body = "" if body is None else json.dumps(body, separators=(",", ":"))
    timestamp = str(int(time.time() * 1000))
    signed_payload = f"{timestamp}.{raw_body}"
    signature = hmac.new(
        signing_key.encode(), signed_payload.encode(), hashlib.sha256
    ).hexdigest()
    data = raw_body.encode() if raw_body else None
    req = urllib.request.Request(
        f"https://api.monadix.ai{path}",
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "X-Monadix-Timestamp": timestamp,
            "X-Monadix-Signature": signature,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def rate_task(task_id: str, rating: int) -> str | None:
    """
    Submit a 1-5 star rating for a previously completed task.
    Returns None on success or a string error message on a 4xx soft failure.
    """
    try:
        call_monadix(f"/marketplace/tasks/{task_id}/rate", {"rating": rating})
        return None
    except (urllib.error.HTTPError, urllib.error.URLError) as err:
        return str(err)


def delegate_task(description: str, input_data: dict | None = None) -> None:
    """
    Full delegation workflow (step-by-step — pauses at each boundary):
      Step 1 — Match:        call the match API, print ranked providers
      Step 2 — Confirm:      ask the user to pick a provider (or cancel)
      Step 3 — Publish Task: publish to the chosen provider
      Step 4 — Show Results: print the provider's output and usage summary
      Step 5 — Rate:         offer the user a 1–5 star rating prompt

    Args:
        description: Task description (max 2000 chars)
        input_data:  Optional structured input for the provider
    """
    # Step 1 — Match: find providers (no credits spent)
    print("Matching providers...")
    data = call_monadix("/marketplace/match", {"description": description, "limit": 5})
    matches = data.get("matches", [])
    if not matches:
        print("No providers available for this task.")
        return

    # --- PAUSE after Step 1: show results and wait for user selection ---
    print("\n[Step 1 complete — Match results]")
    print(f"\nFound {len(matches)} provider(s):")
    for i, m in enumerate(matches, 1):
        print(f"{i}. {m['provider']['name']} ({round(m['score'] * 100)}% match)")
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

    # Step 3 — Publish Task: send to the chosen provider
    print(f"\nDelegating to {chosen['provider']['name']}...")
    payload: dict = {
        "description": description,
        "preMatchedProviderId": chosen["provider"]["id"],
        "preMatchedScore": chosen["score"],
        "preMatchedCapabilityDescription": chosen["capability"]["description"],
    }
    if input_data is not None:
        payload["input"] = input_data
    result = call_monadix("/marketplace/tasks", payload)

    # Step 4 — Show Results
    task = result["task"]
    if task["status"] == "completed":
        print("\n[Step 4 — Results]")
        print("\nTask completed!")
        print("Output:", json.dumps(result["result"]["output"], indent=2))
        print(f"Credits consumed: {result['usage']['creditsConsumed']}")

        # --- PAUSE after Step 4: show results, then ask for rating ---

        # Step 5 — Rate: offer a 1–5 star rating (skip on non-completed tasks)
        rating_answer = input("\n[Step 5 — Rate] Rate this provider (1–5, or 'skip'): ").strip()
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
        print(f"\nTask {task['status']}. Delegation did not succeed.")


if __name__ == "__main__":
    delegate_task(
        "Summarise the key clauses of the attached contract and identify any unusual terms.",
        {"contractText": "..."},
    )
