const CHATWORK_API = "https://api.chatwork.com/v2";

export async function notify(message) {
  const token = process.env.CHATWORK_TOKEN;
  const roomId = process.env.CHATWORK_ROOM_ID;

  if (!token || !roomId) {
    console.log("[chatwork] skip (CHATWORK_TOKEN or CHATWORK_ROOM_ID not set)");
    return;
  }

  const body = `[info][title]Auto-Rebalance BOT[/title]${message}[/info]`;

  try {
    const res = await fetch(`${CHATWORK_API}/rooms/${roomId}/messages`, {
      method: "POST",
      headers: {
        "X-ChatWorkToken": token,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ body }).toString(),
    });
    if (!res.ok) {
      console.error(`[chatwork] failed: ${res.status} ${await res.text()}`);
    }
  } catch (e) {
    console.error(`[chatwork] error: ${e.message}`);
  }
}
