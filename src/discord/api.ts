export async function discordApiWithToken<T>(token: string, path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    // エラーレスポンス本文が取れるときは原因をそのまま投げる。
    const text = await res.text().catch(() => "");
    throw new Error(`Discord API error ${res.status}: ${text || res.statusText}`);
  }

  if (res.status === 204) {
    // Discord の No Content 応答は body がないため undefined を返す。
    return undefined as T;
  }

  return (await res.json()) as T;
}

export async function createDmChannel(token: string, recipientId: string): Promise<string> {
  const dm = await discordApiWithToken<{ id: string }>(token, "/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: recipientId }),
  });
  return dm.id;
}

export async function postChannelMessage(token: string, channelId: string, content: string): Promise<void> {
  await discordApiWithToken<void>(token, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}
