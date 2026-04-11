"use client";

import { useState, useRef, useEffect, useCallback } from "react";

export function TableWrapper({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const checkOverflow = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      setOverflows(el.scrollWidth > el.clientWidth + 2);
    }
  }, []);

  useEffect(() => {
    checkOverflow();
    window.addEventListener("resize", checkOverflow);
    return () => window.removeEventListener("resize", checkOverflow);
  }, [checkOverflow]);

  return (
    <>
      <div className={`table-container${overflows ? " table-overflows" : ""}`} ref={containerRef}>
        <table {...props}>{children}</table>
        {overflows && !fullscreen && (
          <button
            className="table-fullscreen-btn"
            onClick={() => setFullscreen(true)}
            title="Развернуть таблицу на весь экран"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
            Развернуть
          </button>
        )}
      </div>
      {fullscreen && (
        <div className="table-fullscreen-overlay" onClick={() => setFullscreen(false)}>
          <div className="table-fullscreen-content" onClick={(e) => e.stopPropagation()}>
            <button className="table-fullscreen-close" onClick={() => setFullscreen(false)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
              Свернуть
            </button>
            <div className="table-fullscreen-scroll">
              <table {...props}>{children}</table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
