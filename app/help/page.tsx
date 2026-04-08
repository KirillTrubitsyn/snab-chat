"use client";

import { useState } from "react";
import Link from "next/link";

const ACCENT = "#2563EB";

type Section = {
  id: string;
  icon: React.ReactNode;
  title: string;
  content: React.ReactNode;
};

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round"
      style={{ transition: "transform 0.25s", transform: open ? "rotate(180deg)" : "rotate(0deg)", flexShrink: 0 }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function Accordion({ section }: { section: Section }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{
      border: "1px solid #E5E7EB",
      borderRadius: 12,
      overflow: "hidden",
      marginBottom: 12,
      background: "#fff",
      boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
    }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          padding: "16px 20px", background: "none", border: "none", cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{
          width: 36, height: 36, borderRadius: 10, background: open ? ACCENT : "#EFF6FF",
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          color: open ? "#fff" : ACCENT, transition: "background 0.2s, color 0.2s",
        }}>{section.icon}</span>
        <span style={{ flex: 1, fontWeight: 600, fontSize: 16, color: "#1A1A1A" }}>{section.title}</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div style={{ padding: "0 20px 20px", borderTop: "1px solid #F3F4F6" }}>
          {section.content}
        </div>
      )}
    </div>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: "12px 0", fontSize: 14, lineHeight: 1.7, color: "#374151" }}>{children}</p>;
}

function H({ children }: { children: React.ReactNode }) {
  return <h4 style={{ margin: "20px 0 8px", fontSize: 14, fontWeight: 700, color: "#111827", textTransform: "uppercase", letterSpacing: "0.04em" }}>{children}</h4>;
}

function Note({ children, type = "info" }: { children: React.ReactNode; type?: "info" | "warn" | "tip" }) {
  const cfg = {
    info: { bg: "#EFF6FF", border: "#BFDBFE", color: "#1D4ED8", icon: "ℹ️" },
    warn: { bg: "#FFFBEB", border: "#FDE68A", color: "#92400E", icon: "⚠️" },
    tip:  { bg: "#ECFDF5", border: "#A7F3D0", color: "#065F46", icon: "✅" },
  }[type];
  return (
    <div style={{
      background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 8,
      padding: "10px 14px", margin: "12px 0", fontSize: 13, color: cfg.color, lineHeight: 1.6,
    }}>
      {cfg.icon} {children}
    </div>
  );
}

function QAPair({ bad, good, explain }: { bad: string; good: string; explain: string }) {
  return (
    <div style={{ margin: "16px 0", background: "#F9FAFB", borderRadius: 10, padding: 16 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "flex-start" }}>
        <span style={{ background: "#FEE2E2", color: "#DC2626", borderRadius: 6, padding: "2px 8px", fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 2 }}>✗ Плохо</span>
        <span style={{ fontSize: 14, color: "#374151", fontStyle: "italic" }}>«{bad}»</span>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "flex-start" }}>
        <span style={{ background: "#DCFCE7", color: "#16A34A", borderRadius: 6, padding: "2px 8px", fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 2 }}>✓ Хорошо</span>
        <span style={{ fontSize: 14, color: "#374151", fontStyle: "italic" }}>«{good}»</span>
      </div>
      <div style={{ fontSize: 13, color: "#6B7280", marginTop: 4, paddingLeft: 4 }}>→ {explain}</div>
    </div>
  );
}

