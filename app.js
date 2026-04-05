(function () {
  "use strict";

  const API = "https://norminternet-vapitow854.amvera.io";

  const preview = document.getElementById("preview");
  const playback = document.getElementById("playback");
  const timerEl = document.getElementById("timer");
  const recordRing = document.getElementById("recordRing");
  const btnRecord = document.getElementById("btnRecord");
  const btnWatch = document.getElementById("btnWatch");
  const statusEl = document.getElementById("status");
  const creditsLabel = document.getElementById("creditsLabel");
  const captchaMount = document.getElementById("captchaMount");

  const STORAGE_KEY = "random_circle_session";

  let sessionId = localStorage.getItem(STORAGE_KEY);
  let balance = 0;
  let stream = null;
  let recorder = null;
  let chunks = [];
  let tickTimer = null;
  let recordStartedAt = 0;
  let smartCaptchaConfig = { enabled: false, siteKey: "" };
  let captchaWidgetId = null;
  let captchaReadyPromise = null;
  let captchaToken = "";
  let captchaTokenAt = 0;
  let captchaPendingResolve = null;

  const MAX_MS = 60_000;
  const CAPTCHA_TOKEN_MAX_AGE_MS = 4 * 60 * 1000;

  function setStatus(text, isError) {
    statusEl.textContent = text || "";
    statusEl.classList.toggle("error", !!isError);
  }

  function formatMs(ms) {
    const s = Math.min(MAX_MS, Math.max(0, ms)) / 1000;
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return m + ":" + String(r).padStart(2, "0");
  }

  function updateUi() {
    creditsLabel.textContent = "Просмотры: " + balance;
    btnWatch.disabled = balance < 1;
  }

  function pickMimeType() {
    const opts = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ];
    for (const t of opts) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }

  function makeCodeError(code) {
    const e = new Error(code);
    e.code = code;
    return e;
  }

  function setCaptchaToken(token) {
    captchaToken = token || "";
    captchaTokenAt = captchaToken ? Date.now() : 0;
  }

  function hasFreshCaptchaToken() {
    if (!captchaToken) return false;
    return Date.now() - captchaTokenAt < CAPTCHA_TOKEN_MAX_AGE_MS;
  }

  async function api(path, options) {
    const headers = Object.assign(
      { "Content-Type": "application/json" },
      options && options.headers
    );
    if (sessionId) headers["X-Session-Id"] = sessionId;
    const res = await fetch(API + path, Object.assign({}, options, { headers }));
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText || "request_failed");
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  async function ensureSession() {
    if (sessionId) {
      try {
        const me = await api("/api/credits", { method: "GET" });
        balance = me.balance;
        updateUi();
        return;
      } catch (e) {
        if (e.status !== 401) throw e;
        sessionId = null;
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    const created = await api("/api/session", { method: "POST" });
    sessionId = created.sessionId;
    localStorage.setItem(STORAGE_KEY, sessionId);
    balance = 0;
    updateUi();
  }

  async function loadPublicConfig() {
    try {
      const cfg = await api("/api/config", { method: "GET" });
      const sc = cfg && cfg.smartCaptcha;
      smartCaptchaConfig = {
        enabled: !!(sc && sc.enabled && sc.siteKey),
        siteKey: (sc && sc.siteKey) || "",
      };
    } catch (_) {
      smartCaptchaConfig = { enabled: false, siteKey: "" };
    }
  }

  async function ensureCaptchaReady() {
    if (!smartCaptchaConfig.enabled) return;
    if (captchaWidgetId !== null && window.smartCaptcha) return;
    if (!captchaMount) throw makeCodeError("captcha_unavailable");

    if (!captchaReadyPromise) {
      captchaReadyPromise = new Promise((resolve, reject) => {
        if (window.smartCaptcha) return resolve();
        window.__smartCaptchaOnload = () => resolve();
        const script = document.createElement("script");
        script.src =
          "https://smartcaptcha.cloud.yandex.ru/captcha.js?render=onload&onload=__smartCaptchaOnload";
        script.async = true;
        script.defer = true;
        script.onerror = () => reject(makeCodeError("captcha_unavailable"));
        document.head.appendChild(script);
      }).catch((err) => {
        captchaReadyPromise = null;
        throw err;
      });
    }

    await captchaReadyPromise;
    if (captchaWidgetId !== null) return;
    if (!window.smartCaptcha || typeof window.smartCaptcha.render !== "function") {
      throw makeCodeError("captcha_unavailable");
    }

    captchaWidgetId = window.smartCaptcha.render(captchaMount, {
      sitekey: smartCaptchaConfig.siteKey,
      invisible: true,
      callback: (token) => {
        setCaptchaToken(token);
        if (captchaPendingResolve) {
          const resolve = captchaPendingResolve;
          captchaPendingResolve = null;
          resolve(token);
        }
      },
    });
  }

  function resetCaptcha() {
    setCaptchaToken("");
    if (captchaWidgetId === null || !window.smartCaptcha) return;
    if (typeof window.smartCaptcha.reset !== "function") return;
    try {
      window.smartCaptcha.reset(captchaWidgetId);
    } catch (_) {
      /* ignore reset errors */
    }
  }

  async function getCaptchaTokenForUpload() {
    if (!smartCaptchaConfig.enabled) return "";
    if (hasFreshCaptchaToken()) return captchaToken;

    await ensureCaptchaReady();
    setStatus("Подтвердите, что вы не робот…");

    return new Promise((resolve, reject) => {
      if (!window.smartCaptcha || captchaWidgetId === null) {
        reject(makeCodeError("captcha_unavailable"));
        return;
      }

      const timeout = setTimeout(() => {
        captchaPendingResolve = null;
        reject(makeCodeError("captcha_timeout"));
      }, 60_000);

      captchaPendingResolve = (token) => {
        clearTimeout(timeout);
        resolve(token || "");
      };

      try {
        window.smartCaptcha.execute(captchaWidgetId);
      } catch (_) {
        clearTimeout(timeout);
        captchaPendingResolve = null;
        reject(makeCodeError("captcha_unavailable"));
      }
    });
  }

  function showPreviewMode() {
    preview.classList.remove("hidden");
    playback.classList.add("hidden");
    playback.removeAttribute("src");
    playback.load();
  }

  async function startCamera() {
    if (stream) return;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: "user",
        width: { ideal: 720 },
        height: { ideal: 720 },
      },
    });
    preview.srcObject = stream;
    showPreviewMode();
  }

  function stopTracks() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      preview.srcObject = null;
    }
  }

  function stopTick() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    timerEl.classList.remove("visible");
    recordRing.classList.remove("active");
  }

  function startTick() {
    recordStartedAt = performance.now();
    timerEl.classList.add("visible");
    recordRing.classList.add("active");
    tickTimer = setInterval(() => {
      const elapsed = performance.now() - recordStartedAt;
      timerEl.textContent = formatMs(elapsed);
      if (elapsed >= MAX_MS) stopRecording(true);
    }, 100);
  }

  function stopRecording(auto) {
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
    stopTick();
    btnRecord.classList.remove("recording");
    btnRecord.disabled = true;
    if (auto) setStatus("Лимит 60 секунд.");
  }

  async function uploadBlob(blob, mimeType, durationMs) {
    const captchaToken = await getCaptchaTokenForUpload();
    setStatus("Отправка…");
    let presign = null;
    try {
      presign = await api("/api/videos/presign-upload", {
        method: "POST",
        body: JSON.stringify({
          mimeType,
          durationMs: Math.round(durationMs),
          captchaToken,
        }),
      });
    } finally {
      resetCaptcha();
    }

    const putRes = await fetch(presign.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": presign.mimeType || mimeType },
      body: blob,
    });
    if (!putRes.ok) throw new Error("upload_failed");

    const done = await api("/api/videos/complete", {
      method: "POST",
      body: JSON.stringify({ videoId: presign.videoId }),
    });
    balance = done.balance;
    updateUi();
    setStatus("Кружок отправлен.");
  }

  btnRecord.addEventListener("click", async () => {
    if (recorder && recorder.state === "recording") {
      stopRecording(false);
      return;
    }

    try {
      await ensureSession(); //
      await startCamera(); //
    } catch (e) {
      setStatus("Нужен доступ к камере и микрофону.", true); //
      return;
    }

    const mimeType = pickMimeType(); //
    if (!mimeType) {
      setStatus("Браузер не поддерживает запись видео.", true); //
      return;
    }

    chunks = []; //
    try {
      // ОГРОНИЧЕНИЕ БИТРЕЙТА: 1000000 bps (1 Mbps) для видео и 64kbps для звука
      recorder = new MediaRecorder(stream, { 
        mimeType,
        videoBitsPerSecond: 1000000, 
        audioBitsPerSecond: 64000
      });
    } catch (e) {
      setStatus("Не удалось начать запись.", true); //
      return;
    }

    const startedAt = performance.now(); //
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) chunks.push(ev.data); //
    };
    recorder.onerror = () => setStatus("Ошибка записи.", true); //
    recorder.onstop = async () => {
      const finalMime = recorder.mimeType || mimeType; //
      btnRecord.disabled = false; //
      const durationMs = performance.now() - startedAt; //
      const blob = new Blob(chunks, { type: finalMime }); //
      chunks = []; //
      recorder = null; //

      if (durationMs < 350) {
        setStatus("Слишком коротко — удерживайте для записи."); //
        return;
      }

      try {
        await ensureSession(); //
        await uploadBlob(blob, finalMime, durationMs); //
      } catch (e) {
        const map = {
          no_credits: "Нет кредитов.",
          invalid_mime: "Формат видео не поддерживается.",
          invalid_duration: "Кружок слишком короткий. Минимум 1 секунда.",
          object_missing: "Файл не дошёл до хранилища.",
          captcha_required: "Подтвердите, что вы не робот.",
          captcha_failed: "Проверка капчи не пройдена. Попробуйте ещё раз.",
          captcha_unavailable: "Капча недоступна. Попробуйте чуть позже.",
          captcha_timeout: "Время проверки капчи истекло. Повторите отправку.",
        };
        const code = (e.body && e.body.error) || e.code; //
        setStatus(map[code] || "Не удалось отправить.", true); //
      }
    };

    recorder.start(200); //
    btnRecord.classList.add("recording"); //
    startTick(); //
    setStatus("Идёт запись… Отпустите кнопку, чтобы отправить."); //
  });

  btnWatch.addEventListener("click", async () => {
    try {
      await ensureSession();
    } catch (e) {
      setStatus("Нет сессии.", true);
      return;
    }
    setStatus("Ищем кружок…");
    try {
      const data = await api("/api/videos/random", { method: "POST", body: "{}" });
      balance = data.balance;
      updateUi();
      preview.classList.add("hidden");
      playback.classList.remove("hidden");
      playback.src = API + data.url;
      await playback.play().catch(() => {});
      setStatus("Просмотр");
    } catch (e) {
      if (e.body && e.body.error === "no_credits") {
        setStatus("Сначала отправьте свой кружок.", true);
      } else if (e.body && e.body.error === "no_videos") {
        setStatus("Пока нет чужих кружков — загляните позже.", true);
      } else {
        setStatus("Не удалось получить кружок.", true);
      }
    }
  });

  playback.addEventListener("click", () => {
    if (playback.paused) playback.play().catch(() => {});
    else playback.pause();
  });

  playback.addEventListener("ended", () => {
    showPreviewMode();
    if (stream) preview.srcObject = stream;
    setStatus("");
  });

  window.addEventListener("beforeunload", () => stopTracks());

  loadPublicConfig()
    .then(() => {
      if (smartCaptchaConfig.enabled) {
        ensureCaptchaReady().catch(() => {});
      }
      return ensureSession();
    })
    .then(() => startCamera())
    .catch(() => {
      setStatus("Откройте через HTTPS или localhost и разрешите камеру.", true);
    });
})();
