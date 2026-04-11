/**
 * SMS отправка через SMS.ru API.
 * Документация: https://sms.ru/api/send
 * Env: SMSRU_API_ID
 */

const SMSRU_API_ID = process.env.SMSRU_API_ID ?? "";

/**
 * Отправить SMS через SMS.ru.
 * @param phone — номер телефона (формат +7XXXXXXXXXX)
 * @param message — текст SMS
 * @returns true если отправлено успешно
 */
export async function sendSMS(phone: string, message: string): Promise<boolean> {
  if (!SMSRU_API_ID) {
    console.error("[SMS] SMSRU_API_ID не настроен");
    return false;
  }

  try {
    const params = new URLSearchParams({
      api_id: SMSRU_API_ID,
      to: phone,
      msg: message,
      json: "1",
    });

    const res = await fetch(`https://sms.ru/sms/send?${params.toString()}`);
    const data = await res.json() as {
      status_code: number;
      status_text?: string;
      sms?: Record<string, { status_code: number; status_text?: string }>;
    };

    if (data.status_code !== 100) {
      console.error(`[SMS] SMS.ru: ${data.status_text || "Ошибка"} (код ${data.status_code})`);
      return false;
    }

    // Проверить статус конкретного номера
    if (data.sms) {
      const phoneStatus = Object.values(data.sms)[0];
      if (phoneStatus && phoneStatus.status_code !== 100) {
        console.error(`[SMS] SMS.ru: ${phoneStatus.status_text || "Ошибка"} (код ${phoneStatus.status_code})`);
        return false;
      }
    }

    return true;
  } catch (e) {
    console.error("[SMS] Ошибка сети:", e);
    return false;
  }
}
