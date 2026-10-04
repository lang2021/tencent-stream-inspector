(function installKeyboardLock() {
  const CONTROLLER_KEY = "__authorizedStreamInspectorKeyboardLock";
  const LEASE_MS = 12_000;
  const RENEW_INTERVAL_MS = 4_000;
  const blockedEvents = [
    "keydown", "keyup", "keypress", "beforeinput", "textInput",
    "compositionstart", "compositionupdate", "compositionend"
  ];

  const existing = globalThis[CONTROLLER_KEY];
  if (existing?.activate) {
    existing.activate();
    return;
  }

  let active = false;
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

  function clearTimers() {
    if (leaseTimer) clearTimeout(leaseTimer);
    if (renewTimer) clearInterval(renewTimer);
    leaseTimer = null;
    renewTimer = null;
  }

  function renewLease() {
    if (!active) return;
    if (leaseTimer) clearTimeout(leaseTimer);
    leaseTimer = setTimeout(() => controller.deactivate(), LEASE_MS);
  }

  const controller = {
    activate() {
      removeListeners();
      clearTimers();
      active = true;
      addListeners(window);
      addListeners(document);
      renewLease();
      renewTimer = setInterval(renewLease, RENEW_INTERVAL_MS);
      return { active: true };
    },

    deactivate() {
      active = false;
      removeListeners();
      clearTimers();
      delete globalThis[CONTROLLER_KEY];
      return { active: false };
    },

    isActive() {
      return active;
    }
  };

  globalThis[CONTROLLER_KEY] = controller;
  controller.activate();
})();
