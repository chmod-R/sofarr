import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { Pin } from "../api/types";
import { FocusGroup, Focusable } from "../nav/focus";

type State =
  | { kind: "loading" }
  | { kind: "code"; pin: Pin }
  | { kind: "expired" }
  | { kind: "denied"; reason: string }
  | { kind: "error"; message: string };

const POLL_MS = 2000;

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const alive = useRef(true);

  const start = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "code", pin: await api.startPin() });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof ApiError && e.code === "plex_unavailable" ? "Couldn't reach Plex." : "Something went wrong.",
      });
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void start();
    return () => {
      alive.current = false;
    };
  }, [start]);

  // Poll until the code is linked on plex.tv/link.
  useEffect(() => {
    if (state.kind !== "code") return;
    let timer: number;
    const tick = async () => {
      try {
        const r = await api.pollPin();
        if (!alive.current) return;
        if (r.status === "signed_in") return onSignedIn();
        if (r.status === "expired" || r.status === "no_pending_login") return setState({ kind: "expired" });
        if (r.status === "denied") return setState({ kind: "denied", reason: r.reason });
      } catch {
        // Transient: keep polling.
      }
      timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [state, onSignedIn]);

  return (
    <main className="center-screen">
      <div className="brand brand-large">Sofarr</div>
      {state.kind === "loading" && <p className="muted">Getting a sign-in code…</p>}
      {state.kind === "code" && (
        <div className="signin">
          <div className="signin-steps">
            <p>
              On your phone or computer, go to <strong>plex.tv/link</strong>
            </p>
            <p>and enter this code:</p>
            <div className="signin-code" aria-label={`Code ${state.pin.code.split("").join(" ")}`}>
              {state.pin.code}
            </div>
            <p className="muted small">This screen continues by itself once you've entered it.</p>
          </div>
          {state.pin.qrUrl && (
            <figure className="signin-qr">
              <img src={state.pin.qrUrl} alt="QR code that opens plex.tv/link with this code" />
              <figcaption className="muted small">Or scan with your phone</figcaption>
            </figure>
          )}
        </div>
      )}
      {(state.kind === "expired" || state.kind === "denied" || state.kind === "error") && (
        <div className="signin-problem">
          <p>
            {state.kind === "expired" && "That code expired."}
            {state.kind === "denied" && state.reason}
            {state.kind === "error" && state.message}
          </p>
          <FocusGroup autoFocus>
            <Focusable className="btn btn-primary" onSelect={() => void start()} label="Get a new code">
              {() => "Get a new code"}
            </Focusable>
          </FocusGroup>
        </div>
      )}
    </main>
  );
}
