"use client";

import { useState, useRef, useCallback } from "react";

export default function CameraButton({
  onCapture,
  disabled,
  maxPhotos = 10,
  currentPhotoCount = 0,
}: {
  onCapture: (file: File) => void;
  disabled?: boolean;
  maxPhotos?: number;
  currentPhotoCount?: number;
}) {
  const [showCamera, setShowCamera] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const isLimitReached = currentPhotoCount >= maxPhotos;

  const startCamera = useCallback(async () => {
    try {
      setError(null);
      setReady(false);
      if (stream) stream.getTracks().forEach((t) => t.stop());

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      setStream(mediaStream);

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current
            ?.play()
            .then(() => setReady(true))
            .catch(() => setError("Не удалось запустить видео"));
        };
      }
    } catch {
      setError("Нет доступа к камере");
    }
  }, [facingMode, stream]);

  const stopCamera = useCallback(() => {
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null);
    setReady(false);
  }, [stream]);

  const openCamera = () => {
    if (isLimitReached) return;
    setShowCamera(true);
    setTimeout(() => startCamera(), 100);
  };

  const closeCamera = () => {
    stopCamera();
    setShowCamera(false);
    setError(null);
  };

  const capture = () => {
    if (!videoRef.current || !canvasRef.current || !ready) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    canvas.toBlob(
      (blob) => {
        if (blob) {
          onCapture(new File([blob], `photo_${Date.now()}.jpg`, { type: "image/jpeg" }));
          closeCamera();
        }
      },
      "image/jpeg",
      0.85
    );
  };

  const switchCam = () => {
    stopCamera();
    setFacingMode((f) => (f === "environment" ? "user" : "environment"));
    setTimeout(() => startCamera(), 100);
  };

  return (
    <>
      <button
        onClick={openCamera}
        disabled={disabled || isLimitReached}
        type="button"
        className="camera-btn"
        title="Сделать фото документа"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
        {currentPhotoCount > 0 && <span className="camera-badge">{currentPhotoCount}</span>}
      </button>

      {showCamera && (
        <div className="camera-overlay">
          <div className="camera-header">
            <button onClick={closeCamera} className="camera-close" type="button">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <span className="camera-counter">{currentPhotoCount + 1} / {maxPhotos}</span>
            <button onClick={switchCam} className="camera-switch" type="button">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
                <path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" />
                <polyline points="16 17 21 12 16 7" />
                <polyline points="8 7 3 12 8 17" />
              </svg>
            </button>
          </div>

          {error ? (
            <div className="camera-error">
              <p>{error}</p>
              <button onClick={startCamera} className="camera-retry" type="button">Повторить</button>
            </div>
          ) : (
            <>
              <video ref={videoRef} autoPlay playsInline muted className="camera-video" />
              {!ready && (
                <div className="camera-loading">
                  <div className="camera-spinner" />
                </div>
              )}
            </>
          )}

          <div className="camera-bottom">
            <button onClick={capture} disabled={!ready} className={`camera-shutter ${!ready ? "disabled" : ""}`} type="button">
              <div className="camera-shutter-inner" />
            </button>
          </div>

          <canvas ref={canvasRef} style={{ display: "none" }} />
        </div>
      )}
    </>
  );
}
