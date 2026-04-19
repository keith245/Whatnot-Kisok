'use client';

import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Keyboard,
  Camera,
} from 'lucide-react';

const CONFIG = {
  webhook: process.env.NEXT_PUBLIC_GOOGLE_SHEETS_WEBHOOK_URL || '/api/save-pickup',
  autoSubmitSeconds: 2,
  localStorageKey: 'whatnot_pickup_records',
  idleRefreshMs: 5 * 60 * 1000,
  successResetMs: 2500,
  warningResetMs: 5000,
};

function now() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
}

function today() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function loadSavedRecords() {
  try {
    const raw = localStorage.getItem(CONFIG.localStorageKey);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecords(records) {
  try {
    localStorage.setItem(CONFIG.localStorageKey, JSON.stringify(records));
  } catch {}
}

async function postToSheet(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {}

  return {
    ok: res.ok,
    message: data?.message || (res.ok ? 'Saved' : 'Failed'),
  };
}

function extractScanData(raw) {
  const value = String(raw || '').trim();

  if (!value) {
    return {
      pickupCode: '',
      shipmentId: '',
      raw: value,
    };
  }

  try {
    if (value.startsWith('{')) {
      const obj = JSON.parse(value);
      return {
        pickupCode: String(
          obj.pickupCode || obj.code || obj.pickup_code || ''
        ).trim(),
        shipmentId: String(
          obj.shipmentId || obj.shipment_id || obj.shipment || ''
        ).trim(),
        raw: value,
      };
    }

    if (value.startsWith('http://') || value.startsWith('https://')) {
      const url = new URL(value);

      const pickupCode =
        url.searchParams.get('pickupCode') ||
        url.searchParams.get('pickup_code') ||
        url.searchParams.get('code') ||
        '';

      let shipmentId =
        url.searchParams.get('shipmentId') ||
        url.searchParams.get('shipment_id') ||
        url.searchParams.get('shipment') ||
        '';

      if (!shipmentId) {
        const shipmentMatch = value.match(/[?&]shipmentid=([^&]+)/i);
        if (shipmentMatch?.[1]) {
          shipmentId = decodeURIComponent(shipmentMatch[1]);
        }
      }

      return {
        pickupCode: String(pickupCode).trim(),
        shipmentId: String(shipmentId).trim(),
        raw: value,
      };
    }
  } catch {}

  const pickupMatch = value.match(/pickupcode=([^&\s]+)/i);
  const shipmentMatch = value.match(/shipmentid=([^&\s]+)/i);

  return {
    pickupCode: pickupMatch?.[1] ? decodeURIComponent(pickupMatch[1]).trim() : value,
    shipmentId: shipmentMatch?.[1] ? decodeURIComponent(shipmentMatch[1]).trim() : '',
    raw: value,
  };
}

function playTone(frequencyA, frequencyB, duration = 0.18, volume = 0.14) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequencyA, ctx.currentTime);
    if (frequencyB) {
      osc.frequency.setValueAtTime(frequencyB, ctx.currentTime + duration / 2);
    }

    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + duration + 0.02);

    osc.onended = () => {
      ctx.close().catch(() => {});
    };
  } catch {}
}

function playScanBeep() {
  playTone(740, 880, 0.12, 0.1);
}

function playSuccessBeep() {
  playTone(880, 1046, 0.24, 0.18);
}

function playDuplicateBeep() {
  playTone(440, 330, 0.28, 0.16);
}