function StepList({ steps }: { steps: string[] }) {
  return (
    <ol style={{ margin: "10px 0", padding: 0, listStyle: "none" }}>
      {steps.map((s, i) => (
        <li key={i} style={{ display: "flex", gap: 12, marginBottom: 10, fontSize: 14, color: "#374151", lineHeight: 1.6 }}>
          <span style={{
            width: 24, height: 24, borderRadius: "50%", background: ACCENT, color: "#fff",
            fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2,
          }}>{i + 1}</span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}

const sections: Section[] = [
  {
    id: "principles",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
    title: "Как работает СнабЧат — главное",
    content: (
      <>
        <P>СнабЧат — это ваш персональный помощник по базе документов Дирекции по закупкам. Он читает загруженные документы и отвечает на вопросы строго по их содержимому.</P>
        <Note type="warn">Ассистент не использует интернет и не знает ничего «сам по себе». Все его ответы — только из документов, которые есть в базе знаний. Если нужной информации в документах нет — он честно об этом скажет.</Note>
        <H>Как строится ответ</H>
        <StepList steps={[
          "Вы задаёте вопрос в чате.",
          "Система находит в базе знаний фрагменты документов, которые наиболее близки к вашему вопросу.",
          "На основе найденных фрагментов формируется ответ.",
          "В конце ответа указываются источники — документы, из которых взята информация. Нажав на источник, вы можете просмотреть оригинальный документ.",
        ]} />
        <Note type="info">Если в ответе вы видите фразу «информация в базе знаний отсутствует» — это значит, что нужного документа нет в системе, либо в нём не описана эта тема. Уточните у ответственного специалиста.</Note>
      </>
    ),
  },
  {
    id: "questions",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
    title: "Как задавать вопросы — от этого зависит всё",
    content: (
      <>
        <Note type="tip">Качество ответа напрямую зависит от качества вопроса. Чем точнее и конкретнее вы спрашиваете, тем полезнее и детальнее будет ответ.</Note>
        <P>Система ищет в документах то, о чём именно вы спрашиваете. Абстрактный, общий вопрос даст общий ответ. Конкретный, детальный вопрос — развёрнутый и точный.</P>

        <H>Примеры: как лучше спросить</H>

        <QAPair
          bad="Расскажи про закупки"
          good="Какой порядок согласования заявки на закупку материалов до 500 000 рублей?"
          explain="Общий вопрос даст обзорный ответ. Конкретный — пошаговую инструкцию."
        />
        <QAPair
          bad="Как выбрать поставщика?"
          good="Какие критерии оценки поставщиков применяются при проведении конкурентной закупки?"
          explain="Уточнение типа закупки позволяет найти именно нужный раздел регламента."
        />
        <QAPair
          bad="Что нужно для договора?"
          good="Какие документы необходимо приложить к договору поставки с новым поставщиком?"
          explain="Тип договора и ситуация («новый поставщик») сужают поиск до нужного места."
        />
        <QAPair
          bad="Сроки"
          good="В течение какого срока финансовый департамент должен согласовать договор на сумму свыше 1 000 000 рублей?"
          explain="Одно слово не даст системе понять, что именно вы ищете."
        />

        <H>Полезные приёмы</H>
        <ul style={{ margin: "8px 0", padding: "0 0 0 20px" }}>
          {[
            "Называйте конкретные суммы, сроки, типы договоров — это сильно улучшает поиск.",
            "Если что-то непонятно в ответе, задайте уточняющий вопрос прямо в той же беседе.",
            "Можно попросить: «Приведи пример», «Перечисли по пунктам», «Оформи в виде таблицы».",
            "Если ответ кажется неполным — попробуйте переформулировать вопрос более конкретно.",
            "Используйте профессиональную терминологию из ваших документов — это повышает точность поиска.",
          ].map((t, i) => (
            <li key={i} style={{ fontSize: 14, color: "#374151", marginBottom: 6, lineHeight: 1.6 }}>{t}</li>
          ))}
        </ul>
      </>
    ),
  },
  {
    id: "knowledge-base",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>,
    title: "База знаний — что там и как ею пользоваться",
    content: (
      <>
        <P>В базе знаний хранятся все документы, которые система использует для ответов: регламенты, инструкции, шаблоны договоров, прайс-листы и другие материалы.</P>
        <H>Как открыть базу знаний</H>
        <P>Нажмите кнопку <strong>«База знаний»</strong> в верхней панели. Откроется список всех доступных документов. Вы можете просмотреть любой документ, нажав на него.</P>
        <H>Источники в ответах</H>
        <P>После каждого ответа система показывает раздел <strong>«Источники»</strong>. Нажмите на него, чтобы развернуть список документов, из которых был составлен ответ. Кликнув на название документа, вы откроете его текст и сможете найти конкретный фрагмент.</P>
        <Note type="tip">Если ответ вызывает сомнения — всегда проверяйте источники. Там вы найдёте точную цитату и контекст.</Note>
      </>
    ),
  },
  {
    id: "documents",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>,
    title: "Загрузка документов в чат",
    content: (
      <>
        <P>Вы можете прикрепить файл прямо к сообщению — тогда ассистент ответит на вопрос с учётом содержимого этого документа, даже если его нет в базе знаний.</P>
        <H>Поддерживаемые форматы</H>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "8px 0 16px" }}>
          {["DOCX", "PDF", "XLSX", "PPTX", "TXT", "MD"].map((f) => (
            <span key={f} style={{ background: "#EFF6FF", color: ACCENT, border: "1px solid #BFDBFE", borderRadius: 6, padding: "4px 10px", fontSize: 13, fontWeight: 600 }}>{f}</span>
          ))}
        </div>
        <H>Как прикрепить файл</H>
        <StepList steps={[
          "Нажмите на иконку скрепки (📎) в строке ввода сообщения.",
          "Выберите файл с компьютера (до 50 МБ).",
          "Дождитесь, пока файл загрузится и обработается — появится метка с именем файла.",
          "Напишите ваш вопрос и отправьте. Система учтёт содержимое файла при ответе.",
        ]} />
        <Note type="tip">Сценарии использования: проверить договор на соответствие внутренним требованиям, сравнить коммерческое предложение поставщика с нормативами, задать вопрос по конкретному протоколу или акту.</Note>
        <Note type="warn">Файлы в форматах .doc и .xls (старые версии Office) не поддерживаются. Пересохраните их в .docx или .xlsx перед загрузкой.</Note>
      </>
    ),
  },
  {
    id: "audio",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>,
    title: "Загрузка аудио",
    content: (
      <>
        <P>Система умеет работать с аудиозаписями: совещания, переговоры, диктовки — всё это можно загрузить и задать вопрос по содержанию.</P>
        <H>Поддерживаемые форматы</H>
        <div style={{ display: "flex", gap: 8, margin: "8px 0 16px", flexWrap: "wrap" }}>
          {["MP3", "WAV"].map((f) => (
            <span key={f} style={{ background: "#EFF6FF", color: ACCENT, border: "1px solid #BFDBFE", borderRadius: 6, padding: "4px 10px", fontSize: 13, fontWeight: 600 }}>{f}</span>
          ))}
        </div>
        <H>Как использовать</H>
        <StepList steps={[
          "Нажмите иконку скрепки (📎) в строке ввода.",
          "Выберите аудиофайл.",
          "После обработки напишите вопрос: «О чём шла речь на совещании?», «Какие решения были приняты?», «Перечисли задачи из записи».",
        ]} />
        <Note type="info">Аудио расшифровывается автоматически. Качество ответа зависит от чёткости записи. При фоновом шуме или нечёткой речи расшифровка может быть неточной.</Note>
      </>
    ),
  },
  {
    id: "links",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
    title: "Вставка ссылок на сайты",
    content: (
      <>
        <P>Вставьте ссылку прямо в текст сообщения — система автоматически загрузит содержимое страницы и учтёт его в ответе.</P>
        <H>Как это работает</H>
        <P>Просто напишите вопрос и включите в него ссылку, например:</P>
        <div style={{ background: "#F9FAFB", borderRadius: 8, padding: "10px 14px", margin: "10px 0", fontSize: 13, fontStyle: "italic", color: "#374151", borderLeft: "3px solid #BFDBFE" }}>
          «Проверь, соответствует ли эта спецификация нашим требованиям: https://supplier-site.ru/spec.pdf»
        </div>
        <Note type="info">Функция работает для общедоступных страниц. Сайты, требующие авторизации или защищённые от роботов, могут не загрузиться.</Note>
        <Note type="tip">Удобно использовать для анализа сайтов поставщиков, проверки публичных документов, сравнения внешних данных с внутренними регламентами.</Note>
      </>
    ),
  },
  {
    id: "photos",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>,
    title: "Загрузка фотографий и изображений",
    content: (
      <>
        <P>Сфотографировали документ, акт, маркировку товара или скриншот экрана — всё это можно прикрепить к сообщению.</P>
        <H>Поддерживаемые форматы</H>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "8px 0 16px" }}>
          {["JPG", "PNG", "GIF", "BMP", "WEBP"].map((f) => (
            <span key={f} style={{ background: "#EFF6FF", color: ACCENT, border: "1px solid #BFDBFE", borderRadius: 6, padding: "4px 10px", fontSize: 13, fontWeight: 600 }}>{f}</span>
          ))}
        </div>
        <H>Сценарии использования</H>
        <ul style={{ margin: "8px 0", padding: "0 0 0 20px" }}>
          {[
            "Фото накладной или акта — попросить найти несоответствия или выгрузить данные.",
            "Скриншот из другой системы — уточнить что-то по его содержимому.",
            "Фото маркировки товара — уточнить требования к данному виду продукции.",
            "Снимок таблицы — преобразовать в текст и проанализировать.",
          ].map((t, i) => (
            <li key={i} style={{ fontSize: 14, color: "#374151", marginBottom: 6, lineHeight: 1.6 }}>{t}</li>
          ))}
        </ul>
      </>
    ),
  },
  {
    id: "infographic",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M17.5 17.5 21 21M14 17.5h7M17.5 14v7"/></svg>,
    title: "Инфографика — визуализация ответов",
    content: (
      <>
        <P>Любой ответ ассистента можно превратить в красивую инфографику: схему процесса, сравнительную таблицу, статистику или пошаговую инструкцию.</P>
        <H>Способы создания</H>
        <StepList steps={[
          "Получите ответ от ассистента на любой вопрос.",
          "Нажмите кнопку «Создать инфографику» под ответом — контекст передастся автоматически.",
          "Либо нажмите «Инфографика» в верхней панели для создания с чистого листа.",
          "Выберите тему, стиль оформления и формат (горизонтальный, квадратный, вертикальный).",
          "Нажмите «Создать» и через несколько секунд получите готовое изображение.",
          "Скачайте результат в PNG для использования в презентациях или отчётах.",
        ]} />
        <H>Доступные стили</H>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "8px 0 16px" }}>
          {["Бизнес-инфографика", "Временная шкала", "Сравнение", "Дашборд", "Блок-схема", "Оргструктура", "Майндмап", "Краткая инструкция"].map((s) => (
            <span key={s} style={{ background: "#F3F4F6", color: "#374151", border: "1px solid #E5E7EB", borderRadius: 6, padding: "4px 10px", fontSize: 12 }}>{s}</span>
          ))}
        </div>
        <Note type="info">Созданные инфографики сохраняются в панели справа, вкладка «Инфографика». Лимит хранения — 20 штук.</Note>
      </>
    ),
  },
  {
    id: "history",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><polyline points="12 7 12 12 15 15"/></svg>,
    title: "История диалогов",
    content: (
      <>
        <P>Все ваши беседы с ассистентом сохраняются автоматически. Панель истории открывается кнопкой <strong>«Диалоги»</strong> в правой части экрана.</P>
        <H>Что можно делать</H>
        <ul style={{ margin: "8px 0", padding: "0 0 0 20px" }}>
          {[
            "Переключаться между диалогами — нажмите на нужный в списке.",
            "Переименовать диалог — дважды кликните на его название.",
            "Удалить один диалог — нажмите иконку корзины рядом с ним.",
            "Удалить несколько сразу — нажмите «Выбрать», отметьте нужные и нажмите «Удалить».",
            "Начать новый диалог — нажмите «+» вверху панели или кнопку «Новый чат» в шапке.",
          ].map((t, i) => (
            <li key={i} style={{ fontSize: 14, color: "#374151", marginBottom: 6, lineHeight: 1.6 }}>{t}</li>
          ))}
        </ul>
        <Note type="warn">Лимит хранения — 20 диалогов. При достижении лимита нужно удалить старые диалоги, чтобы создать новый.</Note>
        <Note type="tip">Давайте диалогам понятные названия — это поможет быстро найти нужную беседу в списке.</Note>
      </>
    ),
  },
  {
    id: "export",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
    title: "Сохранение и экспорт ответов",
    content: (
      <>
        <P>Готовый ответ можно сохранить в удобном формате для дальнейшей работы.</P>
        <H>Форматы экспорта</H>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, margin: "12px 0" }}>
          {[
            { fmt: "DOCX", desc: "Документ Word — удобно для включения в отчёты, дальнейшего редактирования и отправки по почте." },
            { fmt: "XLSX", desc: "Таблица Excel — доступно, если в ответе есть таблица. Позволяет работать с данными в Excel." },
          ].map(({ fmt, desc }) => (
            <div key={fmt} style={{ background: "#F9FAFB", borderRadius: 10, padding: 14, border: "1px solid #E5E7EB" }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: ACCENT, marginBottom: 6 }}>.{fmt.toLowerCase()}</div>
              <div style={{ fontSize: 13, color: "#6B7280", lineHeight: 1.5 }}>{desc}</div>
            </div>
          ))}
        </div>
        <P>Кнопки «Скачать .docx» и «Скачать .xlsx» появляются под каждым ответом ассистента.</P>
      </>
    ),
  },
  {
    id: "tips",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
    title: "Советы и частые ошибки",
    content: (
      <>
        <H>Как получать лучшие результаты</H>
        <ul style={{ margin: "8px 0", padding: "0 0 0 20px" }}>
          {[
            "Один вопрос — одна тема. Не смешивайте несколько несвязанных вопросов в одном сообщении.",
            "Продолжайте разговор в одном диалоге — ассистент помнит контекст беседы.",
            "Если ответ неточный, добавьте детали: укажите подразделение, тип документа, период, сумму.",
            "Просите форматировать ответ удобным способом: «в виде таблицы», «по пунктам», «коротко».",
            "Используйте подсказки «Вам также может быть полезно» под ответами — это готовые уточняющие вопросы.",
          ].map((t, i) => (
            <li key={i} style={{ fontSize: 14, color: "#374151", marginBottom: 8, lineHeight: 1.6 }}>{t}</li>
          ))}
        </ul>
        <H>Частые ошибки</H>
        <ul style={{ margin: "8px 0", padding: "0 0 0 20px" }}>
          {[
            "Ожидать ответа на вопрос, которого нет в документах. Если тема не задокументирована — система не сможет ответить.",
            "Задавать расплывчатые вопросы и ждать точных ответов — уточняйте.",
            "Принимать ответ за окончательную истину без проверки источников по важным вопросам.",
            "Загружать слишком большие файлы без необходимости — лучше выделить нужный раздел.",
          ].map((t, i) => (
            <li key={i} style={{ fontSize: 14, color: "#374151", marginBottom: 8, lineHeight: 1.6 }}>{t}</li>
          ))}
        </ul>
        <Note type="info">Если что-то не работает или возникли вопросы — обратитесь в поддержку через кнопку «Поддержка» в шапке приложения.</Note>
      </>
    ),
  },
];

