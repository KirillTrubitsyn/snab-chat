"use client";

import { useState } from "react";
import type { ExcelSheet } from "./types";

export default function ExcelViewer({ sheets }: { sheets: ExcelSheet[] }) {
  const [activeSheet, setActiveSheet] = useState(0);
  const sheet = sheets[activeSheet];
  if (!sheet) return null;

  const mergeMap = new Map<string, { rowSpan: number; colSpan: number } | "hidden">();
  for (const m of sheet.merges) {
    const rowSpan = m.e.r - m.s.r + 1;
    const colSpan = m.e.c - m.s.c + 1;
    mergeMap.set(`${m.s.r},${m.s.c}`, { rowSpan, colSpan });
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r !== m.s.r || c !== m.s.c) {
          mergeMap.set(`${r},${c}`, "hidden");
        }
      }
    }
  }

  return (
    <div className="excel-viewer">
      {sheets.length > 1 && (
        <div className="excel-sheet-tabs">
          {sheets.map((s, i) => (
            <button
              key={i}
              className={`excel-sheet-tab ${i === activeSheet ? "active" : ""}`}
              onClick={() => setActiveSheet(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="excel-table-wrapper">
        <table className="excel-table">
          <tbody>
            {sheet.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => {
                  const key = `${ri},${ci}`;
                  const merge = mergeMap.get(key);
                  if (merge === "hidden") return null;
                  const span = merge || undefined;
                  const isEmpty = cell.trim() === "";
                  return (
                    <td
                      key={ci}
                      rowSpan={span?.rowSpan}
                      colSpan={span?.colSpan}
                      className={isEmpty ? "excel-cell-empty" : undefined}
                    >
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
