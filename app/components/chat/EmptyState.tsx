"use client";

import { SpektrIcon } from "./icons";

export default function EmptyState({ onChipClick }: { onChipClick?: (text: string) => void }) {
  return (
    <div className="empty-state">
      <div className="welcome-logo-glow">
        <SpektrIcon size={96} />
      </div>
      <div className="welcome-dept">Дирекция по закупкам</div>
      <div className="welcome-brand">
        <span style={{ color: '#003A7A' }}>Снаб</span><span style={{ color: '#0099CC' }}>Чат</span>
      </div>
      <div className="welcome-divider" />
      <div className="welcome-role">Ваш ИИ-ассистент по закупкам</div>
      <div className="welcome-desc">
        Помогу разобраться в процедурах, найти нужный документ, подготовить ответ или проверить соответствие требованиям
      </div>
      <div className="welcome-chips">
        <div className="welcome-chips-row">
          <button className="welcome-chip" type="button" onClick={() => onChipClick?.("Какие полномочия у ЦЗК?")}>Полномочия ЦЗК</button>
          <button className="welcome-chip" type="button" onClick={() => onChipClick?.("Каков порядок проведения аварийной закупки?")}>Порядок аварийной закупки</button>
        </div>
        <div className="welcome-chips-row">
          <button className="welcome-chip" type="button" onClick={() => onChipClick?.("Какие этапы согласования договора на закупку?")}>Этапы согласования договора</button>
          <button className="welcome-chip" type="button" onClick={() => onChipClick?.("Когда проводится переторжка?")}>Когда проводится переторжка</button>
        </div>
      </div>
    </div>
  );
}
