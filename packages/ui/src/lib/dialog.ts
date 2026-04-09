/**
 * Confirmation dialog using our own styling (consistent with the rest of the app).
 * Always use this instead of window.confirm().
 */
export function confirmDialog(message: string, onConfirm: () => void): void {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";

  const box = document.createElement("div");
  box.className = "confirm-box";

  const msg = document.createElement("p");
  msg.textContent = message;

  const actions = document.createElement("div");
  actions.className = "confirm-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "btn btn-danger";
  confirmBtn.textContent = "Confirm";

  function close() { overlay.remove(); }

  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  confirmBtn.addEventListener("click", () => { close(); onConfirm(); });

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  box.appendChild(msg);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  confirmBtn.focus();
}
