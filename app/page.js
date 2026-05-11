"use client";

import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";

const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbx7BVKxH-dkekrd8-BZvDI6A62zWEh-u8mhrjlXUfLTDD3fMQOowjpbLdAQemCL65b__Q/exec";

const LOGO_URL =
  "https://farnorthfinds.com/cdn/shop/files/far_north_finds_logo_1024x1024_cropped_a4b64b46-70f5-4470-bd88-895dcd4e9c72.png?v=174865";

export default function Home() {
  const scannerRef = useRef(null);
  const scannerRunningRef = useRef(false);
  const restartingRef = useRef(false);
  const processingRef = useRef(false);
  const watchdogRef = useRef(null);
  const idleRefreshRef = useRef(null);
  const idleTimerRef = useRef(null);

  const [scannerReady, setScannerReady] = useState(false);
  const [manualFirstName, setManualFirstName] = useState("");
  const [manualLastName, setManualLastName] = useState("");
  const [result, setResult] = useState(null);
  const [idle, setIdle] = useState(false);
  const [cameraError, setCameraError] = useState("");

  useEffect(() => {
    startScanner();
    startWatchdog();
    startIdleRefresh();
    resetIdleTimer();

    window.addEventListener("focus", handleReturnToApp);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("touchstart", resetIdleTimer);
    window.addEventListener("mousemove", resetIdleTimer);
    window.addEventListener("keydown", resetIdleTimer);

    return () => {
      stopScannerCompletely();

      if (watchdogRef.current) clearInterval(watchdogRef.current);
      if (idleRefreshRef.current) clearInterval(idleRefreshRef.current);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);

      window.removeEventListener("focus", handleReturnToApp);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("touchstart", resetIdleTimer);
      window.removeEventListener("mousemove", resetIdleTimer);
      window.removeEventListener("keydown", resetIdleTimer);
    };
  }, []);

  function resetIdleTimer() {
    setIdle(false);

    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);

    idleTimerRef.current = setTimeout(() => {
      if (!processingRef.current && !result) {
        setIdle(true);
      }
    }, 45000);
  }

  function handleReturnToApp() {
    setTimeout(() => {
      restartScanner();
    }, 500);
  }

  function handleVisibilityChange() {
    if (!document.hidden) {
      setTimeout(() => {
        restartScanner();
      }, 500);
    }
  }

  function startWatchdog() {
    watchdogRef.current = setInterval(() => {
      const video = document.querySelector("video");

      const cameraLooksDead =
        !video || video.readyState < 2 || video.paused || video.ended;

      if (cameraLooksDead && scannerRunningRef.current && !processingRef.current) {
        console.warn("Camera watchdog detected a problem. Restarting scanner.");
        restartScanner();
      }
    }, 10000);
  }

  function startIdleRefresh() {
    idleRefreshRef.current = setInterval(() => {
      if (processingRef.current || result) return;

      if (scannerRunningRef.current) {
        console.log("Refreshing camera stream instead of page reload.");
        restartScanner();
      } else {
        window.location.reload();
      }
    }, 5 * 60 * 1000);
  }

  async function startScanner() {
    if (scannerRunningRef.current || restartingRef.current) return;

    try {
      setCameraError("");

      const scanner = new Html5Qrcode("qr-reader");
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: "environment" },
        {
          fps: 10,
          qrbox: { width: 300, height: 300 },
          aspectRatio: 1.333,
          disableFlip: false,
        },
        async (decodedText) => {
          await handleScan(decodedText);
        },
        () => {}
      );

      scannerRunningRef.current = true;
      setScannerReady(true);
    } catch (err) {
      console.error("Camera start failed:", err);
      setCameraError("Camera failed to start. Tap Restart Camera.");
      scannerRunningRef.current = false;
      setScannerReady(false);
    }
  }

  async function stopScannerCompletely() {
    try {
      if (scannerRef.current && scannerRunningRef.current) {
        await scannerRef.current.stop();
      }
    } catch (err) {
      console.warn("Scanner stop warning:", err);
    }

    try {
      if (scannerRef.current) {
        await scannerRef.current.clear();
      }
    } catch (err) {
      console.warn("Scanner clear warning:", err);
    }

    scannerRunningRef.current = false;
    setScannerReady(false);

    try {
      const videos = document.querySelectorAll("video");

      videos.forEach((video) => {
        if (video.srcObject) {
          video.srcObject.getTracks().forEach((track) => track.stop());
          video.srcObject = null;
        }
      });
    } catch (err) {
      console.warn("Video cleanup warning:", err);
    }
  }

  async function restartScanner() {
    if (restartingRef.current) return;

    restartingRef.current = true;

    try {
      await stopScannerCompletely();
      await new Promise((resolve) => setTimeout(resolve, 600));
      await startScanner();
    } catch (err) {
      console.error("Camera restart failed:", err);
      setCameraError("Camera restart failed. Tap Restart Camera.");
    } finally {
      restartingRef.current = false;
    }
  }

  async function handleScan(decodedText) {
    if (processingRef.current) return;

    processingRef.current = true;
    resetIdleTimer();

    try {
      await stopScannerCompletely();

      const parsed = parseWhatnotQr(decodedText);

      if (!parsed.shipmentId && !parsed.pickupCode) {
        showResult("error", "Invalid QR Code", "This does not appear to be a valid Whatnot pickup QR.");
        return;
      }

      const response = await submitPickup({
        source: "qr",
        shipmentId: parsed.shipmentId,
        pickupCode: parsed.pickupCode,
        buyerName: "",
        rawQr: decodedText,
      });

      if (response.status === "duplicate") {
        showResult("duplicate", "Already Picked Up", response.message || "This order was already marked picked up.");
      } else if (response.status === "success") {
        showResult("success", "Pickup Confirmed", response.message || "This order has been marked picked up.");
      } else {
        showResult("error", "Pickup Error", response.message || "Unable to complete pickup.");
      }
    } catch (err) {
      console.error(err);
      showResult("error", "Error", "Something went wrong while processing this pickup.");
    }
  }

  async function handleManualSubmit(e) {
    e.preventDefault();

    if (processingRef.current) return;

    const firstName = manualFirstName.trim();
    const lastName = manualLastName.trim();

    if (!firstName || !lastName) {
      showResult("error", "Missing Name", "Please enter both first and last name.");
      return;
    }

    processingRef.current = true;
    resetIdleTimer();

    try {
      await stopScannerCompletely();

      const buyerName = `${firstName} ${lastName}`;

      const response = await submitPickup({
        source: "manual",
        shipmentId: "",
        pickupCode: "",
        buyerName,
        rawQr: "",
      });

      if (response.status === "duplicate") {
        showResult("duplicate", "Already Picked Up", response.message || "This customer may already be picked up.");
      } else if (response.status === "success") {
        showResult("success", "Manual Pickup Confirmed", response.message || `${buyerName} has been marked picked up.`);
        setManualFirstName("");
        setManualLastName("");
      } else {
        showResult("error", "Pickup Error", response.message || "Unable to complete manual pickup.");
      }
    } catch (err) {
      console.error(err);
      showResult("error", "Error", "Something went wrong while submitting manual pickup.");
    }
  }

  async function submitPickup(payload) {
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      mode: "cors",
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();

    try {
      return JSON.parse(text);
    } catch {
      return {
        status: response.ok ? "success" : "error",
        message: text,
      };
    }
  }

  function parseWhatnotQr(text) {
    let shipmentId = "";
    let pickupCode = "";

    try {
      const url = new URL(text);

      shipmentId =
        url.searchParams.get("shipmentId") ||
        url.searchParams.get("shipment_id") ||
        "";

      pickupCode =
        url.searchParams.get("pickupCode") ||
        url.searchParams.get("pickup_code") ||
        url.searchParams.get("code") ||
        "";
    } catch {
      const shipmentMatch = text.match(/shipmentId[=:\/\s]+([A-Za-z0-9_-]+)/i);
      const pickupMatch = text.match(/pickupCode[=:\/\s]+([A-Za-z0-9_-]+)/i);

      shipmentId = shipmentMatch?.[1] || "";
      pickupCode = pickupMatch?.[1] || "";
    }

    return { shipmentId, pickupCode };
  }

  function showResult(type, title, message) {
    setResult({ type, title, message });

    const delay = type === "success" ? 2500 : 5000;

    setTimeout(async () => {
      setResult(null);
      processingRef.current = false;
      await restartScanner();
      resetIdleTimer();
    }, delay);
  }

  const resultClass =
    result?.type === "success"
      ? "bg-green-600"
      : result?.type === "duplicate"
      ? "bg-yellow-500"
      : "bg-red-600";

  return (
    <main className="min-h-screen bg-neutral-950 text-white flex flex-col items-center p-6">
      <header className="w-full max-w-5xl flex flex-col items-center mb-6">
        <img src={LOGO_URL} alt="Far North Finds" className="w-28 h-28 object-contain mb-3" />
        <h1 className="text-4xl font-bold text-center">Pickup Kiosk</h1>
        <p className="text-neutral-400 text-lg mt-2">Scan Whatnot pickup QR code</p>
      </header>

      {idle && !result && (
        <div className="fixed inset-0 z-30 bg-neutral-950 flex flex-col items-center justify-center text-center p-8">
          <img src={LOGO_URL} alt="Far North Finds" className="w-40 h-40 object-contain mb-6" />
          <h2 className="text-5xl font-bold mb-4">Ready for Pickup</h2>
          <p className="text-2xl text-neutral-300">Tap the screen to begin</p>
        </div>
      )}

      {result && (
        <div
          data-result-popup="true"
          className={`fixed inset-0 z-40 ${resultClass} flex flex-col items-center justify-center text-center p-8`}
        >
          <h2 className="text-7xl font-black mb-6">{result.title}</h2>
          <p className="text-3xl max-w-3xl">{result.message}</p>
        </div>
      )}

      <section className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-neutral-900 rounded-3xl p-6 shadow-xl border border-neutral-800">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold">Camera Scanner</h2>
            <span className={scannerReady ? "text-green-400" : "text-yellow-400"}>
              {scannerReady ? "Camera Active" : "Starting"}
            </span>
          </div>

          <div className="rounded-2xl overflow-hidden bg-black border border-neutral-700">
            <div id="qr-reader" className="w-full min-h-[360px]" />
          </div>

          {cameraError && (
            <p className="mt-4 text-red-400 text-lg">{cameraError}</p>
          )}

          <button
            onClick={restartScanner}
            className="mt-5 w-full bg-white text-black text-xl font-bold py-4 rounded-2xl active:scale-95"
          >
            Restart Camera
          </button>
        </div>

        <div className="bg-neutral-900 rounded-3xl p-6 shadow-xl border border-neutral-800">
          <h2 className="text-2xl font-bold mb-4">Manual Entry</h2>

          <form onSubmit={handleManualSubmit} className="space-y-4">
            <input
              value={manualFirstName}
              onChange={(e) => setManualFirstName(e.target.value)}
              placeholder="First Name"
              className="w-full text-2xl p-5 rounded-2xl bg-neutral-800 border border-neutral-700 outline-none"
              autoComplete="off"
            />

            <input
              value={manualLastName}
              onChange={(e) => setManualLastName(e.target.value)}
              placeholder="Last Name"
              className="w-full text-2xl p-5 rounded-2xl bg-neutral-800 border border-neutral-700 outline-none"
              autoComplete="off"
            />

            <button
              type="submit"
              className="w-full bg-lime-400 text-black text-2xl font-black py-5 rounded-2xl active:scale-95"
            >
              Submit Manual Pickup
            </button>
          </form>

          <div className="mt-8 text-neutral-400 text-base leading-relaxed">
            <p>Manual entry writes the buyer name using first name and last name.</p>
            <p className="mt-2">QR scans check shipment ID first, then pickup code.</p>
          </div>
        </div>
      </section>
    </main>
  );
}