export default function HelpPage() {
  return (
    <div style={{ minHeight: "100dvh", background: "#FAFAFA", fontFamily: "'Source Sans 3', system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{
        position: "sticky", top: 0, zIndex: 100, background: "#fff",
        borderBottom: "1px solid #E5E7EB", padding: "0 20px",
        height: 56, display: "flex", alignItems: "center", justifyContent: "space-between",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/" style={{
            display: "flex", alignItems: "center", gap: 8, color: ACCENT,
            textDecoration: "none", fontSize: 14, fontWeight: 600,
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"/>
              <polyline points="12 19 5 12 12 5"/>
            </svg>
            В чат
          </Link>
          <span style={{ color: "#D1D5DB" }}>|</span>
          <span style={{ fontWeight: 700, fontSize: 16, color: "#1A1A1A" }}>Инструкция пользователя</span>
        </div>
        <span style={{ fontSize: 12, color: "#9CA3AF" }}>СнабЧат · Дирекция по закупкам</span>
      </div>

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "32px 20px 64px" }}>
        {/* Hero */}
        <div style={{
          background: "linear-gradient(135deg, #1D4ED8 0%, #2563EB 60%, #3B82F6 100%)",
          borderRadius: 16, padding: "32px 28px", marginBottom: 32, color: "#fff",
          boxShadow: "0 8px 32px rgba(37,99,235,0.25)",
        }}>
          <div style={{ fontSize: 28, fontWeight: 800, marginBottom: 8, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
            СнабЧат — инструкция
          </div>
          <div style={{ fontSize: 15, opacity: 0.85, lineHeight: 1.6, maxWidth: 560 }}>
            Здесь вы найдёте всё необходимое для эффективной работы с ассистентом: от правил формулировки вопросов до работы с документами и инфографикой.
          </div>
        </div>

        {/* Quick nav pills */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 28 }}>
          {sections.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              style={{
                fontSize: 12, fontWeight: 600, color: "#374151",
                background: "#fff", border: "1px solid #E5E7EB",
                borderRadius: 20, padding: "5px 12px", textDecoration: "none",
                cursor: "pointer", transition: "border-color 0.15s",
              }}
            >
              {s.title.split("—")[0].trim()}
            </a>
          ))}
        </div>

        {/* Sections */}
        {sections.map((s) => (
          <div id={s.id} key={s.id} style={{ scrollMarginTop: 72 }}>
            <Accordion section={s} />
          </div>
        ))}

        <div style={{ marginTop: 32, textAlign: "center", color: "#9CA3AF", fontSize: 13 }}>
          Остались вопросы? Напишите нам через кнопку <strong>«Поддержка»</strong> в приложении.
        </div>
      </div>
    </div>
  );
}
