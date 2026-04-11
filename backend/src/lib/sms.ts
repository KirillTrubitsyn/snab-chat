/**
 * SMS отправка через SMS.ru API.
 * Документация: https://sms.ru/api/send
 * Env: SMSRU_API_ID
 */

const SMSRU_API_ID = process.env.SMSRU_API_ID ?? "";

export async function sendSMS(phone: string, message: string): Promise<{ ok: boolean; error?: string }> {
  if (!SMSRU_API_ID) {
    return { ok: false, error: "SMSRU_API_ID не настроен" };
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
      status: string;
      status_code: number;
      status_text?: string;
      sms?: Record<string, { status: string; status_code: number; status_text?: string }>;
    };

    if (data.status_code !== 100) {
      const errMsg = `SMS.ru: ${data.status_text || "Ошибка"} (код ${data.status_code})`;
      console.error(`[SMS] ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    // Проверить статус конкретного номера
    if (data.sms) {
      const phoneStatus = Object.values(data.sms)[0];
      if (phoneStatus && phoneStatus.status_code !== 100) {
        const errMsg = `SMS.ru: ${phoneStatus.status_text || "Ошибка"} (код ${phoneStatus.status_code})`;
        console.error(`[SMS] ${errMsg}`);
        return { ok: false, error: errMsg };
      }
    }

    return { ok: true };
  } catch (e) {
    console.error("[SMS] Ошибка сети:", e);
    return { ok: false, error: "Ошибка сети при отправке SMS" };
  }
}
