import { useCallback, useEffect, useState } from "react";
import { api, SIGNED_OUT_EVENT } from "./api/client";
import type { Session } from "./api/types";
import { useRoute } from "./router";
import { Home, resetHome } from "./screens/Home";
import { ProfilePicker } from "./screens/ProfilePicker";
import { Search } from "./screens/Search";
import { SignIn } from "./screens/SignIn";
import { Player } from "./screens/Player";
import { TitlePage } from "./screens/TitlePage";

type Auth = { kind: "loading" } | { kind: "error" } | { kind: "signedOut" } | { kind: "session"; session: Session };

export function App() {
  const [auth, setAuth] = useState<Auth>({ kind: "loading" });
  const route = useRoute();

  const refresh = useCallback(async () => {
    try {
      const s = await api.session();
      setAuth(s ? { kind: "session", session: s } : { kind: "signedOut" });
    } catch {
      setAuth({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onSignedOut = () => setAuth({ kind: "signedOut" });
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [refresh]);

  const switchProfile = async () => {
    await api.deselectProfile().catch(() => undefined);
    resetHome();
    await refresh();
  };
  const signOut = async () => {
    await api.logout().catch(() => undefined);
    resetHome();
    setAuth({ kind: "signedOut" });
  };

  switch (auth.kind) {
    case "loading":
      return (
        <main className="center-screen" aria-busy="true" aria-label="Loading">
          <div className="brand brand-large splash">Sofarr</div>
        </main>
      );
    case "error":
      return (
        <main className="center-screen">
          <p>Can't reach the Sofarr server.</p>
          <button className="btn" onClick={() => void refresh()}>
            Try again
          </button>
        </main>
      );
    case "signedOut":
      return <SignIn onSignedIn={() => void refresh()} />;
    case "session": {
      const { profile } = auth.session;
      if (!profile) return <ProfilePicker onSelected={() => void refresh()} onSignOut={() => void signOut()} />;
      if (route.name === "search") return <Search initialQuery={route.q} />;
      if (route.name === "watch") {
        return <Player key={`${route.plexKey}:${route.offsetMs ?? ""}`} plexKey={route.plexKey} {...(route.offsetMs !== undefined && { offsetMs: route.offsetMs })} />;
      }
      if (route.name === "title") {
        return <TitlePage key={`${route.mediaType}:${route.tmdbId}`} mediaType={route.mediaType} tmdbId={route.tmdbId} />;
      }
      const tab = route.name === "library" ? "library" : "home";
      return <Home key={`${profile.uuid}:${tab}`} tab={tab} profile={profile} onSwitchProfile={() => void switchProfile()} onSignOut={() => void signOut()} />;
    }
  }
}