function Scanner({ onScan, locked, pulse }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [cameraError, setCameraError] = useState('');

  useEffect(() => {
    let stream = null;
    let raf = null;
    let cancelled = false;
    let lastScanAttempt = 0;
    let lastSuccessfulScan = 0;

    async function start() {
      try {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas) return;

        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        video.srcObject = stream;

        try {
          await video.play();
        } catch (err) {
          if (err?.name !== 'AbortError') throw err;
          return;
        }

        setCameraError('');

        const tick = () => {
          if (cancelled) return;

          const nowMs = Date.now();
          const videoEl = videoRef.current;
          const canvasEl = canvasRef.current;

          if (!videoEl || !canvasEl) {
            raf = requestAnimationFrame(tick);
            return;
          }

          if (
            !locked &&
            nowMs - lastScanAttempt >= 250 &&
            videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            videoEl.videoWidth > 0 &&
            videoEl.videoHeight > 0
          ) {
            lastScanAttempt = nowMs;

            const ctx = canvasEl.getContext('2d', { willReadFrequently: true });

            if (ctx) {
              const targetWidth = 640;
              const scale = targetWidth / videoEl.videoWidth;
              const targetHeight = Math.round(videoEl.videoHeight * scale);

              canvasEl.width = targetWidth;
              canvasEl.height = targetHeight;
              ctx.drawImage(videoEl, 0, 0, targetWidth, targetHeight);

              const img = ctx.getImageData(0, 0, targetWidth, targetHeight);
              const result = jsQR(img.data, img.width, img.height);

              if (result?.data && nowMs - lastSuccessfulScan > 1200) {
                lastSuccessfulScan = nowMs;
                onScan(result.data);
              }
            }
          }

          raf = requestAnimationFrame(tick);
        };

        raf = requestAnimationFrame(tick);
      } catch (err) {
        console.error('Scanner startup failed:', err);
        setCameraError('Camera access failed. Please allow camera access and refresh.');
      }
    }

    start();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.srcObject = null;
      }
    };
  }, [onScan, locked]);

  return (
    <div>
      <div className="relative overflow-hidden rounded-3xl border border-neutral-200 bg-black shadow-xl">
        <video
          ref={videoRef}
          className="aspect-[4/3] w-full max-h-[40vh] object-cover"
          muted
          playsInline
          autoPlay
        />
        <canvas ref={canvasRef} className="hidden" />

        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            className={`h-[52%] w-[82%] rounded-2xl border-4 ${
              pulse ? 'border-amber-400 shadow-[0_0_24px_rgba(251,191,36,0.7)]' : 'border-white'
            } shadow-[0_0_0_9999px_rgba(0,0,0,0.28)] transition-all duration-500`}
          />
        </div>
      </div>

      {cameraError ? (
        <p className="mt-3 text-center text-sm text-red-600">{cameraError}</p>
      ) : null}
    </div>
  );
}

function Overlay({ status, code, shipmentId, buyerName, message }) {
  if (status === 'done') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-6">
        <div className="w-full max-w-2xl rounded-3xl border border-green-300 bg-green-50 px-8 py-10 text-center shadow-2xl">
          <div className="flex justify-center">
            <CheckCircle2 className="h-24 w-24 text-green-600" />
          </div>
          <div className="mt-5 text-sm font-semibold uppercase tracking-[0.3em] text-green-700">
            Success
          </div>
          <div className="mt-3 text-4xl font-bold text-green-900 md:text-6xl">
            Pickup Complete
          </div>
          <div className="mt-5 break-all text-xl font-semibold text-green-800 md:text-2xl">
            {code}
          </div>
          {shipmentId ? (
            <div className="mt-3 break-all text-base text-green-700 md:text-lg">
              Shipment ID: {shipmentId}
            </div>
          ) : null}
          {buyerName ? (
            <div className="mt-2 break-all text-base text-green-700 md:text-lg">
              Buyer: {buyerName}
            </div>
          ) : null}
          <div className="mt-5 text-base text-green-700 md:text-lg">{message}</div>
        </div>
      </div>
    );
  }

  if (status === 'duplicate') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-6">
        <div className="w-full max-w-2xl rounded-3xl border border-amber-300 bg-amber-50 px-8 py-10 text-center shadow-2xl">
          <div className="flex justify-center">
            <AlertTriangle className="h-24 w-24 text-amber-600" />
          </div>
          <div className="mt-5 text-sm font-semibold uppercase tracking-[0.3em] text-amber-700">
            Duplicate
          </div>
          <div className="mt-3 text-4xl font-bold text-amber-900 md:text-6xl">
            Already Picked Up
          </div>
          <div className="mt-5 break-all text-xl font-semibold text-amber-800 md:text-2xl">
            {code}
          </div>
          {shipmentId ? (
            <div className="mt-3 break-all text-base text-amber-700 md:text-lg">
              Shipment ID: {shipmentId}
            </div>
          ) : null}
          {buyerName ? (
            <div className="mt-2 break-all text-base text-amber-700 md:text-lg">
              Buyer: {buyerName}
            </div>
          ) : null}
          <div className="mt-5 text-base text-amber-700 md:text-lg">{message}</div>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-6">
        <div className="w-full max-w-2xl rounded-3xl border border-red-300 bg-red-50 px-8 py-10 text-center shadow-2xl">
          <div className="flex justify-center">
            <XCircle className="h-24 w-24 text-red-600" />
          </div>
          <div className="mt-5 text-sm font-semibold uppercase tracking-[0.3em] text-red-700">
            Error
          </div>
          <div className="mt-3 text-4xl font-bold text-red-900 md:text-6xl">
            Scan Failed
          </div>
          <div className="mt-5 break-all text-xl font-semibold text-red-800 md:text-2xl">
            {code || 'Please try again'}
          </div>
          {shipmentId ? (
            <div className="mt-3 break-all text-base text-red-700 md:text-lg">
              Shipment ID: {shipmentId}
            </div>
          ) : null}
          <div className="mt-5 text-base text-red-700 md:text-lg">
            {message || 'Please see staff if the issue continues.'}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

