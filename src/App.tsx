import React, { useState, useEffect } from "react";

// ===== CONFIG =====
const CLIENT_ID = process.env.REACT_APP_SPOTIFY_CLIENT_ID!;
const REDIRECT_URI = process.env.REACT_APP_SPOTIFY_REDIRECT_URI!;
const BACKEND_URL =
  process.env.REACT_APP_BACKEND_URL ||
  "https://spotifyplaylister.onrender.com/";
const SCOPES = "playlist-modify-public playlist-modify-private";

// ===== PKCE HELPERS =====
async function generateCodeVerifier() {
  const array = new Uint32Array(56);
  window.crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...Array.from(array)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateCodeChallenge(codeVerifier: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await window.crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...Array.from(new Uint8Array(digest))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ===== AUTH =====
async function login() {
  const codeVerifier = await generateCodeVerifier();
  localStorage.setItem("spotify_code_verifier", codeVerifier);
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.append("client_id", CLIENT_ID);
  authUrl.searchParams.append("response_type", "code");
  authUrl.searchParams.append("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.append("scope", SCOPES);
  authUrl.searchParams.append("code_challenge_method", "S256");
  authUrl.searchParams.append("code_challenge", codeChallenge);

  window.location.href = authUrl.toString();
}

function getAuthCode(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("code");
}

// ===== TRACK PARSER =====
function parseTrackName(filename: string) {
  let name = filename.replace(/\.[^/.]+$/, "");
  name = name.replace(/^[0-9]+\s*[-._)]*\s*/, "");
  const parts = name.split(" - ");
  if (parts.length >= 2) {
    const artist = parts[0].trim();
    const title = parts.slice(1).join(" - ").trim();
    return `${title} ${artist}`;
  }
  return name.trim();
}

// ===== SPOTIFY HELPERS =====
async function spotifyFetch(
  url: string,
  options: RequestInit = {},
  accessToken: string
) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Spotify API error (${res.status}): ${err}`);
  }

  return res.json();
}

async function getUserProfile(accessToken: string) {
  return spotifyFetch("https://api.spotify.com/v1/me", {}, accessToken);
}

async function createPlaylist(
  userId: string,
  name: string,
  accessToken: string
) {
  return spotifyFetch(
    `https://api.spotify.com/v1/users/${userId}/playlists`,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        description: "Created from local folder",
        public: false,
      }),
    },
    accessToken
  );
}

async function searchTrack(query: string, accessToken: string) {
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(
    query
  )}&type=track&limit=1`;
  const result = await spotifyFetch(url, {}, accessToken);
  return result.tracks.items.length > 0 ? result.tracks.items[0].uri : null;
}

async function addTracks(
  playlistId: string,
  uris: string[],
  accessToken: string
) {
  for (let i = 0; i < uris.length; i += 100) {
    const chunk = uris.slice(i, i + 100);
    await spotifyFetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
      { method: "POST", body: JSON.stringify({ uris: chunk }) },
      accessToken
    );
  }
}

// ===== MAIN COMPONENT =====
export default function App() {
  const [accessToken, setAccessToken] = useState<string>("");
  const [trackNames, setTrackNames] = useState<string[]>([]);
  const [folderName, setFolderName] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [playlistUrl, setPlaylistUrl] = useState("");

  useEffect(() => {
    const code = getAuthCode();
    if (code && !accessToken) {
      const codeVerifier = localStorage.getItem("spotify_code_verifier");
      if (!codeVerifier) return;

      fetch(`${BACKEND_URL}/api/exchange_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, code_verifier: codeVerifier }),
      })
        .then((res) => res.json())
        .then((data) => {
          setAccessToken(data.access_token);
          window.history.replaceState({}, document.title, "/");
        });
    }
  }, [accessToken]);

  if (!accessToken) {
    return (
      <div className="flex flex-col items-center justify-center h-screen">
        <h1 className="text-2xl font-bold mb-4">Spotify Playlist Creator</h1>
        <button
          onClick={login}
          className="bg-green-500 text-white px-6 py-2 rounded-lg"
        >
          Login with Spotify
        </button>
      </div>
    );
  }

  function handleFolderPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    const names = files.map((f) => parseTrackName(f.name));
    setTrackNames(names);
    if (files.length > 0)
      setFolderName(files[0].webkitRelativePath.split("/")[0]);
    setLogs([`Folder: ${folderName}`, `Tracks:`, ...names]);
  }

  async function handleCreatePlaylist() {
    if (!trackNames.length) return alert("Please select a folder first!");
    setLogs((prev) => [...prev, "\n⏳ Processing..."]);

    try {
      const me = await getUserProfile(accessToken);
      const playlist = await createPlaylist(me.id, folderName, accessToken);
      setPlaylistUrl(playlist.external_urls.spotify);
      setLogs((prev) => [
        ...prev,
        `✅ Playlist created: ${playlist.external_urls.spotify}`,
      ]);

      const uris: string[] = [];
      for (const name of trackNames) {
        try {
          const uri = await searchTrack(name, accessToken);
          if (uri) {
            uris.push(uri);
            setLogs((prev) => [...prev, `✔ Found: ${name}`]);
          } else setLogs((prev) => [...prev, `❌ Not found: ${name}`]);
        } catch (err) {
          setLogs((prev) => [
            ...prev,
            `⚠️ Error searching "${name}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          ]);
        }
      }

      if (uris.length > 0) {
        await addTracks(playlist.id, uris, accessToken);
        setLogs((prev) => [...prev, `🎉 Added ${uris.length} tracks!`]);
      } else setLogs((prev) => [...prev, `⚠️ No tracks found.`]);
    } catch (err) {
      setLogs((prev) => [
        ...prev,
        `❌ Failed: ${err instanceof Error ? err.message : String(err)}`,
      ]);
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Spotify Playlist Creator</h1>
      <input
        type="file"
        {...({ webkitdirectory: "true" } as any)}
        multiple
        onChange={handleFolderPick}
        className="mb-4"
      />
      <button
        onClick={handleCreatePlaylist}
        className="bg-blue-500 text-white px-6 py-2 rounded-lg"
      >
        Create Playlist
      </button>
      {playlistUrl && (
        <p className="mt-4">
          🎶 Playlist:{" "}
          <a
            href={playlistUrl}
            target="_blank"
            rel="noreferrer"
            className="text-green-600 underline"
          >
            Open in Spotify
          </a>
        </p>
      )}
      <pre className="mt-4 bg-gray-100 p-3 rounded-lg text-sm max-h-80 overflow-y-auto">
        {logs.join("\n")}
      </pre>
    </div>
  );
}
