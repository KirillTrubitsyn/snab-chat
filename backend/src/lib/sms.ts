/**
 * SMS sending via smsc.ru API.
 */

const SMSC_LOGIN = process.env.SMSC_LOGIN ?? "";
const SMSC_PASSWORD = process.env.SMSC_PASSWORD ?? "";

export async function sendSMS(phone: string, message: string): Promise<boolean> {
  if (!SMSC_LOGIN || !SMSC_PASSWORD) {
    console.error("[SMS] SMSC_LOGIN \u0438\u043b\u0438 SMSC_PASSWORD \u043d\u0435 \u043d\u0430\u0441\u0442\u0440\u043e\u0435\u043d\u044b");
    return false;
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
    const data = await res.json();
    if (data.error) {
      console.error(`[SMS] \u041e\u0448\u0438\u0431\u043a\u0430 SMSC: ${data.error} (\u043a\u043e\u0434: ${data.error_code})`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[SMS] \u041e\u0448\u0438\u0431\u043a\u0430 \u0441\u0435\u0442\u0438:", e);
    return false;
  }
}
