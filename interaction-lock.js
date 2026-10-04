(function installInteractionLock() {
  const CONTROLLER_KEY = "__authorizedStreamInspectorInteractionLock";
  const HOST_ID = "authorized-stream-inspector-interaction-lock";
  const LEASE_MS = 12_000;
  const RENEW_INTERVAL_MS = 4_000;
  const blockedEvents = [
    "pointerdown", "pointerup", "pointermove", "pointerover", "pointerout",
    "pointerenter", "pointerleave", "pointercancel", "mousedown", "mouseup",
    "mousemove", "mouseover", "mouseout", "mouseenter", "mouseleave", "click",
    "dblclick", "contextmenu", "wheel", "dragstart", "dragover", "drop",
    "touchstart", "touchmove", "touchend", "touchcancel"
  ];

  const existing = globalThis[CONTROLLER_KEY];
  if (existing?.activate) {
    existing.activate();
    return;
  }

  let host = null;
  let shield = null;
  let leaseTimer = null;
  let renewTimer = null;
  const registeredTargets = [];

  function blockEvent(event) {
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
  }

  function addListeners(target) {
    if (!target?.addEventListener) return;
    for (const eventName of blockedEvents) {
      target.addEventListener(eventName, blockEvent, { capture: true, passive: false });
    }
    registeredTargets.push(target);
  }

  function removeListeners() {
    for (const target of registeredTargets.splice(0)) {
      for (const eventName of blockedEvents) {
        target.removeEventListener?.(eventName, blockEvent, { capture: true });
      }
    }
  }

  function clearLease() {
    if (leaseTimer) clearTimeout(leaseTimer);
    leaseTimer = null;
  }

  function renewLease() {
    if (!host || !shield) return;
    clearLease();
    host.style.pointerEvents = "auto";
    host.style.cursor = "none";
    shield.style.pointerEvents = "auto";
    shield.style.cursor = "none";
    shield.style.animation = "none";
    void shield.offsetWidth;
    shield.style.animation = `asi-interaction-lock-lease ${LEASE_MS}ms steps(1, end) forwards`;
    leaseTimer = setTimeout(() => {
      host?.style.setProperty("pointer-events", "none");
      host?.style.setProperty("cursor", "auto");
      shield?.style.setProperty("pointer-events", "none");
      shield?.style.setProperty("cursor", "auto");
    }, LEASE_MS);
  }

  function removeNodes() {
    removeListeners();
    clearLease();
    if (renewTimer) clearInterval(renewTimer);
    renewTimer = null;
    host?.remove?.();
    host = null;
    shield = null;
  }

  const controller = {
    activate() {
      removeNodes();
      host = document.createElement("div");
      host.id = HOST_ID;
      host.setAttribute("aria-hidden", "true");
      host.setAttribute("role", "presentation");
      host.style.cssText = [
        "all: initial",
        "display: block",
        "position: fixed",
        "inset: 0",
        "width: 100vw",
        "height: 100vh",
        "z-index: 2147483647",
        "pointer-events: auto",
        "background: transparent",
        "cursor: none"
      ].join(";");
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        @keyframes asi-interaction-lock-lease {
          0%, 99% { pointer-events: auto; cursor: none; }
          100% { pointer-events: none; cursor: auto; }
        }
        #shield {
          position: fixed;
          inset: 0;
          width: 100vw;
          height: 100vh;
          background: transparent;
          cursor: none;
          pointer-events: auto;
        }
      `;
      shadow.appendChild(style);
      shield = document.createElement("div");
      shield.id = "shield";
      shield.setAttribute("aria-hidden", "true");
      shadow.appendChild(shield);
      document.documentElement.appendChild(host);
      addListeners(window);
      addListeners(document);
      addListeners(shield);
      renewLease();
      renewTimer = setInterval(renewLease, RENEW_INTERVAL_MS);
      return { active: true };
    },

    deactivate() {
      removeNodes();
      delete globalThis[CONTROLLER_KEY];
      return { active: false };
    },

    isActive() {
      return Boolean(host && shield);
    }
  };

  globalThis[CONTROLLER_KEY] = controller;
  controller.activate();
})();
