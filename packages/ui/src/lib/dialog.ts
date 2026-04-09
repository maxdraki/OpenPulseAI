/**
 * Confirmation dialog using Shoelace's <sl-dialog>.
 * Always use this instead of window.confirm() or custom modals.
 */
export function confirmDialog(message: string, onConfirm: () => void): void {
  const dialog = document.createElement("sl-dialog") as any;
  dialog.label = "Confirm";

  const msg = document.createElement("p");
  msg.textContent = message;
  msg.style.margin = "0";
  dialog.appendChild(msg);

  const cancelBtn = document.createElement("sl-button");
  cancelBtn.setAttribute("slot", "footer");
  cancelBtn.setAttribute("variant", "default");
  cancelBtn.textContent = "Cancel";

  const confirmBtn = document.createElement("sl-button");
  confirmBtn.setAttribute("slot", "footer");
  confirmBtn.setAttribute("variant", "danger");
  confirmBtn.textContent = "Confirm";

  cancelBtn.addEventListener("click", () => dialog.hide());
  confirmBtn.addEventListener("click", () => {
    dialog.hide();
    onConfirm();
  });
  dialog.addEventListener("sl-after-hide", () => dialog.remove());

  dialog.appendChild(cancelBtn);
  dialog.appendChild(confirmBtn);
  document.body.appendChild(dialog);
  dialog.show();
}
