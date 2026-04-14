"use client";

import { useState, useRef, useEffect, useCallback } from "react";

const VIDEO_URL =
  "https://hjjfugvnhjnvbchfjsbm.supabase.co/storage/v1/object/public/videos/snabchat-presentation-720p.mp4?v=2";

interface VideoOverlayProps {
  open: boolean;
  onClose: () => void;
}

export default function VideoOverlay({ open, onClose }: VideoOverlayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [ready, setReady] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const loadTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const autoPlayFired = useRef(false);
  const playPromise = useRef<Promise<void> | null>(null);

  const LOAD_TIMEOUT_MS = 20_000;

  /* ── Auto-hide controls ── */
  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setControlsVisible(true);
    hideTimer.current = setTimeout(() => {
      if (playing) setControlsVisible(false);
    }, 3000);
  }, [playing]);

  /* ── Toggle play/pause ── */
  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setError(null);
    if (v.paused) {
      const p = v.play();
      playPromise.current = p;
      p.then(() => setPlaying(true))
        .catch((e) => {
          if (e.name === "AbortError") return;
          setError(e.message);
        });
    } else {
      const pending = playPromise.current;
      if (pending) {
        pending.then(() => { v.pause(); setPlaying(false); }).catch(() => { v.pause(); setPlaying(false); });
        playPromise.current = null;
      } else {
        v.pause();
        setPlaying(false);
      }
    }
    scheduleHide();
  }, [scheduleHide]);

  /* ── Auto-play: fires exactly once when overlay opens and video is ready ── */
  useEffect(() => {
    if (!open || !ready || !videoRef.current || autoPlayFired.current) return;
    autoPlayFired.current = true;
    const p = videoRef.current.play();
    playPromise.current = p;
    p.then(() => { setPlaying(true); scheduleHide(); })
      .catch((e) => {
        // AbortError is harmless (play interrupted by pause); NotAllowedError means
        // the browser blocked autoplay — user will see the play button and can click.
        if (e.name !== "AbortError") {
          setPlaying(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready]);

  /* ── Reset autoplay flag when overlay closes ── */
  useEffect(() => {
    if (!open) {
      autoPlayFired.current = false;
      const v = videoRef.current;
      if (v) {
        const pending = playPromise.current;
        if (pending) {
          pending.then(() => { v.pause(); v.currentTime = 0; }).catch(() => { v.pause(); v.currentTime = 0; });
          playPromise.current = null;
        } else {
          v.pause();
          v.currentTime = 0;
        }
      }
      setPlaying(false);
      setReady(false);
      setLoading(true);
    }
  }, [open]);

  /* ── Loading timeout: avoid infinite spinner on slow/blocked networks ── */
  useEffect(() => {
    if (!open) return;
    if (ready || error) {
      if (loadTimer.current) { clearTimeout(loadTimer.current); loadTimer.current = undefined; }
      return;
    }
    loadTimer.current = setTimeout(() => {
      if (!ready && !error) {
        setError("Не удалось загрузить видео. Проверьте подключение к сети.");
        setLoading(false);
      }
    }, LOAD_TIMEOUT_MS);
    return () => { if (loadTimer.current) { clearTimeout(loadTimer.current); loadTimer.current = undefined; } };
  }, [open, ready, error]);

  /* ── Cleanup hide timer ── */
  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (loadTimer.current) clearTimeout(loadTimer.current);
    };
  }, []);

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!videoRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    videoRef.current.currentTime = pct * duration;
  };

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const handleClose = () => {
    const v = videoRef.current;
    if (v) {
      const pending = playPromise.current;
      if (pending) {
        pending.then(() => v.pause()).catch(() => v.pause());
        playPromise.current = null;
      } else {
        v.pause();
      }
    }
    setPlaying(false);
    onClose();
  };

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 99999,
        background: "rgba(0,0,0,0.92)",
        display: "flex", alignItems: "center", justifyContent: "center",
        animation: "videoFadeIn 0.3s ease",
      }}
      onClick={handleClose}
      onMouseMove={scheduleHide}
      onTouchStart={scheduleHide}
    >
      <style>{`
        @keyframes videoFadeIn { from { opacity: 0 } to { opacity: 1 } }
        .vo-controls { transition: opacity 0.3s ease; }
        .vo-progress-bar { cursor: pointer; }
        .vo-progress-bar:hover .vo-progress-fill { height: 6px; }
        .vo-btn { background: none; border: none; color: #fff; cursor: pointer; padding: 8px; display: flex; align-items: center; justify-content: center; border-radius: 8px; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
        .vo-btn:hover { background: rgba(255,255,255,0.12); }
        .vo-btn:active { background: rgba(255,255,255,0.2); }
      `}</style>

      {/* Video container — click toggles play/pause */}
      <div
        style={{
          position: "relative", width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
        onClick={(e) => { e.stopPropagation(); toggle(); scheduleHide(); }}
      >
        <video
          ref={videoRef}
          src={VIDEO_URL}
          playsInline
          preload="auto"
          style={{
            maxWidth: "100%", maxHeight: "100%",
            borderRadius: 0, outline: "none",
            pointerEvents: "none",
          }}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onCanPlay={() => { setLoading(false); setReady(true); }}
          onTimeUpdate={(e) => setProgress(e.currentTarget.currentTime)}
          onEnded={() => { setPlaying(false); setControlsVisible(true); }}
          onWaiting={() => setLoading(true)}
          onPlaying={() => { setLoading(false); setError(null); }}
          onStalled={() => {
            // Video data transfer stalled — start showing spinner so user gets feedback
            if (!error) setLoading(true);
          }}
          onError={(e) => {
            const v = e.currentTarget;
            const code = v.error?.code;
            const msg = code === 1 ? "Загрузка видео была прервана"
              : code === 2 ? "Сетевая ошибка загрузки видео"
              : code === 3 ? "Формат видео не поддерживается браузером"
              : code === 4 ? "Видео недоступно"
              : "Ошибка воспроизведения";
            setError(msg);
            setLoading(false);
          }}
        />

        {/* Loading spinner */}
        {loading && !error && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            pointerEvents: "none",
          }}>
            <div style={{
              width: 48, height: 48, border: "3px solid rgba(255,255,255,0.2)",
              borderTop: "3px solid #fff", borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 16, padding: 24,
          }}>
            <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 15, textAlign: "center", maxWidth: 400 }}>
              {error}
            </div>
            <button
              className="vo-btn"
              onClick={(e) => {
                e.stopPropagation();
                setError(null);
                setLoading(true);
                setReady(false);
                autoPlayFired.current = false;
                if (videoRef.current) videoRef.current.load();
              }}
              style={{ background: "rgba(255,255,255,0.15)", padding: "10px 24px", borderRadius: 10, fontSize: 14 }}
            >
              Повторить
            </button>
          </div>
        )}

        {/* Large play button (when paused) */}
        {!playing && !loading && !error && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            pointerEvents: "none",
          }}>
            <div style={{
              width: 72, height: 72, borderRadius: "50%",
              background: "rgba(0,0,0,0.55)", backdropFilter: "blur(8px)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="#fff">
                <polygon points="6 3 20 12 6 21" />
              </svg>
            </div>
          </div>
        )}

        {/* Close button — always clickable */}
        <button
          className="vo-btn"
          onClick={(e) => { e.stopPropagation(); handleClose(); }}
          style={{
            position: "absolute", top: 16, right: 16,
            background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)",
            width: 44, height: 44, borderRadius: 12,
            opacity: controlsVisible ? 1 : 0.4,
            transition: "opacity 0.3s",
            pointerEvents: "auto",
          }}
          title="Закрыть"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {/* Bottom controls bar */}
        <div
          className="vo-controls"
          style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            padding: "24px 16px 16px",
            background: "linear-gradient(transparent, rgba(0,0,0,0.7))",
            opacity: controlsVisible ? 1 : 0,
            pointerEvents: controlsVisible ? "auto" : "none",
          }}
          onClick={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          {/* Progress bar */}
          <div
            className="vo-progress-bar"
            style={{ height: 28, display: "flex", alignItems: "center", marginBottom: 8 }}
            onClick={seek}
          >
            <div style={{
              width: "100%", height: 4, background: "rgba(255,255,255,0.25)",
              borderRadius: 2, position: "relative", overflow: "hidden",
            }}>
              <div
                className="vo-progress-fill"
                style={{
                  width: duration ? `${(progress / duration) * 100}%` : "0%",
                  height: "100%", background: "#2563EB", borderRadius: 2,
                  transition: "width 0.1s linear, height 0.15s",
                }}
              />
            </div>
          </div>

          {/* Buttons row */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button className="vo-btn" onClick={(e) => { e.stopPropagation(); toggle(); }} style={{ padding: 12 }}>
              {playing ? (
                <svg width="26" height="26" viewBox="0 0 24 24" fill="#fff"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
              ) : (
                <svg width="26" height="26" viewBox="0 0 24 24" fill="#fff"><polygon points="6 3 20 12 6 21" /></svg>
              )}
            </button>

            <button className="vo-btn" onClick={(e) => { e.stopPropagation(); setMuted(!muted); if (videoRef.current) videoRef.current.muted = !muted; }} style={{ padding: 12 }}>
              {muted ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>
              )}
            </button>

            <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, fontVariantNumeric: "tabular-nums", marginLeft: 4 }}>
              {fmt(progress)} / {fmt(duration)}
            </span>

            <div style={{ flex: 1 }} />

            <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 12 }}>
              Презентация СнабЧат
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
