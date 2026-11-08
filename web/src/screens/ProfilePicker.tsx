import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { Profile } from "../api/types";
import { FocusGroup, Focusable, useBackKey } from "../nav/focus";

function Avatar({ p, size = "lg" }: { p: Profile; size?: "lg" | "sm" }) {
  return p.thumb ? (
    <img className={`avatar avatar-${size}`} src={p.thumb} alt="" />
  ) : (
    <div className={`avatar avatar-${size} avatar-letter`}>{p.title.slice(0, 1).toUpperCase()}</div>
  );
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"] as const;

function PinPad({ profile, onDone, onCancel }: { profile: Profile; onDone: (pin: string) => Promise<string | null>; onCancel: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (value: string) => {
    if (value.length !== 4 || busy) return;
    setBusy(true);
    const err = await onDone(value);
    setBusy(false);
    if (err) {
      setError(err);
      setPin("");
    }
  };
  const press = (k: (typeof KEYS)[number]) => {
    setError(null);
    if (k === "⌫") return setPin((p) => p.slice(0, -1));
    if (k === "OK") return void submit(pin);
    if (pin.length < 4) {
      const next = pin + k;
      setPin(next);
      if (next.length === 4) void submit(next);
    }
  };

  // Number keys on a keyboard or remote.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) press(e.key as (typeof KEYS)[number]);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });
  useBackKey(() => (pin ? setPin((p) => p.slice(0, -1)) : onCancel()));

  return (
    <div className="pinpad" role="dialog" aria-label={`PIN for ${profile.title}`}>
      <Avatar p={profile} />
      <h2>{profile.title}</h2>
      <p className="muted">Enter PIN</p>
      <div className="pin-dots" aria-live="polite">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={i < pin.length ? "on" : ""} />
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <FocusGroup className="pin-keys" trap autoFocus focusKey="pinpad" remember={false}>
        {KEYS.map((k) => (
          <Focusable key={k} className="btn pin-key" onSelect={() => press(k)} label={k === "⌫" ? "Delete" : k}>
            {() => k}
          </Focusable>
        ))}
      </FocusGroup>
    </div>
  );
}

export function ProfilePicker({ onSelected, onSignOut }: { onSelected: () => void; onSignOut: () => void }) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<Profile | null>(null);

  useEffect(() => {
    api.profiles().then(
      (r) => setProfiles(r.profiles),
      () => setError("Couldn't load profiles from Plex."),
    );
  }, []);

  const choose = async (p: Profile, pin?: string): Promise<string | null> => {
    try {
      await api.selectProfile(p.uuid, pin);
      onSelected();
      return null;
    } catch (e) {
      if (e instanceof ApiError && e.code === "wrong_pin") return "Wrong PIN";
      if (e instanceof ApiError && e.code === "pin_required") {
        setAsking(p);
        return null;
      }
      return "Couldn't switch profile";
    }
  };

  if (asking) {
    return (
      <main className="center-screen">
        <PinPad profile={asking} onDone={(pin) => choose(asking, pin)} onCancel={() => setAsking(null)} />
      </main>
    );
  }

  return (
    <main className="center-screen">
      <h1 className="screen-title">Who's watching?</h1>
      {error && <p className="error">{error}</p>}
      {!profiles && !error && <p className="muted">Loading…</p>}
      {profiles && (
        <FocusGroup className="profiles" autoFocus>
          {profiles.map((p) => (
            <Focusable
              key={p.uuid}
              className="profile"
              label={p.title}
              onSelect={() => (p.isProtected ? setAsking(p) : void choose(p))}
            >
              {() => (
                <>
                  <Avatar p={p} />
                  <span className="profile-name">
                    {p.title}
                    {p.isProtected && <span aria-label="PIN protected"> 🔒</span>}
                  </span>
                </>
              )}
            </Focusable>
          ))}
        </FocusGroup>
      )}
      <FocusGroup className="footer-actions">
        <Focusable className="btn btn-quiet" onSelect={onSignOut} label="Sign out">
          {() => "Sign out"}
        </Focusable>
      </FocusGroup>
    </main>
  );
}

export { Avatar };
