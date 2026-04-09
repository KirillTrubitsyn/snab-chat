/**
 * SMS отправка через SMSC.ru API.
 */

const SMSC_LOGIN = process.env.SMSC_LOGIN ?? "";
const SMSC_PASSWORD = process.env.SMSC_PASSWORD ?? "";

/**
 * Отправить SMS через SMSC.ru.
 * @param phone — номер телефона (формат +7XXXXXXXXXX)
 * @param message — текст SMS
 * @returns true если отправлено успешно
 */
export async function sendSMS(phone: string, message: string): Promise<boolean> {
  if (!SMSC_LOGIN || !SMSC_PASSWORD) {
    console.error("[SMS] SMSC_LOGIN или SMSC_PASSWORD не настроены");
    return false;
  }

  try {
    const params = new URLSearchParams({
      login: SMSC_LOGIN,
      psw: SMSC_PASSWORD,
      phones: phone,
      mes: message,
      fmt: "3", // JSON ответ
      charset: "utf-8",
    });

    const res = await fetch(`https://smsc.ru/sys/send.php?${params.toString()}`);
    const data = await res.json();

    if (data.error) {
      console.error(`[SMS] Ошибка SMSC: ${data.error} (код: ${data.error_code})`);
      return false;
    }

    return true;
  } catch (e) {
    console.error("[SMS] Ошибка сети:", e);
    return false;
  }
}
