/**
 * SMS sending via smsc.ru API.
 */

const SMSC_LOGIN = process.env.SMSC_LOGIN ?? "";
const SMSC_PASSWORD = process.env.SMSC_PASSWORD ?? "";

export async function sendSMS(phone: string, message: string): Promise<{ ok: boolean; error?: string }> {
  if (!SMSC_LOGIN || !SMSC_PASSWORD) {
    return { ok: false, error: "SMSC_LOGIN или SMSC_PASSWORD не настроены" };
  }
  try {
    const params = new URLSearchParams({
      login: SMSC_LOGIN,
      psw: SMSC_PASSWORD,
      phones: phone,
      mes: message,
      fmt: "3",
      charset: "utf-8",
    });
    const res = await fetch(`https://smsc.ru/sys/send.php?${params.toString()}`);
    const data = (await res.json()) as { error?: string; error_code?: string };
    if (data.error) {
      const errMsg = `SMSC: ${data.error} (код ${data.error_code})`;
      console.error(`[SMS] ${errMsg}`);
      return { ok: false, error: errMsg };
    }
    return { ok: true };
  } catch (e) {
    console.error("[SMS] Ошибка сети:", e);
    return { ok: false, error: "Ошибка сети при отправке SMS" };
  }
}
