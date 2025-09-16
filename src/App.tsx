import React, { useState } from "react";

// ==== CONFIG ====
const CLIENT_ID = process.env.REACT_APP_SPOTIFY_CLIENT_ID as string;
const REDIRECT_URI = "https://spotifyplaylister.netlify.app/"; // Change if deployed
const SCOPES = "playlist-modify-public playlist-modify-private";

// ==== AUTH ====
function login() {
  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.append("client_id", CLIENT_ID);
  authUrl.searchParams.append("response_type", "token");
  authUrl.searchParams.append("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.append("scope", SCOPES);
  window.location.href = authUrl.toString();
}

function getAccessToken() {
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  return params.get("access_token");
}

function parseTrackName(filename: string) {
  // 1. Remove extension
  let name = filename.replace(/\.[^/.]+$/, "");

  // 2. Remove leading track numbers like "01 -", "1.", "01_"
  name = name.replace(/^[0-9]+\s*[-._)]*\s*/, "");

  // 3. Split by " - " to detect artist + title
  const parts = name.split(" - ");
  if (parts.length >= 2) {
    const artist = parts[0].trim();
    const title = parts.slice(1).join(" - ").trim();
    return `${title} ${artist}`; // better for Spotify search
  }

  return name.trim();
}

// ==== HELPERS ====
async function spotifyFetch(
  url: string,
  options: RequestInit = {},
  retryCount = 0,
  accessToken: string
): Promise<any> {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "1");
    console.warn(`Rate limited. Retrying after ${retryAfter}s...`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return spotifyFetch(url, options, retryCount + 1, accessToken);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Spotify API error (${res.status}): ${err}`);
  }

  return res.json();
}

async function getUserProfile(accessToken: string) {
  return spotifyFetch("https://api.spotify.com/v1/me", {}, 0, accessToken);
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
    0,
    accessToken
  );
}

async function searchTrack(query: string, accessToken: string) {
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(
    query
  )}&type=track&limit=1`;
  const result = await spotifyFetch(url, {}, 0, accessToken);
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
      {
        method: "POST",
        body: JSON.stringify({ uris: chunk }),
      },
      0,
      accessToken
    );
  }
}

// ==== MAIN COMPONENT ====
export default function App() {
  const [accessToken] = useState(getAccessToken());
  const [trackNames, setTrackNames] = useState<string[]>([]);
  const [folderName, setFolderName] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [playlistUrl, setPlaylistUrl] = useState("");

  if (!accessToken) {
    return (
      <div className="flex flex-col items-center justify-center h-screen">
        <h1 className="text-2xl font-bold mb-4">Spotify Playlist Creator</h1>
        <button
          onClick={login}
          className="bg-green-500 text-white px-6 py-2 rounded-lg shadow hover:bg-green-600"
        >
          Login with Spotify
        </button>
      </div>
    );
  }

  // Step 1 + 2: Read filenames
  function handleFolderPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    const names = files.map((f) => parseTrackName(f.name));
    setTrackNames(names);
    if (files.length > 0) {
      setFolderName(files[0].webkitRelativePath.split("/")[0]);
    }
    setLogs([`Folder: ${folderName}`, `Tracks:`, ...names]);
  }

  // Step 3–5: Build playlist
  async function handleCreatePlaylist() {
    if (!trackNames.length) {
      alert("Please select a folder first!");
      return;
    }
    setLogs((prev: string[]) => [...prev, "\n⏳ Processing..."]);

    try {
      // Get user
      const me = await getUserProfile(accessToken as string);

      // Create playlist
      const playlist = await createPlaylist(
        me.id,
        folderName,
        accessToken as string
      );
      setPlaylistUrl(playlist.external_urls.spotify);
      setLogs((prev: string[]) => [
        ...prev,
        `✅ Playlist created: ${playlist.external_urls.spotify}`,
      ]);

      // Search + collect URIs
      let uris = [];
      for (const name of trackNames) {
        try {
          const uri = await searchTrack(name, accessToken as string);
          if (uri) {
            uris.push(uri);
            setLogs((prev: string[]) => [...prev, `✔ Found: ${name}`]);
          } else {
            setLogs((prev: string[]) => [...prev, `❌ Not found: ${name}`]);
          }
        } catch (err) {
          setLogs((prev: string[]) => [
            ...prev,
            `⚠️ Error searching "${name}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          ]);
        }
      }

      // Add to playlist
      if (uris.length > 0) {
        await addTracks(playlist.id, uris, accessToken as string);
        setLogs((prev: string[]) => [
          ...prev,
          `🎉 Added ${uris.length} tracks to playlist!`,
        ]);
      } else {
        setLogs((prev: string[]) => [
          ...prev,
          `⚠️ No tracks were found to add.`,
        ]);
      }
    } catch (err) {
      setLogs((prev: string[]) => [
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
        className="bg-blue-500 text-white px-6 py-2 rounded-lg shadow hover:bg-blue-600"
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