export default function Page() {
  const [records, setRecords] = useState([]);
  const [code, setCode] = useState('');
  const [shipmentId, setShipmentId] = useState('');
  const [buyerName, setBuyerName] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [manualShipmentId, setManualShipmentId] = useState('');
  const [manualFirstName, setManualFirstName] = useState('');
  const [manualLastName, setManualLastName] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [status, setStatus] = useState('ready');
  const [countdown, setCountdown] = useState(CONFIG.autoSubmitSeconds);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [inputMode, setInputMode] = useState('scan');

  const timerRef = useRef(null);
  const intervalRef = useRef(null);
  const resetRef = useRef(null);

  useEffect(() => {
    setRecords(loadSavedRecords());
  }, []);

  useEffect(() => {
    saveRecords(records);
  }, [records]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  useEffect(() => {
    const refreshTimer = setInterval(() => {
      if (status === 'ready' && !manualOpen && !submitting) {
        window.location.reload();
      }
    }, CONFIG.idleRefreshMs);

    return () => clearInterval(refreshTimer);
  }, [status, manualOpen, submitting]);

  function clearTimers() {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (resetRef.current) clearTimeout(resetRef.current);
    timerRef.current = null;
    intervalRef.current = null;
    resetRef.current = null;
  }

  function scheduleReset(ms) {
    if (resetRef.current) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => {
      reset();
    }, ms);
  }

  function reset() {
    clearTimers();
    setCode('');
    setShipmentId('');
    setBuyerName('');
    setManualCode('');
    setManualShipmentId('');
    setManualFirstName('');
    setManualLastName('');
    setManualOpen(false);
    setStatus('ready');
    setCountdown(CONFIG.autoSubmitSeconds);
    setMessage('');
    setSubmitting(false);
    setInputMode('scan');
  }

  function findDuplicate(finalCode, finalShipmentId) {
    const shipmentKey = String(finalShipmentId || '').trim();
    const pickupKey = String(finalCode || '').trim();

    return records.find((record) => {
      const existingShipment = String(record.shipmentId || '').trim();
      const existingPickup = String(record.pickupCode || '').trim();

      if (shipmentKey && existingShipment && existingShipment === shipmentKey) {
        return true;
      }

      if (!shipmentKey && pickupKey && existingPickup === pickupKey) {
        return true;
      }

      return false;
    });
  }

  async function submit(finalCode, mode = 'scan', finalShipmentId = '', finalBuyerName = '') {
    clearTimers();

    const duplicate = findDuplicate(finalCode, finalShipmentId);
    if (duplicate) {
      playDuplicateBeep();
      setStatus('duplicate');
      setSubmitting(false);
      setMessage(
        `This pickup was already logged${duplicate.timestamp ? ` on ${duplicate.timestamp}` : ''}.`
      );
      setCode(finalCode);
      setShipmentId(finalShipmentId || '');
      setBuyerName(duplicate.buyerName || finalBuyerName || '');
      scheduleReset(CONFIG.warningResetMs);
      return;
    }

    setSubmitting(true);
    setStatus('submitting');
    setMessage('');

    const record = {
      timestamp: now(),
      day: today(),
      pickupCode: finalCode,
      shipmentId: finalShipmentId || '',
      buyerName: finalBuyerName || '',
      orderId: '',
      station: 'Kiosk',
      operator: 'Kiosk',
      status: 'picked_up',
      whatnotConfirmed: 'manual_step_required',
      note: mode === 'manual' ? 'Manual entry' : 'QR scan',
    };

    const result = await postToSheet(CONFIG.webhook, record);

    if (result.ok) {
      setRecords((prev) => [record, ...prev]);
      playSuccessBeep();
      setStatus('done');
      setMessage('Pickup logged successfully.');
      scheduleReset(CONFIG.successResetMs);
    } else {
      setStatus('error');
      setMessage(result.message || 'Failed to submit. Please see staff.');
      setSubmitting(false);
      scheduleReset(CONFIG.warningResetMs);
    }
  }

  function startCountdown(finalCode, mode = 'scan', finalShipmentId = '', finalBuyerName = '') {
    if (!finalCode || submitting) return;

    const duplicate = findDuplicate(finalCode, finalShipmentId);
    if (duplicate) {
      playDuplicateBeep();
      setCode(finalCode);
      setShipmentId(finalShipmentId || '');
      setBuyerName(duplicate.buyerName || finalBuyerName || '');
      setInputMode(mode);
      setStatus('duplicate');
      setMessage(
        `This pickup was already logged${duplicate.timestamp ? ` on ${duplicate.timestamp}` : ''}.`
      );
      scheduleReset(CONFIG.warningResetMs);
      return;
    }

    playScanBeep();
    clearTimers();
    setCode(finalCode);
    setShipmentId(finalShipmentId || '');
    setBuyerName(finalBuyerName || '');
    setInputMode(mode);
    setStatus('detected');

    let remaining = CONFIG.autoSubmitSeconds;
    setCountdown(remaining);

    intervalRef.current = setInterval(() => {
      remaining -= 1;
      setCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }, 1000);

    timerRef.current = setTimeout(() => {
      submit(finalCode, mode, finalShipmentId, finalBuyerName);
    }, CONFIG.autoSubmitSeconds * 1000);
  }

  function handleScan(raw) {
    const extracted = extractScanData(raw);
    startCountdown(extracted.pickupCode, 'scan', extracted.shipmentId, '');
  }

  function handleManualStart() {
    const finalCode = manualCode.trim();
    const finalShipmentId = manualShipmentId.trim();
    const finalBuyerName = `${manualFirstName.trim()} ${manualLastName.trim()}`.trim();
    startCountdown(finalCode, 'manual', finalShipmentId, finalBuyerName);
  }

  function handleManualSubmitNow() {
    const finalCode = manualCode.trim();
    const finalShipmentId = manualShipmentId.trim();
    const finalBuyerName = `${manualFirstName.trim()} ${manualLastName.trim()}`.trim();

    if (!finalCode || !manualFirstName.trim() || !manualLastName.trim() || submitting) return;

    setCode(finalCode);
    setShipmentId(finalShipmentId);
    setBuyerName(finalBuyerName);
    setInputMode('manual');
    submit(finalCode, 'manual', finalShipmentId, finalBuyerName);
  }

  function handleClearManual() {
    clearTimers();
    setManualCode('');
    setManualShipmentId('');
    setManualFirstName('');
    setManualLastName('');
    if ((status === 'detected' || status === 'duplicate') && inputMode === 'manual') {
      setCode('');
      setShipmentId('');
      setBuyerName('');
      setStatus('ready');
      setCountdown(CONFIG.autoSubmitSeconds);
      setMessage('');
    }
  }

  useEffect(() => {
    return () => clearTimers();
  }, []);

  const isIdle = status === 'ready';

  return (
    <div className="flex min-h-screen items-center justify-center overflow-hidden bg-[#fffaf5] px-4 py-4 md:py-5">
      <Overlay
        status={status}
        code={code}
        shipmentId={shipmentId}
        buyerName={buyerName}
        message={message}
      />

      <div className="w-full max-w-2xl">
        <div className="mb-4 flex justify-center">
          <img
            src="https://farnorthfinds.com/cdn/shop/files/far_north_finds_logo_1024x1024_cropped_a4b64b46-70f5-4470-bd88-895dcd4e9c72.png?v=1748656895&width=3840"
            alt="Far North Finds"
            className="h-auto w-[220px] md:w-[320px]"
          />
        </div>

        <div className="rounded-3xl border border-neutral-200 bg-white p-4 shadow-[0_20px_60px_rgba(0,0,0,0.08)] md:p-6">
          <div className="mb-4 text-center">
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
              Scan Your Pickup QR Code
            </h1>
            <p className="mt-2 text-sm text-neutral-600 md:text-base">
              Hold your Whatnot pickup code inside the camera frame.
            </p>
          </div>

          <div className="relative">
            <Scanner onScan={handleScan} locked={status !== 'ready'} pulse={isIdle} />

            {isIdle && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="rounded-2xl bg-black/35 px-6 py-4 text-center text-white backdrop-blur-[1px]">
                  <div className="flex justify-center">
                    <Camera className="h-8 w-8" />
                  </div>
                  <div className="mt-2 text-lg font-semibold md:text-xl">Ready to Scan</div>
                  <div className="mt-1 text-sm text-white/90">
                    Present your QR code to continue
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="mt-4 text-center">
            {!manualOpen ? (
              <button
                onClick={() => setManualOpen(true)}
                className="inline-flex items-center gap-2 rounded-full border border-neutral-300 bg-white px-5 py-2.5 text-sm font-medium text-neutral-800 transition hover:bg-neutral-50"
              >
                <Keyboard className="h-4 w-4" />
                Enter code manually
              </button>
            ) : (
              <div className="rounded-3xl border border-[#f3e6d6] bg-[#fffaf5] p-4 md:p-5">
                <div className="mb-3 flex items-center justify-center gap-2 text-sm font-medium text-neutral-700">
                  <Keyboard className="h-4 w-4" />
                  Manual code entry
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <input
                    type="text"
                    value={manualFirstName}
                    onChange={(e) => setManualFirstName(e.target.value)}
                    placeholder="First name"
                    className="h-12 rounded-2xl border border-neutral-300 bg-white px-4 text-base outline-none transition focus:border-neutral-500"
                  />
                  <input
                    type="text"
                    value={manualLastName}
                    onChange={(e) => setManualLastName(e.target.value)}
                    placeholder="Last name"
                    className="h-12 rounded-2xl border border-neutral-300 bg-white px-4 text-base outline-none transition focus:border-neutral-500"
                  />
                </div>

                <div className="mt-3 flex flex-col gap-3">
                  <input
                    type="text"
                    value={manualCode}
                    onChange={(e) => setManualCode(e.target.value)}
                    placeholder="Enter pickup code"
                    className="h-12 rounded-2xl border border-neutral-300 bg-white px-4 text-base outline-none transition focus:border-neutral-500"
                  />
                  <input
                    type="text"
                    value={manualShipmentId}
                    onChange={(e) => setManualShipmentId(e.target.value)}
                    placeholder="Enter shipment ID (optional)"
                    className="h-12 rounded-2xl border border-neutral-300 bg-white px-4 text-base outline-none transition focus:border-neutral-500"
                  />
                </div>

                <div className="mt-3 flex flex-col gap-3 md:flex-row md:justify-center">
                  <button
                    onClick={handleManualStart}
                    disabled={
                      !manualCode.trim() ||
                      !manualFirstName.trim() ||
                      !manualLastName.trim() ||
                      submitting
                    }
                    className="h-12 rounded-2xl bg-neutral-900 px-5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Start {CONFIG.autoSubmitSeconds}s submit
                  </button>
                  <button
                    onClick={handleManualSubmitNow}
                    disabled={
                      !manualCode.trim() ||
                      !manualFirstName.trim() ||
                      !manualLastName.trim() ||
                      submitting
                    }
                    className="h-12 rounded-2xl border border-neutral-300 bg-white px-5 text-sm font-medium text-neutral-900 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Submit now
                  </button>
                </div>

                <div className="mt-3 flex justify-center gap-3">
                  <button
                    onClick={handleClearManual}
                    disabled={submitting}
                    className="rounded-full border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => {
                      handleClearManual();
                      setManualOpen(false);
                    }}
                    disabled={submitting}
                    className="rounded-full border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Close manual entry
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="mt-4 text-center">
            {status === 'ready' && (
              <div className="rounded-3xl border border-[#f3e6d6] bg-[#fffaf5] p-4">
                <div className="text-sm uppercase tracking-[0.2em] text-amber-700">Ready</div>
                <div className="mt-2 text-xl font-medium">Waiting for a QR code</div>
                <div className="mt-2 text-sm text-neutral-600">
                  Auto-refreshes every 5 minutes while idle
                </div>
              </div>
            )}

            {status === 'detected' && (
              <div className="rounded-3xl border border-[#f3e6d6] bg-[#fffaf5] p-4">
                <div className="mt-2 text-sm uppercase tracking-[0.2em] text-amber-700">
                  {inputMode === 'manual' ? 'Manual code ready' : 'Code detected'}
                </div>
                <div className="mt-3 break-all text-lg font-semibold md:text-xl">{code}</div>
                {shipmentId ? (
                  <div className="mt-2 break-all text-sm text-neutral-600 md:text-base">
                    Shipment ID: {shipmentId}
                  </div>
                ) : null}
                {buyerName ? (
                  <div className="mt-2 break-all text-sm text-neutral-600 md:text-base">
                    Buyer: {buyerName}
                  </div>
                ) : null}
                <div className="mt-4 flex justify-center">
                  <div className="text-6xl font-bold text-amber-700">{countdown}</div>
                </div>
                <div className="mt-2 text-base text-neutral-700">
                  Auto-submitting in <span className="font-semibold">{countdown}</span>s
                </div>
              </div>
            )}

            {status === 'submitting' && (
              <div className="rounded-3xl border border-[#f3e6d6] bg-[#fffaf5] p-4">
                <div className="text-sm uppercase tracking-[0.2em] text-amber-700">
                  Submitting
                </div>
                <div className="mt-3 text-xl font-semibold">Please wait…</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
